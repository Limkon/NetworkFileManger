import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serveStatic } from 'hono/cloudflare-workers';
import manifest from '__STATIC_CONTENT_MANIFEST';

import Database from './database.js';
import ConfigManager from './config.js';
import * as data from './data.js';
import { initStorage } from './storage/index.js';
import { initCrypto, encrypt, decrypt } from './crypto.js';

const app = new Hono();

// =================================================================================
// 0. 全局错误处理
// =================================================================================
app.onError((err, c) => {
    console.error('❌ [FATAL] Server Error:', err);
    if (c.req.path.startsWith('/api') || c.req.header('accept')?.includes('json')) {
        return c.json({ success: false, message: `Server Error: ${err.message}` }, 500);
    }
    return c.text(`❌ 系统严重错误:\n${err.message}\n\nStack:\n${err.stack}`, 500);
});

// 404 处理 (可选，用于调试)
app.notFound((c) => {
    console.warn(`[404] Not Found: ${c.req.path}`);
    return c.text('404 Not Found - Path: ' + c.req.path, 404);
});

// =================================================================================
// 1. 静态资源服务 (顺序非常重要！)
// =================================================================================

// 1.1 优先处理特定页面路由 (SPA 模式)
// 访问 /view/任意ID 时，强制返回 manager.html
app.get('/view/*', serveStatic({ path: 'manager.html', manifest }));

// 1.2 其他独立页面
app.get('/login', serveStatic({ path: 'login.html', manifest }));
app.get('/register', serveStatic({ path: 'register.html', manifest }));
app.get('/admin', serveStatic({ path: 'admin.html', manifest }));
app.get('/editor', serveStatic({ path: 'editor.html', manifest }));

// 1.3 通用静态资源 (CSS, JS, Fonts, Images)
// 放在最后，作为兜底，处理如 /manager.js, /manager.css 等请求
app.use('/*', serveStatic({ root: './', manifest }));


// =================================================================================
// 2. 全局中间件：注入核心依赖
// =================================================================================
app.use('*', async (c, next) => {
    try {
        if (!c.env.DB) throw new Error("缺少 D1 数据库绑定 (DB)");
        if (!c.env.CONFIG_KV) throw new Error("缺少 KV 绑定 (CONFIG_KV)");
        if (!c.env.SESSION_SECRET) throw new Error("缺少环境变量 SESSION_SECRET");

        initCrypto(c.env.SESSION_SECRET);
        c.set('db', new Database(c.env.DB));
        c.set('configManager', new ConfigManager(c.env.CONFIG_KV));

        const config = await c.get('configManager').load();
        c.set('config', config);

        try {
            const storage = initStorage(config, c.env); 
            c.set('storage', storage);
        } catch (storageErr) {
            console.warn("⚠️ 存储初始化警告:", storageErr.message);
            c.set('storage', { 
                list: async () => [], 
                upload: async () => { throw new Error(`存储未配置: ${storageErr.message}`); },
                download: async () => { throw new Error(`存储未配置: ${storageErr.message}`); },
                remove: async () => { throw new Error(`存储未配置: ${storageErr.message}`); }
            });
        }
        await next();
    } catch (e) { throw e; }
});

// =================================================================================
// 3. 认证中间件
// =================================================================================
const authMiddleware = async (c, next) => {
    // 排除静态文件和公开页面
    // 注意：静态文件通常已被 serveStatic 处理并返回，不会走到这里。
    // 但为了安全和逻辑完整，保留排除列表。
    const publicPaths = ['/login', '/register', '/setup', '/api/public', '/share/', '/assets', '/favicon.ico'];
    
    // 如果是 .js, .css 等静态资源请求，且前面 serveStatic 没拦截到(理论上不应发生)，直接放行或404
    if (c.req.path.match(/\.(js|css|png|jpg|woff2?|svg)$/)) return await next();

    if (publicPaths.some(p => c.req.path.startsWith(p))) return await next();

    const token = getCookie(c, 'remember_me');
    if (!token) {
        if (c.req.path.startsWith('/api') || c.req.header('accept')?.includes('json')) {
            return c.json({ success: false, message: '未登录' }, 401);
        }
        return c.redirect('/login');
    }

    const user = await data.findAuthToken(c.get('db'), token);
    if (!user || user.expires_at < Date.now()) {
        if(user) await data.deleteAuthToken(c.get('db'), token);
        deleteCookie(c, 'remember_me');
        return c.redirect('/login');
    }

    c.set('user', { id: user.user_id, username: user.username, isAdmin: !!user.is_admin });
    await next();
};
app.use('*', authMiddleware);

const adminMiddleware = async (c, next) => {
    const user = c.get('user');
    if (!user || !user.isAdmin) return c.json({ success: false, message: '权限不足' }, 403);
    await next();
};

// =================================================================================
// 4. 上传接口 (带日志)
// =================================================================================
app.post('/upload', async (c) => {
    console.log("🚀 [Upload] 收到请求");
    const db = c.get('db'); 
    const storage = c.get('storage'); 
    const user = c.get('user');
    const config = c.get('config');

    try {
        const body = await c.req.parseBody(); 
        const folderIdRaw = c.req.query('folderId');
        const folderId = parseInt(decrypt(folderIdRaw));
        const conflictMode = c.req.query('conflictMode') || 'rename';
        
        console.log(`🔍 [Upload] folderId=${folderId}, conflict=${conflictMode}`);

        if (isNaN(folderId)) throw new Error(`无效的 Folder ID`);

        const files = [];
        Object.keys(body).forEach(key => {
            const val = body[key];
            if (val instanceof File) files.push(val);
            else if (Array.isArray(val)) val.forEach(v => { if (v instanceof File) files.push(v); });
        });

        if (files.length === 0) return c.json({ success: false, message: '未接收到文件' }, 400);

        const totalSize = files.reduce((acc, f) => acc + f.size, 0);
        if (!await data.checkQuota(db, user.id, totalSize)) return c.json({ success: false, message: '空间不足' }, 413);

        const results = [];
        for (const file of files) {
            console.log(`👉 [Upload] 处理: ${file.name}`);
            try {
                let finalName = file.name;
                let existingFile = null;

                if (conflictMode === 'overwrite') {
                    // 使用 SELECT * 确保拿到所有字段
                    existingFile = await db.get(
                        "SELECT * FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ? AND (is_deleted = 0 OR is_deleted IS NULL)", 
                        [file.name, folderId, user.id]
                    );
                } else {
                    finalName = await data.getUniqueName(db, folderId, file.name, user.id, 'file');
                }

                console.log(`   [Storage] 上传中... (${finalName})`);
                const uploadResult = await storage.upload(file, finalName, file.type, user.id, folderId, config);
                
                if (existingFile) {
                    console.log(`   [DB] 更新记录...`);
                    await data.updateFile(db, BigInt(existingFile.message_id), {
                        file_id: uploadResult.fileId,
                        size: file.size,
                        date: Date.now(),
                        mimetype: file.type,
                        thumb_file_id: uploadResult.thumbId || null
                    }, user.id);
                } else {
                    console.log(`   [DB] 插入记录...`);
                    const messageId = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
                    await data.addFile(db, {
                        message_id: messageId, 
                        fileName: finalName, 
                        mimetype: file.type, 
                        size: file.size,
                        file_id: uploadResult.fileId, 
                        thumb_file_id: uploadResult.thumbId || null, 
                        date: Date.now()
                    }, folderId, user.id, config.storageMode);
                }
                results.push({ name: finalName, success: true });
            } catch (innerErr) {
                console.error(`❌ [Upload] 文件失败:`, innerErr);
                results.push({ name: file.name, success: false, error: innerErr.message });
            }
        }
        return c.json({ success: true, results });

    } catch (err) {
        console.error("❌ [Upload] 全局异常:", err);
        return c.json({ success: false, message: err.message }, 500);
    }
});

// =================================================================================
// 5. 核心路由
// =================================================================================

app.get('/', async (c) => {
    const db = c.get('db'); const user = c.get('user');
    initCrypto(c.env.SESSION_SECRET);
    let root = await data.getRootFolder(db, user.id);
    if (!root) {
        await db.run("DELETE FROM folders WHERE user_id = ? AND parent_id IS NULL", [user.id]);
        await data.createFolder(db, '/', null, user.id);
        root = await data.getRootFolder(db, user.id);
    }
    return c.redirect(`/view/${encrypt(root.id)}`);
});
app.get('/fix-root', async (c) => c.redirect('/'));

app.get('/api/folder/:encryptedId', async (c) => {
    const db = c.get('db'); const user = c.get('user'); 
    const encId = c.req.param('encryptedId');
    console.log(`[Folder] 获取: ${encId}`);
    try {
        const id = parseInt(decrypt(encId));
        if (isNaN(id)) return c.json({success:false, message:'ID 无效'}, 400);
        const res = await data.getFolderContents(db, id, user.id);
        const pathArr = await data.getFolderPath(db, id, user.id);
        return c.json({ contents: res, path: pathArr });
    } catch (e) { 
        console.error(`[Folder] 失败:`, e);
        return c.json({ success: false, message: e.message }, 500); 
    }
});

app.get('/api/folders', async (c) => c.json(await data.getAllFolders(c.get('db'), c.get('user').id)));

app.get('/download/proxy/:messageId', async (c) => {
    const db = c.get('db'); const storage = c.get('storage'); const user = c.get('user');
    const files = await data.getFilesByIds(db, [BigInt(c.req.param('messageId'))], user.id);
    if (!files.length) return c.text('File not found', 404);
    const file = files[0];
    try {
        const { stream, contentType, headers } = await storage.download(file.file_id, user.id);
        const resHeaders = new Headers(headers);
        resHeaders.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
        resHeaders.set('Content-Type', file.mimetype || contentType || 'application/octet-stream');
        return new Response(stream, { headers: resHeaders });
    } catch (e) { return c.text(`Download Error: ${e.message}`, 500); }
});

// API Routes
app.get('/api/user/quota', async (c) => c.json(await data.getUserQuota(c.get('db'), c.get('user').id)));
app.post('/api/folder/create', async (c) => {
    const { name, parentId } = await c.req.json();
    await data.createFolder(c.get('db'), name, parentId ? parseInt(decrypt(parentId)) : null, c.get('user').id);
    return c.json({ success: true });
});
app.post('/api/delete', async (c) => {
    const { files, folders, permanent } = await c.req.json();
    const fileIds = (files||[]).map(BigInt); const folderIds = (folders||[]).map(parseInt);
    if (permanent) await data.unifiedDelete(c.get('db'), c.get('storage'), null, null, c.get('user').id, fileIds, folderIds);
    else await data.softDeleteItems(c.get('db'), fileIds, folderIds, c.get('user').id);
    return c.json({ success: true });
});
app.get('/api/trash', async (c) => c.json(await data.getTrashContents(c.get('db'), c.get('user').id)));
app.post('/api/trash/restore', async (c) => {
    const { files, folders } = await c.req.json();
    await data.restoreItems(c.get('db'), (files||[]).map(BigInt), (folders||[]).map(parseInt), c.get('user').id);
    return c.json({ success: true });
});
app.post('/api/trash/empty', async (c) => c.json(await data.emptyTrash(c.get('db'), c.get('storage'), c.get('user').id)));
app.post('/api/rename', async (c) => {
    const { type, id, name } = await c.req.json();
    if(type==='file') await data.renameFile(c.get('db'), c.get('storage'), BigInt(id), name, c.get('user').id);
    else await data.renameFolder(c.get('db'), c.get('storage'), parseInt(id), name, c.get('user').id);
    return c.json({ success: true });
});
app.post('/api/move', async (c) => {
    const { files, folders, targetFolderId, conflictMode } = await c.req.json();
    const tid = parseInt(decrypt(targetFolderId));
    if(!tid) return c.json({success:false},400);
    try {
        await data.moveItems(c.get('db'), c.get('storage'), (files||[]).map(BigInt), (folders||[]).map(parseInt), tid, c.get('user').id, conflictMode || 'rename');
        return c.json({ success: true });
    } catch(e) { return c.json({ success: false, message: e.message }, 500); }
});
app.get('/api/search', async (c) => c.json(await data.searchItems(c.get('db'), c.req.query('q'), c.get('user').id)));
app.get('/api/shares', async (c) => c.json(await data.getActiveShares(c.get('db'), c.get('user').id)));
app.post('/api/share/create', async (c) => {
    const { itemId, itemType, expiresIn, password, customExpiresAt } = await c.req.json();
    const res = await data.createShareLink(c.get('db'), itemId, itemType, expiresIn, c.get('user').id, password, customExpiresAt);
    return res.success ? c.json({success:true, link:`/share/view/${itemType}/${res.token}`}) : c.json(res, 500);
});
app.post('/api/share/cancel', async (c) => {
    const { itemId, itemType } = await c.req.json();
    await data.cancelShare(c.get('db'), itemId, itemType, c.get('user').id);
    return c.json({success:true});
});
app.post('/api/folder/lock', async (c) => {
    const { folderId, password } = await c.req.json();
    const bcrypt = await import('bcryptjs');
    await data.setFolderPassword(c.get('db'), parseInt(decrypt(folderId)), bcrypt.hashSync(password, 10), c.get('user').id);
    return c.json({success:true});
});

// 分享展示页
const SHARE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>分享的文件</title><link rel="stylesheet" href="/manager.css"><link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css"><style>.container{max-width:800px;margin:50px auto;padding:20px;background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1)}.locked-screen{text-align:center}.file-icon{font-size:64px;color:#007bff;margin-bottom:20px}.btn{display:inline-block;padding:10px 20px;background:#007bff;color:#fff;text-decoration:none;border-radius:5px;cursor:pointer;border:none}.list-item{display:flex;align-items:center;padding:10px;border-bottom:1px solid #eee}.list-item i{margin-right:10px;width:20px;text-align:center}.error-msg{color:red;margin-top:10px}</style></head><body><div class="container" id="app"><h2 style="text-align:center;">正在加載...</h2></div><script>const pathParts=window.location.pathname.split('/');const token=pathParts.pop();const app=document.getElementById('app');async function load(){try{const res=await fetch('/api/public/share/'+token);const data=await res.json();if(!res.ok)throw new Error(data.message||'加載失敗');if(data.isLocked&&!data.isUnlocked){renderPasswordForm(data.name)}else if(data.type==='file'){renderFile(data)}else{renderFolder(data)}}catch(e){app.innerHTML='<div style="text-align:center;color:red;"><h3>錯誤</h3><p>'+e.message+'</p></div>'}}function renderPasswordForm(name){app.innerHTML=\`<div class="locked-screen"><i class="fas fa-lock file-icon"></i><h3>\${name} 受密碼保護</h3><div style="margin:20px 0;"><input type="password" id="pass" placeholder="請輸入密碼" style="padding:10px; width:200px;"><button class="btn" onclick="submitPass()">解鎖</button></div><p id="err" class="error-msg"></p></div>\`}window.submitPass=async()=>{const pass=document.getElementById('pass').value;const res=await fetch('/api/public/share/'+token+'/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pass})});const d=await res.json();if(d.success)load();else document.getElementById('err').textContent=d.message};function renderFile(data){app.innerHTML=\`<div style="text-align:center;"><i class="fas fa-file file-icon"></i><h2>\${data.name}</h2><p>大小: \${(data.size/1024/1024).toFixed(2)} MB</p><p>時間: \${new Date(data.date).toLocaleString()}</p><div style="margin-top:30px;"><a href="\${data.downloadUrl}" class="btn"><i class="fas fa-download"></i> 下載文件</a></div></div>\`}function renderFolder(data){let html=\`<h3>\${data.name} (文件夾)</h3><div class="list">\`;if(data.folders)data.folders.forEach(f=>{html+=\`<div class="list-item"><i class="fas fa-folder" style="color:#fbc02d;"></i> <span>\${f.name}</span></div>\`});if(data.files)data.files.forEach(f=>{html+=\`<div class="list-item"><i class="fas fa-file" style="color:#555;"></i> <span>\${f.name}</span> <span style="margin-left:auto;font-size:12px;color:#999;">\${(f.size/1024).toFixed(1)} KB</span></div>\`});html+='</div>';app.innerHTML=html}load()</script></body></html>`;

app.get('/api/public/share/:token', async (c) => {
    const db = c.get('db'); const token = c.req.param('token');
    let item = await data.getFileByShareToken(db, token);
    let type = 'file';
    if (!item) { item = await data.getFolderByShareToken(db, token); type = 'folder'; }
    if (!item) return c.json({ success: false, message: '无效链接' }, 404);
    const isLocked = !!item.share_password;
    const isUnlocked = getCookie(c, `share_unlock_${token}`) === 'true';
    if (isLocked && !isUnlocked) return c.json({ success: true, type, isLocked: true, isUnlocked: false, name: type === 'file' ? item.fileName : item.name });
    if (type === 'file') {
        return c.json({ success: true, type: 'file', isLocked, isUnlocked: true, name: item.fileName, size: item.size, date: item.date, mimeType: item.mimetype, downloadUrl: `/share/download/${token}` });
    } else {
        const contents = await data.getFolderContents(db, item.id, item.user_id);
        const safeFolders = contents.folders.map(f => ({ name: f.name, size: 0, type: 'folder' }));
        const safeFiles = contents.files.map(f => ({ name: f.fileName, size: f.size, date: f.date, type: 'file', id: f.message_id }));
        return c.json({ success: true, type: 'folder', isLocked, isUnlocked: true, name: item.name, files: safeFiles, folders: safeFolders });
    }
});
app.post('/api/public/share/:token/auth', async (c) => {
    const db = c.get('db'); const token = c.req.param('token'); const { password } = await c.req.parseBody();
    let item = await data.getFileByShareToken(db, token);
    if (!item) item = await data.getFolderByShareToken(db, token);
    if (!item) return c.json({ success: false, message: '无效' }, 404);
    const bcrypt = await import('bcryptjs');
    if (item.share_password && bcrypt.compareSync(password, item.share_password)) {
        setCookie(c, `share_unlock_${token}`, 'true', { path: '/', maxAge: 86400, httpOnly: true, secure: true });
        return c.json({ success: true });
    }
    return c.json({ success: false, message: '密码错误' }, 401);
});
app.get('/share/download/:token', async (c) => {
    const db = c.get('db'); const storage = c.get('storage'); const token = c.req.param('token');
    const file = await data.getFileByShareToken(db, token);
    if (!file) return c.text('Not found', 404);
    if (file.share_password && getCookie(c, `share_unlock_${token}`) !== 'true') return c.text('Auth required', 403);
    try {
        const { stream, contentType, headers } = await storage.download(file.file_id, file.user_id);
        const resHeaders = new Headers(headers);
        resHeaders.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
        resHeaders.set('Content-Type', file.mimetype || contentType || 'application/octet-stream');
        return new Response(stream, { headers: resHeaders });
    } catch (e) { return c.text(`Download Error: ${e.message}`, 500); }
});
app.get('/share/view/:type/:token', (c) => c.html(SHARE_HTML));

// =================================================================================
// 6. Admin 路由
// =================================================================================
app.get('/api/admin/users', adminMiddleware, async (c) => {
    try { return c.json(await data.listAllUsers(c.get('db'))); } catch(e) { return c.json({success:false, message:e.message}, 500); }
});
app.get('/api/admin/users-with-quota', adminMiddleware, async (c) => c.json({users: await data.listAllUsersWithQuota(c.get('db'))}));
app.post('/api/admin/storage-mode', adminMiddleware, async (c) => {
    const body = await c.req.json();
    await c.get('configManager').save({ storageMode: body.mode });
    return c.json({success:true});
});
app.get('/api/admin/webdav', adminMiddleware, async(c) => {
    const config = await c.get('configManager').load();
    return c.json(config.webdav ? [config.webdav] : []);
});
app.post('/api/admin/webdav', adminMiddleware, async(c) => { 
    const webdavConfig = await c.req.json();
    await c.get('configManager').save({webdav: webdavConfig}); 
    return c.json({success:true}); 
});
app.get('/api/admin/s3', adminMiddleware, async(c) => {
    const config = await c.get('configManager').load();
    return c.json({s3: config.s3});
});
app.post('/api/admin/s3', adminMiddleware, async(c) => { 
    const s3Config = await c.req.json();
    await c.get('configManager').save({s3: s3Config}); 
    return c.json({success:true}); 
});
app.post('/api/admin/scan', adminMiddleware, async (c) => {
    const { userId } = await c.req.json();
    const stream = new ReadableStream({
        async start(controller) { await data.scanStorageAndImport(c.get('db'), c.get('storage'), userId, controller); controller.close(); }
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
});
app.post('/api/admin/add-user', adminMiddleware, async (c) => {
    const { username, password } = await c.req.json();
    const bcrypt = await import('bcryptjs');
    await data.createUser(c.get('db'), username, bcrypt.hashSync(password, 10));
    return c.json({success:true});
});
app.post('/api/admin/change-password', adminMiddleware, async (c) => {
    const { userId, newPassword } = await c.req.json();
    const bcrypt = await import('bcryptjs');
    await data.changeUserPassword(c.get('db'), userId, bcrypt.hashSync(newPassword, 10));
    return c.json({success:true});
});
app.post('/api/admin/delete-user', adminMiddleware, async (c) => {
    await data.deleteUser(c.get('db'), (await c.req.json()).userId);
    return c.json({success:true});
});
app.post('/api/admin/set-quota', adminMiddleware, async (c) => {
    const { userId, maxBytes } = await c.req.json();
    await data.setMaxStorageForUser(c.get('db'), userId, maxBytes);
    return c.json({success:true});
});

export default app;
