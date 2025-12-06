// src/worker.js
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

// ... (错误处理和静态资源路由保持不变) ...
app.onError((err, c) => {
    console.error('❌ [FATAL] Server Error:', err);
    if (c.req.path.startsWith('/api') || c.req.header('accept')?.includes('json')) {
        return c.json({ success: false, message: `Server Error: ${err.message}` }, 500);
    }
    return c.text(`❌ 系统严重错误 (500):\n\n${err.message}\n\nStack:\n${err.stack}`, 500);
});

app.get('/login', serveStatic({ path: 'login.html', manifest }));
app.get('/register', serveStatic({ path: 'register.html', manifest }));
app.get('/admin', serveStatic({ path: 'admin.html', manifest }));
app.get('/editor', serveStatic({ path: 'editor.html', manifest }));
app.get('/view/*', serveStatic({ path: 'manager.html', manifest }));

const SHARE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>分享的文件</title><link rel="stylesheet" href="/manager.css"><link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css"><style>.container{max-width:800px;margin:50px auto;padding:20px;background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1)}.locked-screen{text-align:center}.file-icon{font-size:64px;color:#007bff;margin-bottom:20px}.btn{display:inline-block;padding:10px 20px;background:#007bff;color:#fff;text-decoration:none;border-radius:5px;cursor:pointer;border:none}.list-item{display:flex;align-items:center;padding:10px;border-bottom:1px solid #eee}.list-item i{margin-right:10px;width:20px;text-align:center}.error-msg{color:red;margin-top:10px}</style></head><body><div class="container" id="app"><h2 style="text-align:center;">正在加載...</h2></div><script>const pathParts=window.location.pathname.split('/');const token=pathParts.pop();const app=document.getElementById('app');async function load(){try{const res=await fetch('/api/public/share/'+token);const data=await res.json();if(!res.ok)throw new Error(data.message||'加載失敗');if(data.isLocked&&!data.isUnlocked){renderPasswordForm(data.name)}else if(data.type==='file'){renderFile(data)}else{renderFolder(data)}}catch(e){app.innerHTML='<div style="text-align:center;color:red;"><h3>錯誤</h3><p>'+e.message+'</p></div>'}}function renderPasswordForm(name){app.innerHTML=\`<div class="locked-screen"><i class="fas fa-lock file-icon"></i><h3>\${name} 受密碼保護</h3><div style="margin:20px 0;"><input type="password" id="pass" placeholder="請輸入密碼" style="padding:10px; width:200px;"><button class="btn" onclick="submitPass()">解鎖</button></div><p id="err" class="error-msg"></p></div>\`}window.submitPass=async()=>{const pass=document.getElementById('pass').value;const res=await fetch('/api/public/share/'+token+'/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pass})});const d=await res.json();if(d.success)load();else document.getElementById('err').textContent=d.message};function renderFile(data){app.innerHTML=\`<div style="text-align:center;"><i class="fas fa-file file-icon"></i><h2>\${data.name}</h2><p>大小: \${(data.size/1024/1024).toFixed(2)} MB</p><p>時間: \${new Date(data.date).toLocaleString()}</p><div style="margin-top:30px;"><a href="\${data.downloadUrl}" class="btn"><i class="fas fa-download"></i> 下載文件</a></div></div>\`}function renderFolder(data){let html=\`<h3>\${data.name} (文件夾)</h3><div class="list">\`;if(data.folders)data.folders.forEach(f=>{html+=\`<div class="list-item"><i class="fas fa-folder" style="color:#fbc02d;"></i> <span>\${f.name}</span></div>\`});if(data.files)data.files.forEach(f=>{html+=\`<div class="list-item"><i class="fas fa-file" style="color:#555;"></i> <span>\${f.name}</span> <span style="margin-left:auto;font-size:12px;color:#999;">\${(f.size/1024).toFixed(1)} KB</span></div>\`});html+='</div>';app.innerHTML=html}load()</script></body></html>`;
app.get('/share/view/:type/:token', (c) => c.html(SHARE_HTML));

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
                upload: async () => { throw new Error(`存储配置错误: ${storageErr.message}`); },
                download: async () => { throw new Error(`存储配置错误: ${storageErr.message}`); },
                remove: async () => { throw new Error(`存储配置错误: ${storageErr.message}`); }
            });
        }
        await next();
    } catch (e) { throw e; }
});

const authMiddleware = async (c, next) => {
    const url = new URL(c.req.url);
    const path = url.pathname;
    if (path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?|ttf|eot)$/)) return await next();
    const publicPaths = ['/login', '/register', '/setup', '/api/public', '/share'];
    if (publicPaths.some(p => path.startsWith(p))) return await next();

    const token = getCookie(c, 'remember_me');
    if (!token) {
        if (path.startsWith('/api')) return c.json({ success: false, message: '未登录' }, 401);
        return c.redirect('/login');
    }

    const user = await data.findAuthToken(c.get('db'), token);
    if (!user || user.expires_at < Date.now()) {
        if(user) await data.deleteAuthToken(c.get('db'), token);
        deleteCookie(c, 'remember_me');
        if (path.startsWith('/api')) return c.json({ success: false, message: '会话已过期' }, 401);
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

// ... (Setup, Login, Register 路由保持不变) ...
app.get('/setup', async (c) => {
    try {
        await c.get('db').initDB();
        let admin = await data.findUserByName(c.get('db'), 'admin');
        if (!admin) {
            const bcrypt = await import('bcryptjs');
            const hash = bcrypt.hashSync('admin', 10);
            const newUser = await data.createUser(c.get('db'), 'admin', hash);
            await data.createFolder(c.get('db'), '/', null, newUser.id);
            await c.get('db').run("UPDATE users SET is_admin = 1 WHERE id = ?", [newUser.id]);
            return c.text("✅ 初始化成功: 账号 admin / 密码 admin (请尽快修改)");
        } 
        await c.get('db').run("UPDATE users SET is_admin = 1 WHERE username = 'admin'");
        return c.text("✅ 系统已就绪，Admin 权限已修复。");
    } catch (e) { return c.text("初始化失败: " + e.message, 500); }
});

app.post('/login', async (c) => {
    const { username, password } = await c.req.parseBody();
    const user = await data.findUserByName(c.get('db'), username);
    const bcrypt = await import('bcryptjs');
    if (user && bcrypt.compareSync(password, user.password)) {
        const token = crypto.randomUUID().replace(/-/g, '');
        await data.createAuthToken(c.get('db'), user.id, token, Date.now() + 2592000000);
        setCookie(c, 'remember_me', token, { httpOnly: true, secure: true, maxAge: 2592000, path: '/' });
        return c.redirect('/');
    }
    return c.text('账号或密码错误', 401);
});

app.post('/register', async (c) => {
    const { username, password } = await c.req.parseBody();
    const db = c.get('db');
    if (await data.findUserByName(db, username)) return c.text('用户已存在', 400);
    const bcrypt = await import('bcryptjs');
    try {
        const user = await data.createUser(db, username, bcrypt.hashSync(password, 10));
        await data.createFolder(db, '/', null, user.id);
        return c.redirect('/login?registered=true');
    } catch (e) { return c.text('注册失败: ' + e.message, 500); }
});

app.get('/logout', async (c) => {
    const token = getCookie(c, 'remember_me');
    if (token) await data.deleteAuthToken(c.get('db'), token);
    deleteCookie(c, 'remember_me');
    return c.redirect('/login');
});

app.get('/', async (c) => {
    const db = c.get('db'); const user = c.get('user');
    let root = await data.getRootFolder(db, user.id);
    if (!root) {
        await db.run("DELETE FROM folders WHERE user_id = ? AND parent_id IS NULL", [user.id]);
        await data.createFolder(db, '/', null, user.id);
        root = await data.getRootFolder(db, user.id);
    }
    return c.redirect(`/view/${encrypt(root.id)}`);
});
app.get('/fix-root', async (c) => c.redirect('/'));

// ... (文件操作 API 保持不变) ...
app.get('/api/folder/:encryptedId', async (c) => {
    try {
        const id = parseInt(decrypt(c.req.param('encryptedId')));
        if (isNaN(id)) return c.json({ success: false }, 400);
        const res = await data.getFolderContents(c.get('db'), id, c.get('user').id);
        const path = await data.getFolderPath(c.get('db'), id, c.get('user').id);
        return c.json({ contents: res, path });
    } catch (e) { return c.json({ success: false, message: e.message }, 500); }
});
app.get('/api/folders', async (c) => c.json(await data.getAllFolders(c.get('db'), c.get('user').id)));
app.post('/upload', async (c) => {
    console.log("🚀 [Upload] 收到上传请求");
    const db = c.get('db'); 
    const storage = c.get('storage'); 
    const user = c.get('user');
    const config = c.get('config');

    try {
        const body = await c.req.parseBody();
        const folderId = parseInt(decrypt(c.req.query('folderId')));
        const conflictMode = c.req.query('conflictMode') || 'rename';

        if (isNaN(folderId)) throw new Error('Invalid Folder ID');

        const files = [];
        Object.keys(body).forEach(k => {
            const v = body[k];
            if (v instanceof File) files.push(v);
            else if (Array.isArray(v)) v.forEach(f => { if(f instanceof File) files.push(f); });
        });

        if(!files.length) return c.json({success:false, message:'未接收到文件'}, 400);
        
        const totalSize = files.reduce((a,b)=>a+b.size, 0);
        if(!await data.checkQuota(db, user.id, totalSize)) return c.json({success:false, message:'空间不足'}, 413);

        const results = [];
        for(const file of files) {
            console.log(`👉 处理文件: ${file.name}`);
            try {
                let finalName = file.name;
                let existing = null;
                
                if(conflictMode === 'overwrite') {
                    existing = await db.get("SELECT * FROM files WHERE fileName=? AND folder_id=? AND user_id=? AND (is_deleted=0 OR is_deleted IS NULL)", [file.name, folderId, user.id]);
                } else {
                    finalName = await data.getUniqueName(db, folderId, file.name, user.id, 'file');
                }

                console.log(`   [Storage] 上传至: ${finalName}`);
                const up = await storage.upload(file, finalName, file.type, user.id, folderId, config);
                
                if(existing) {
                    console.log(`   [DB] 更新记录 ID: ${existing.message_id}`);
                    await data.updateFile(db, BigInt(existing.message_id), {
                        file_id: up.fileId, size: file.size, date: Date.now(), mimetype: file.type, thumb_file_id: up.thumbId || null
                    }, user.id);
                } else {
                    const mid = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random()*1000));
                    console.log(`   [DB] 插入新记录 ID: ${mid}`);
                    await data.addFile(db, {
                        message_id: mid, fileName: finalName, mimetype: file.type, size: file.size,
                        file_id: up.fileId, thumb_file_id: up.thumbId || null, date: Date.now()
                    }, folderId, user.id, config.storageMode);
                }
                results.push({name: finalName, success: true});
            } catch(e) {
                console.error("❌ 单个文件处理失败:", e);
                results.push({name: file.name, success: false, error: e.message});
            }
        }
        return c.json({success:true, results});
    } catch(e) {
        console.error("❌ 上传接口致命错误:", e);
        return c.json({success:false, message:e.message}, 500);
    }
});
app.get('/download/proxy/:messageId', async (c) => {
    const user = c.get('user');
    const files = await data.getFilesByIds(c.get('db'), [BigInt(c.req.param('messageId'))], user.id);
    if (!files.length) return c.text('File Not Found', 404);
    try {
        const { stream, contentType, headers } = await c.get('storage').download(files[0].file_id, user.id);
        const h = new Headers(headers);
        h.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(files[0].fileName)}`);
        h.set('Content-Type', files[0].mimetype || contentType || 'application/octet-stream');
        return new Response(stream, { headers: h });
    } catch(e) { return c.text(e.message, 500); }
});
app.post('/api/move', async (c) => {
    const { files, folders, targetFolderId, conflictMode } = await c.req.json();
    const tid = parseInt(decrypt(targetFolderId));
    if(!tid) return c.json({success:false},400);
    try {
        await data.moveItems(c.get('db'), c.get('storage'), (files||[]).map(BigInt), (folders||[]).map(parseInt), tid, c.get('user').id, conflictMode);
        return c.json({success:true});
    } catch(e) { return c.json({success:false, message:e.message}, 500); }
});
app.get('/api/user/quota', async (c) => c.json(await data.getUserQuota(c.get('db'), c.get('user').id)));
app.post('/api/folder/create', async (c) => {
    const { name, parentId } = await c.req.json();
    await data.createFolder(c.get('db'), name, parentId ? parseInt(decrypt(parentId)) : null, c.get('user').id);
    return c.json({ success: true });
});
app.post('/api/delete', async (c) => {
    const { files, folders, permanent } = await c.req.json();
    const fIds = (files||[]).map(BigInt); const dIds = (folders||[]).map(parseInt);
    if(permanent) await data.unifiedDelete(c.get('db'), c.get('storage'), null, null, c.get('user').id, fIds, dIds);
    else await data.softDeleteItems(c.get('db'), fIds, dIds, c.get('user').id);
    return c.json({success:true});
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
    return c.json({success:true});
});
app.get('/api/search', async (c) => c.json(await data.searchItems(c.get('db'), c.req.query('q'), c.get('user').id)));
app.get('/api/shares', async (c) => c.json(await data.getActiveShares(c.get('db'), c.get('user').id)));
app.post('/api/share/create', async (c) => {
    const body = await c.req.json();
    const res = await data.createShareLink(c.get('db'), body.itemId, body.itemType, body.expiresIn, c.get('user').id, body.password, body.customExpiresAt);
    return res.success ? c.json({success:true, link:`/share/view/${body.itemType}/${res.token}`}) : c.json(res, 500);
});
app.post('/api/share/cancel', async (c) => {
    const body = await c.req.json();
    await data.cancelShare(c.get('db'), body.itemId, body.itemType, c.get('user').id);
    return c.json({success:true});
});
app.post('/api/folder/lock', async (c) => {
    const body = await c.req.json();
    const bcrypt = await import('bcryptjs');
    await data.setFolderPassword(c.get('db'), parseInt(decrypt(body.folderId)), bcrypt.hashSync(body.password, 10), c.get('user').id);
    return c.json({success:true});
});

// =================================================================================
// 7. 管理员 API (Admin Routes)
// =================================================================================

app.get('/api/admin/users', adminMiddleware, async (c) => {
    try { 
        const users = await data.listAllUsers(c.get('db')); 
        return c.json(users);
    } catch(e) { 
        return c.json({success:false, message:e.message}, 500); 
    }
});

app.get('/api/admin/users-with-quota', adminMiddleware, async (c) => {
    try {
        const users = await data.listAllUsersWithQuota(c.get('db'));
        return c.json({users});
    } catch(e) {
        return c.json({success:false, message:e.message}, 500);
    }
});

// 新增接口：获取当前存储模式
app.get('/api/admin/storage-mode', adminMiddleware, async (c) => {
    const config = c.get('config');
    return c.json({ mode: config.storageMode });
});

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
    let webdavConfig = await c.req.json();
    if (Array.isArray(webdavConfig)) {
        webdavConfig = webdavConfig[0] || {};
    }
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
        async start(controller) { 
            await data.scanStorageAndImport(c.get('db'), c.get('storage'), userId, controller); 
            controller.close(); 
        }
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

app.use('/*', serveStatic({ root: './', manifest }));

export default app;
