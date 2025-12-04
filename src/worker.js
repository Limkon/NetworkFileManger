import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serveStatic } from 'hono/cloudflare-workers';
// 必须导入 manifest，这是 Wrangler 在构建时生成的资源清单
import manifest from '__STATIC_CONTENT_MANIFEST';

import Database from './database.js';
import ConfigManager from './config.js';
import * as data from './data.js';
import { initStorage } from './storage/index.js';
import { initCrypto, encrypt, decrypt } from './crypto.js';

const app = new Hono();

// =================================================================================
// 0. 静态资源服务 (优先处理)
// =================================================================================

// 1. 通用静态资源 (CSS, JS, Fonts, Images)
// 将此中间件放在最前面，确保静态文件 (如 manager.css) 不需要登录就能访问
app.use('/*', serveStatic({ root: './', manifest }));

// 2. 特定页面路由重写
// 当用户访问 /login 时，返回 login.html 的内容
app.get('/login', serveStatic({ path: 'login.html', manifest }));
app.get('/register', serveStatic({ path: 'register.html', manifest }));

// 当用户访问 /view/xxx 时，返回 manager.html (前端路由)
app.get('/view/*', serveStatic({ path: 'manager.html', manifest }));


// =================================================================================
// 1. 全局中间件：注入 DB, Config, Storage, Crypto
// =================================================================================
app.use('*', async (c, next) => {
    // 0. 初始化环境变量中的加密密钥
    initCrypto(c.env.SESSION_SECRET);

    // 1. 初始化 DB
    const db = new Database(c.env.DB);
    c.set('db', db);

    // 2. 初始化 Config
    const configManager = new ConfigManager(c.env.CONFIG_KV);
    c.set('configManager', configManager);

    // 3. 预加载配置
    const config = await configManager.load();
    c.set('config', config);

    // 4. 初始化存储后端
    const storage = initStorage(config, c.env); 
    c.set('storage', storage);

    await next();
});

// =================================================================================
// 2. 认证中间件
// =================================================================================
const authMiddleware = async (c, next) => {
    // 排除公开路由
    const publicPaths = [
        '/login', 
        '/register', 
        '/setup', 
        '/api/public', 
        '/share/view', 
        '/share/download', 
        '/assets',     
        '/favicon.ico'
    ];
    
    // 如果请求路径以 publicPaths 开头，放行
    if (publicPaths.some(path => c.req.path.startsWith(path))) {
        return await next();
    }

    const token = getCookie(c, 'remember_me');
    if (!token) {
        if (c.req.path.startsWith('/api') || c.req.header('accept')?.includes('json')) {
            return c.json({ success: false, message: '未登录' }, 401);
        }
        return c.redirect('/login');
    }

    const db = c.get('db');
    const tokenData = await data.findAuthToken(db, token);

    if (!tokenData || tokenData.expires_at < Date.now()) {
        if (tokenData) await data.deleteAuthToken(db, token);
        deleteCookie(c, 'remember_me');
        if (c.req.path.startsWith('/api') || c.req.header('accept')?.includes('json')) {
            return c.json({ success: false, message: '会话已过期' }, 401);
        }
        return c.redirect('/login');
    }

    c.set('user', { 
        id: tokenData.user_id, 
        username: tokenData.username, 
        isAdmin: !!tokenData.is_admin 
    });
    
    await next();
};

const adminMiddleware = async (c, next) => {
    const user = c.get('user');
    if (!user || !user.isAdmin) {
        return c.json({ success: false, message: '权限不足' }, 403);
    }
    await next();
};

app.use('*', authMiddleware);

// =================================================================================
// 3. 核心路由：系统初始化与认证
// =================================================================================

// 系统初始化
app.get('/setup', async (c) => {
    const db = c.get('db');
    try {
        await db.initDB();
        
        const admin = await data.findUserByName(db, 'admin');
        if (!admin) {
            const bcrypt = await import('bcryptjs');
            const salt = bcrypt.genSaltSync(10);
            const hash = bcrypt.hashSync('admin', salt);
            
            const newUser = await data.createUser(db, 'admin', hash);
            await db.run("UPDATE users SET is_admin = 1 WHERE id = ?", [newUser.id]);
            await data.createFolder(db, '/', null, newUser.id);
            
            return c.text("✅ 初始化成功: 预设管理员 admin / admin");
        }
        return c.text("✅ 数据库结构已就绪");
    } catch (e) {
        return c.text(`❌ 初始化失败: ${e.message}`, 500);
    }
});

// 登录处理
app.post('/login', async (c) => {
    const { username, password } = await c.req.parseBody();
    const db = c.get('db');
    
    const user = await data.findUserByName(db, username);
    const bcrypt = await import('bcryptjs');
    
    if (user && bcrypt.compareSync(password, user.password)) {
        const array = new Uint8Array(32);
        crypto.getRandomValues(array);
        const token = Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
        
        const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
        await data.createAuthToken(db, user.id, token, expiresAt);
        
        setCookie(c, 'remember_me', token, {
            httpOnly: true,
            secure: true,
            maxAge: 30 * 24 * 60 * 60,
            path: '/'
        });
        
        return c.redirect('/');
    } else {
        return c.text('账号或密码错误', 401);
    }
});

// 注册处理
app.post('/register', async (c) => {
    const { username, password } = await c.req.parseBody();
    if (!username || !password) return c.text('用户名和密码不能为空', 400);
    
    const db = c.get('db');
    if (await data.findUserByName(db, username)) return c.text('用户名已存在', 400);
    
    const bcrypt = await import('bcryptjs');
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(password, salt);
    
    try {
        const newUser = await data.createUser(db, username, hash);
        await data.createFolder(db, '/', null, newUser.id);
        return c.redirect('/login?registered=true');
    } catch (e) {
        return c.text('注册失败: ' + e.message, 500);
    }
});

// 登出
app.get('/logout', async (c) => {
    const token = getCookie(c, 'remember_me');
    if (token) {
        const db = c.get('db');
        await data.deleteAuthToken(db, token);
    }
    deleteCookie(c, 'remember_me');
    return c.redirect('/login');
});

// =================================================================================
// 4. 分享功能路由
// =================================================================================

// 分享页面 HTML Shell (用于 KV 中可能不存在的动态渲染页面，或者作为 fallback)
const SHARE_HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>分享的文件</title>
    <link rel="stylesheet" href="/manager.css">
    <link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css">
    <style>
        .container { max-width: 800px; margin: 50px auto; padding: 20px; background: #fff; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .locked-screen { text-align: center; }
        .file-icon { font-size: 64px; color: #007bff; margin-bottom: 20px; }
        .btn { display: inline-block; padding: 10px 20px; background: #007bff; color: #fff; text-decoration: none; border-radius: 5px; cursor: pointer; border: none;}
        .list-item { display: flex; align-items: center; padding: 10px; border-bottom: 1px solid #eee; }
        .list-item i { margin-right: 10px; width: 20px; text-align: center;}
        .error-msg { color: red; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="container" id="app"><h2 style="text-align:center;">正在加载...</h2></div>
    <script src="/shares.js"></script>
    <script>
        const pathParts = window.location.pathname.split('/');
        const token = pathParts.pop();
        const app = document.getElementById('app');

        async function load() {
            try {
                const res = await fetch('/api/public/share/' + token);
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || '加载失败');

                if (data.isLocked && !data.isUnlocked) {
                    renderPasswordForm(data.name);
                } else if (data.type === 'file') {
                    renderFile(data);
                } else {
                    renderFolder(data);
                }
            } catch (e) {
                app.innerHTML = '<div style="text-align:center;color:red;"><h3>错误</h3><p>' + e.message + '</p></div>';
            }
        }
        function renderPasswordForm(name) {
            app.innerHTML = \`<div class="locked-screen"><i class="fas fa-lock file-icon"></i><h3>\${name} 受密码保护</h3><div style="margin:20px 0;"><input type="password" id="pass" placeholder="请输入密码" style="padding:10px; width:200px;"><button class="btn" onclick="submitPass()">解锁</button></div><p id="err" class="error-msg"></p></div>\`;
        }
        window.submitPass = async () => {
            const pass = document.getElementById('pass').value;
            const res = await fetch('/api/public/share/' + token + '/auth', {
                method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ password: pass })
            });
            const d = await res.json();
            if (d.success) load(); else document.getElementById('err').textContent = d.message;
        };
        function renderFile(data) {
            app.innerHTML = \`<div style="text-align:center;"><i class="fas fa-file file-icon"></i><h2>\${data.name}</h2><p>大小: \${(data.size/1024/1024).toFixed(2)} MB</p><p>时间: \${new Date(data.date).toLocaleString()}</p><div style="margin-top:30px;"><a href="\${data.downloadUrl}" class="btn"><i class="fas fa-download"></i> 下载文件</a></div></div>\`;
        }
        function renderFolder(data) {
            let html = \`<h3>\${data.name} (文件夹)</h3><div class="list">\`;
            if(data.folders) data.folders.forEach(f => { html += \`<div class="list-item"><i class="fas fa-folder" style="color:#fbc02d;"></i> <span>\${f.name}</span></div>\`; });
            if(data.files) data.files.forEach(f => { html += \`<div class="list-item"><i class="fas fa-file" style="color:#555;"></i> <span>\${f.name}</span> <span style="margin-left:auto;font-size:12px;color:#999;">\${(f.size/1024).toFixed(1)} KB</span></div>\`; });
            html += '</div>'; app.innerHTML = html;
        }
        load();
    </script>
</body>
</html>
`;

app.get('/api/public/share/:token', async (c) => {
    const db = c.get('db');
    const token = c.req.param('token');
    
    let item = await data.getFileByShareToken(db, token);
    let type = 'file';
    
    if (!item) {
        item = await data.getFolderByShareToken(db, token);
        type = 'folder';
    }

    if (!item) return c.json({ success: false, message: '分享链接无效或已过期' }, 404);

    const isLocked = !!item.share_password;
    const unlockCookie = getCookie(c, `share_unlock_${token}`);
    const isUnlocked = unlockCookie === 'true';

    if (isLocked && !isUnlocked) {
        return c.json({ success: true, type, isLocked: true, isUnlocked: false, name: type === 'file' ? item.fileName : item.name });
    }

    if (type === 'file') {
        return c.json({
            success: true, type: 'file', isLocked, isUnlocked: true,
            name: item.fileName, size: item.size, date: item.date, mimeType: item.mimetype,
            downloadUrl: `/share/download/${token}`
        });
    } else {
        const contents = await data.getFolderContents(db, item.id, item.user_id);
        const safeFolders = contents.folders.map(f => ({ name: f.name, size: 0, type: 'folder' }));
        const safeFiles = contents.files.map(f => ({ name: f.fileName, size: f.size, date: f.date, type: 'file', id: f.message_id }));
        return c.json({
            success: true, type: 'folder', isLocked, isUnlocked: true,
            name: item.name, files: safeFiles, folders: safeFolders
        });
    }
});

app.post('/api/public/share/:token/auth', async (c) => {
    const db = c.get('db'); const token = c.req.param('token'); const { password } = await c.req.parseBody();
    let item = await data.getFileByShareToken(db, token);
    if (!item) item = await data.getFolderByShareToken(db, token);
    if (!item) return c.json({ success: false, message: '无效链接' }, 404);

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
    if (!file) return c.text('File not found', 404);
    if (file.share_password) {
         const unlockCookie = getCookie(c, `share_unlock_${token}`);
         if (unlockCookie !== 'true') return c.text('Password required', 403);
    }
    try {
        const { stream, contentType, headers } = await storage.download(file.file_id, file.user_id);
        const responseHeaders = new Headers(headers);
        responseHeaders.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
        responseHeaders.set('Content-Type', file.mimetype || contentType || 'application/octet-stream');
        return new Response(stream, { headers: responseHeaders });
    } catch (e) { return c.text('Download failed', 500); }
});

app.get('/share/view/:type/:token', (c) => c.html(SHARE_HTML));


// =================================================================================
// 5. 核心业务路由
// =================================================================================

app.get('/', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    let root = await data.getRootFolder(db, user.id);
    if (!root) {
        const res = await data.createFolder(db, '/', null, user.id);
        root = { id: res.id };
    }
    return c.redirect(`/view/${encrypt(root.id)}`);
});

// 获取文件夹内容
app.get('/api/folder/:encryptedId', async (c) => {
    const db = c.get('db'); const user = c.get('user'); const encId = c.req.param('encryptedId');
    const folderIdStr = decrypt(encId);
    if (!folderIdStr) return c.json({ success: false, message: '无效 ID' }, 400);
    const folderId = parseInt(folderIdStr);
    try {
        const result = await data.getFolderContents(db, folderId, user.id);
        const pathArr = await data.getFolderPath(db, folderId, user.id);
        return c.json({ contents: result, path: pathArr });
    } catch (e) { return c.json({ success: false, message: e.message }, 500); }
});

// 获取所有文件夹
app.get('/api/folders', async (c) => {
    try { return c.json(await data.getAllFolders(c.get('db'), c.get('user').id)); } catch (e) { return c.json({ success: false, message: e.message }, 500); }
});

// 文件上传
app.post('/upload', async (c) => {
    const db = c.get('db'); const storage = c.get('storage'); const user = c.get('user'); const config = c.get('config');
    const body = await c.req.parseBody(); 
    const folderId = parseInt(decrypt(c.req.query('folderId')));
    if (isNaN(folderId)) return c.json({ success: false, message: '缺少或无效的 folderId' }, 400);

    const files = [];
    Object.keys(body).forEach(key => {
        const value = body[key];
        if (value instanceof File) files.push(value);
        else if (Array.isArray(value)) value.forEach(v => { if (v instanceof File) files.push(v); });
    });
    if (files.length === 0) return c.json({ success: false, message: '没有检测到文件' }, 400);

    const totalSize = files.reduce((acc, f) => acc + f.size, 0);
    if (!await data.checkQuota(db, user.id, totalSize)) return c.json({ success: false, message: '空间不足' }, 413);

    const results = [];
    for (const file of files) {
        try {
            const messageId = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
            const uploadResult = await storage.upload(file, file.name, file.type, user.id, folderId, config);
            await data.addFile(db, {
                message_id: messageId, fileName: file.name, mimetype: file.type, size: file.size,
                file_id: uploadResult.fileId, thumb_file_id: uploadResult.thumbId || null, date: Date.now()
            }, folderId, user.id, config.storageMode);
            results.push({ name: file.name, success: true });
        } catch (e) { results.push({ name: file.name, success: false, error: e.message }); }
    }
    return c.json({ success: true, results });
});

app.get('/download/proxy/:messageId', async (c) => {
    const db = c.get('db'); const storage = c.get('storage'); const user = c.get('user'); const msgId = c.req.param('messageId');
    const files = await data.getFilesByIds(db, [BigInt(msgId)], user.id);
    const fileInfo = files[0];
    if (!fileInfo) return c.text('File not found', 404);
    try {
        const { stream, contentType, headers } = await storage.download(fileInfo.file_id, user.id);
        const responseHeaders = new Headers(headers);
        responseHeaders.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileInfo.fileName)}`);
        responseHeaders.set('Content-Type', fileInfo.mimetype || contentType || 'application/octet-stream');
        return new Response(stream, { headers: responseHeaders });
    } catch (e) { return c.text(`Download failed: ${e.message}`, 500); }
});

// =================================================================================
// 6. 其他 API
// =================================================================================
app.get('/api/user/quota', async (c) => c.json(await data.getUserQuota(c.get('db'), c.get('user').id)));
app.post('/api/folder/create', async (c) => {
    const { name, parentId } = await c.req.json();
    await data.createFolder(c.get('db'), name, parentId ? parseInt(decrypt(parentId)) : null, c.get('user').id);
    return c.json({ success: true });
});
app.post('/api/delete', async (c) => {
    const { files, folders, permanent } = await c.req.json();
    const fileIds = (files || []).map(BigInt); const folderIds = (folders || []).map(parseInt);
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
    const { files, folders, targetFolderId } = await c.req.json();
    const tid = parseInt(decrypt(targetFolderId));
    if(!tid) return c.json({success:false},400);
    await data.moveItems(c.get('db'), c.get('storage'), (files||[]).map(BigInt), (folders||[]).map(parseInt), tid, c.get('user').id);
    return c.json({ success: true });
});
app.get('/api/search', async (c) => c.json(await data.searchItems(c.get('db'), c.req.query('q'), c.get('user').id)));
app.post('/api/file/save', async (c) => {
    const { id, content } = await c.req.json();
    const f = (await data.getFilesByIds(c.get('db'), [BigInt(id)], c.get('user').id))[0];
    if(!f) return c.json({success:false},404);
    const blob = new Blob([content], {type:'text/plain'});
    const up = await c.get('storage').upload(new File([blob],f.fileName), f.fileName, 'text/plain', c.get('user').id, f.folder_id, c.get('config'));
    await data.updateFile(c.get('db'), BigInt(id), { file_id: up.fileId, size: blob.size, date: Date.now() }, c.get('user').id);
    return c.json({success:true});
});
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

// Admin
app.get('/api/admin/users', adminMiddleware, async (c) => c.json(await data.listAllUsers(c.get('db'))));
app.get('/api/admin/users-with-quota', adminMiddleware, async (c) => c.json({users: await data.listAllUsersWithQuota(c.get('db'))}));
app.post('/api/admin/storage-mode', adminMiddleware, async (c) => {
    await c.get('configManager').save({ storageMode: (await c.req.json()).mode });
    return c.json({success:true});
});
app.get('/api/admin/webdav', adminMiddleware, async(c) => c.json((await c.get('configManager').load()).webdav ? [(await c.get('configManager').load()).webdav] : []));
app.post('/api/admin/webdav', adminMiddleware, async(c) => { await c.get('configManager').save({webdav: await c.req.json()}); return c.json({success:true}) });
app.get('/api/admin/s3', adminMiddleware, async(c) => c.json({s3: (await c.get('configManager').load()).s3}));
app.post('/api/admin/s3', adminMiddleware, async(c) => { await c.get('configManager').save({s3: await c.req.json()}); return c.json({success:true}) });
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
