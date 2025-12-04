{
type: "file_content_update",
fileName: "limkon/networkfilemanger/NetworkFileManger-ff9f914d786efd7cd80c55485f0fe871f93b3f13/src/worker.js",
fullContent: `import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import Database from './database.js';
import ConfigManager from './config.js';
import * as data from './data.js';
import { initStorage } from './storage/index.js';
import { initCrypto, encrypt, decrypt } from './crypto.js';

const app = new Hono();

// =================================================================================
// 0. 靜態 HTML Shell (用於渲染分享頁面)
// =================================================================================
const SHARE_HTML = \`
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
    <div class="container" id="app">
        <h2 style="text-align:center;">正在加载...</h2>
    </div>
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
            app.innerHTML = \`
                <div class="locked-screen">
                    <i class="fas fa-lock file-icon"></i>
                    <h3>\${name} 受密码保护</h3>
                    <div style="margin:20px 0;">
                        <input type="password" id="pass" placeholder="请输入密码" style="padding:10px; width:200px;">
                        <button class="btn" onclick="submitPass()">解锁</button>
                    </div>
                    <p id="err" class="error-msg"></p>
                </div>
            \`;
        }
        
        window.submitPass = async () => {
            const pass = document.getElementById('pass').value;
            const res = await fetch('/api/public/share/' + token + '/auth', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ password: pass })
            });
            const d = await res.json();
            if (d.success) load();
            else document.getElementById('err').textContent = d.message;
        };

        function renderFile(data) {
            app.innerHTML = \`
                <div style="text-align:center;">
                    <i class="fas fa-file file-icon"></i>
                    <h2>\${data.name}</h2>
                    <p>大小: \${(data.size/1024/1024).toFixed(2)} MB</p>
                    <p>时间: \${new Date(data.date).toLocaleString()}</p>
                    <div style="margin-top:30px;">
                        <a href="\${data.downloadUrl}" class="btn"><i class="fas fa-download"></i> 下载文件</a>
                    </div>
                </div>
            \`;
        }

        function renderFolder(data) {
            let html = \`<h3>\${data.name} (文件夹)</h3><div class="list">\`;
            if(data.folders) {
                data.folders.forEach(f => {
                    html += \`<div class="list-item"><i class="fas fa-folder" style="color:#fbc02d;"></i> <span>\${f.name}</span></div>\`;
                });
            }
            if(data.files) {
                data.files.forEach(f => {
                    html += \`<div class="list-item"><i class="fas fa-file" style="color:#555;"></i> <span>\${f.name}</span> <span style="margin-left:auto;font-size:12px;color:#999;">\${(f.size/1024).toFixed(1)} KB</span></div>\`;
                });
            }
            html += '</div>';
            app.innerHTML = html;
        }

        load();
    </script>
</body>
</html>
\`;

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

    // 4. 初始化存储后端 (将 c.env 传入以获取 BOT_TOKEN 等环境变量)
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
        '/api/public', // 分享相关 API
        '/share/view', // 分享页面
        '/share/download', // 分享下载
        '/assets',     // 静态资源路径
        '/favicon.ico'
    ];
    
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
        return c.text(\`❌ 初始化失败: \${e.message}\`, 500);
    }
});

// 登录
app.post('/login', async (c) => {
    const { username, password } = await c.req.parseBody();
    const db = c.get('db');
    
    const user = await data.findUserByName(db, username);
    const bcrypt = await import('bcryptjs');
    
    if (user && bcrypt.compareSync(password, user.password)) {
        // 使用 Web Crypto API 生成 Token
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

// 注册
app.post('/register', async (c) => {
    const { username, password } = await c.req.parseBody();
    if (!username || !password) {
        return c.text('用户名和密码不能为空', 400);
    }
    
    const db = c.get('db');
    
    const existing = await data.findUserByName(db, username);
    if (existing) {
        return c.text('用户名已存在', 400);
    }
    
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
// 4. 分享功能路由 (公开 API)
// =================================================================================

app.get('/api/public/share/:token', async (c) => {
    const db = c.get('db');
    const token = c.req.param('token');
    
    let item = await data.getFileByShareToken(db, token);
    let type = 'file';
    
    if (!item) {
        item = await data.getFolderByShareToken(db, token);
        type = 'folder';
    }

    if (!item) {
        return c.json({ success: false, message: '分享链接无效或已过期' }, 404);
    }

    const isLocked = !!item.share_password;
    const unlockCookie = getCookie(c, \`share_unlock_\${token}\`);
    const isUnlocked = unlockCookie === 'true';

    if (isLocked && !isUnlocked) {
        return c.json({ 
            success: true, 
            type, 
            isLocked: true, 
            isUnlocked: false,
            name: type === 'file' ? item.fileName : item.name 
        });
    }

    if (type === 'file') {
        return c.json({
            success: true,
            type: 'file',
            isLocked,
            isUnlocked: true,
            name: item.fileName,
            size: item.size,
            date: item.date,
            mimeType: item.mimetype,
            downloadUrl: \`/share/download/\${token}\`
        });
    } else {
        const contents = await data.getFolderContents(db, item.id, item.user_id);
        const safeFolders = contents.folders.map(f => ({ name: f.name, size: 0, type: 'folder' }));
        const safeFiles = contents.files.map(f => ({ name: f.fileName, size: f.size, date: f.date, type: 'file', id: f.message_id }));

        return c.json({
            success: true,
            type: 'folder',
            isLocked,
            isUnlocked: true,
            name: item.name,
            files: safeFiles,
            folders: safeFolders
        });
    }
});

app.post('/api/public/share/:token/auth', async (c) => {
    const db = c.get('db');
    const token = c.req.param('token');
    const { password } = await c.req.parseBody();

    let item = await data.getFileByShareToken(db, token);
    if (!item) item = await data.getFolderByShareToken(db, token);
    
    if (!item) return c.json({ success: false, message: '无效链接' }, 404);

    const bcrypt = await import('bcryptjs');
    if (item.share_password && bcrypt.compareSync(password, item.share_password)) {
        setCookie(c, \`share_unlock_\${token}\`, 'true', { path: '/', maxAge: 86400, httpOnly: true, secure: true });
        return c.json({ success: true });
    }
    
    return c.json({ success: false, message: '密码错误' }, 401);
});

app.get('/share/download/:token', async (c) => {
    const db = c.get('db');
    const storage = c.get('storage');
    const token = c.req.param('token');
    
    const file = await data.getFileByShareToken(db, token);
    if (!file) return c.text('File not found', 404);
    
    if (file.share_password) {
         const unlockCookie = getCookie(c, \`share_unlock_\${token}\`);
         if (unlockCookie !== 'true') return c.text('Password required', 403);
    }
    
    try {
        const { stream, contentType, headers } = await storage.download(file.file_id, file.user_id);
        const responseHeaders = new Headers(headers);
        responseHeaders.set('Content-Disposition', \`attachment; filename*=UTF-8''\${encodeURIComponent(file.fileName)}\`);
        responseHeaders.set('Content-Type', file.mimetype || contentType || 'application/octet-stream');
        return new Response(stream, { headers: responseHeaders });
    } catch (e) {
        return c.text('Download failed', 500);
    }
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
    
    // 将 ID 加密后重定向
    return c.redirect(\`/view/\${encrypt(root.id)}\`);
});

// 获取文件夹内容
app.get('/api/folder/:encryptedId', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const encId = c.req.param('encryptedId');
    
    const folderIdStr = decrypt(encId);
    if (!folderIdStr) return c.json({ success: false, message: '无效 ID' }, 400);
    
    const folderId = parseInt(folderIdStr);
    
    try {
        const result = await data.getFolderContents(db, folderId, user.id);
        const pathArr = await data.getFolderPath(db, folderId, user.id);
        
        return c.json({
            contents: result,
            path: pathArr
        });
    } catch (e) {
        return c.json({ success: false, message: e.message }, 500);
    }
});

// 获取所有文件夹 (用于移动功能)
app.get('/api/folders', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    try {
        const folders = await data.getAllFolders(db, user.id);
        return c.json(folders);
    } catch (e) {
        return c.json({ success: false, message: e.message }, 500);
    }
});

// 文件上传
app.post('/upload', async (c) => {
    const db = c.get('db');
    const storage = c.get('storage');
    const user = c.get('user');
    const config = c.get('config');

    const body = await c.req.parseBody(); 
    
    const encFolderId = c.req.query('folderId');
    const folderIdStr = decrypt(encFolderId);
    const folderId = parseInt(folderIdStr);

    if (isNaN(folderId)) return c.json({ success: false, message: '缺少或无效的 folderId' }, 400);

    const files = [];
    Object.keys(body).forEach(key => {
        const value = body[key];
        if (value instanceof File) {
            files.push(value);
        } else if (Array.isArray(value)) {
            value.forEach(v => {
                if (v instanceof File) files.push(v);
            });
        }
    });

    if (files.length === 0) return c.json({ success: false, message: '没有检测到文件' }, 400);

    const totalSize = files.reduce((acc, f) => acc + f.size, 0);
    if (!await data.checkQuota(db, user.id, totalSize)) {
        return c.json({ success: false, message: '空间不足' }, 413);
    }

    const results = [];
    
    for (const file of files) {
        try {
            const messageId = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
            
            const uploadResult = await storage.upload(
                file, 
                file.name, 
                file.type, 
                user.id, 
                folderId, 
                config
            );

            await data.addFile(db, {
                message_id: messageId,
                fileName: file.name,
                mimetype: file.type,
                size: file.size,
                file_id: uploadResult.fileId,
                thumb_file_id: uploadResult.thumbId || null,
                date: Date.now()
            }, folderId, user.id, config.storageMode);

            results.push({ name: file.name, success: true });

        } catch (e) {
            console.error(e);
            results.push({ name: file.name, success: false, error: e.message });
        }
    }

    return c.json({ success: true, results });
});

// 文件下载代理
app.get('/download/proxy/:messageId', async (c) => {
    const db = c.get('db');
    const storage = c.get('storage');
    const user = c.get('user');
    const msgId = c.req.param('messageId');

    const files = await data.getFilesByIds(db, [BigInt(msgId)], user.id);
    const fileInfo = files[0];
    
    if (!fileInfo) return c.text('File not found', 404);

    try {
        const { stream, contentType, headers } = await storage.download(fileInfo.file_id, user.id);
        const responseHeaders = new Headers(headers);
        responseHeaders.set('Content-Disposition', \`attachment; filename*=UTF-8''\${encodeURIComponent(fileInfo.fileName)}\`);
        responseHeaders.set('Content-Type', fileInfo.mimetype || contentType || 'application/octet-stream');
        
        return new Response(stream, {
            headers: responseHeaders
        });
    } catch (e) {
        return c.text(\`Download failed: \${e.message}\`, 500);
    }
});

// =================================================================================
// 6. 扩展业务 API (配额、创建、删除、重命名、搜索、编辑保存、移动、分享、加密)
// =================================================================================

// 获取用户配额
app.get('/api/user/quota', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    try {
        const quota = await data.getUserQuota(db, user.id);
        return c.json(quota);
    } catch (e) {
        return c.json({ max: 0, used: 0 });
    }
});

// 创建文件夹
app.post('/api/folder/create', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const { name, parentId: encryptedParentId } = await c.req.json();

    const parentIdStr = decrypt(encryptedParentId);
    let parentId = parentIdStr ? parseInt(parentIdStr) : null;
    
    if (!name) return c.json({ success: false, message: '名称不能为空' }, 400);

    try {
        await data.createFolder(db, name, parentId, user.id);
        return c.json({ success: true });
    } catch (e) {
        return c.json({ success: false, message: e.message }, 500);
    }
});

// 删除项目 (文件或文件夹)
app.post('/api/delete', async (c) => {
    const db = c.get('db');
    const storage = c.get('storage');
    const user = c.get('user');
    const { files, folders } = await c.req.json();
    
    try {
        await data.unifiedDelete(db, storage, null, null, user.id, files, folders);
        return c.json({ success: true });
    } catch (e) {
        console.error(e);
        return c.json({ success: false, message: '删除失败: ' + e.message }, 500);
    }
});

// 重命名
app.post('/api/rename', async (c) => {
    const db = c.get('db');
    const storage = c.get('storage');
    const user = c.get('user');
    const { type, id, name } = await c.req.json();
    
    if (!name) return c.json({ success: false, message: '名称不能为空' }, 400);

    try {
        if (type === 'file') {
             await data.renameFile(db, storage, BigInt(id), name, user.id);
        } else {
             await data.renameFolder(db, storage, parseInt(id), name, user.id);
        }
        return c.json({ success: true });
    } catch (e) {
        return c.json({ success: false, message: e.message }, 500);
    }
});

// 移动项目
app.post('/api/move', async (c) => {
    const db = c.get('db');
    const storage = c.get('storage');
    const user = c.get('user');
    const { files, folders, targetFolderId: encryptedTargetId } = await c.req.json();

    const targetFolderIdStr = decrypt(encryptedTargetId);
    const targetFolderId = targetFolderIdStr ? parseInt(targetFolderIdStr) : null;

    if (!targetFolderId) return c.json({ success: false, message: '目标文件夹无效' }, 400);

    try {
        // 批量移动
        const fileIds = (files || []).map(id => BigInt(id));
        const folderIds = (folders || []).map(id => parseInt(id));

        // 调用 data.js 中的 moveItems (注意：不是 moveItem，moveItems 支持批量且无冲突检测逻辑，
        // 如果需要冲突检测，需要前端配合或使用更复杂的 moveItem 循环)
        // 这里为了简化和效率，使用批量移动基础逻辑。data.js 的 moveItems 会处理物理移动和 DB 更新。
        await data.moveItems(db, storage, fileIds, folderIds, targetFolderId, user.id);

        return c.json({ success: true });
    } catch (e) {
        console.error(e);
        return c.json({ success: false, message: '移动失败: ' + e.message }, 500);
    }
});


// 搜索
app.get('/api/search', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const q = c.req.query('q');
    
    if (!q) return c.json({ folders: [], files: [] });
    
    const result = await data.searchItems(db, q, user.id);
    return c.json(result);
});

// 编辑器保存文件内容
app.post('/api/file/save', async (c) => {
    const db = c.get('db');
    const storage = c.get('storage');
    const user = c.get('user');
    const config = c.get('config');
    const { id, content } = await c.req.json();
    
    if (!id || content === undefined) return c.json({ success: false, message: '缺少参数' }, 400);

    const files = await data.getFilesByIds(db, [BigInt(id)], user.id);
    const fileInfo = files[0];
    if (!fileInfo) return c.json({ success: false, message: '文件不存在' }, 404);

    try {
        const blob = new Blob([content], { type: 'text/plain' });
        const fileObj = new File([blob], fileInfo.fileName, { type: 'text/plain' });

        const uploadResult = await storage.upload(
            fileObj,
            fileInfo.fileName,
            'text/plain',
            user.id,
            fileInfo.folder_id,
            config
        );

        await data.updateFile(db, BigInt(id), {
            file_id: uploadResult.fileId,
            size: fileObj.size,
            date: Date.now()
        }, user.id);

        return c.json({ success: true });
    } catch (e) {
        return c.json({ success: false, message: '保存失败: ' + e.message }, 500);
    }
});

// 获取分享列表
app.get('/api/shares', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const shares = await data.getActiveShares(db, user.id);
    return c.json(shares);
});

// 创建分享
app.post('/api/share/create', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const { itemId, itemType, expiresIn, password, customExpiresAt } = await c.req.json();
    
    if (!itemId || !itemType) return c.json({ success: false, message: '参数错误' }, 400);

    try {
        const result = await data.createShareLink(db, itemId, itemType, expiresIn, user.id, password, customExpiresAt);
        if (result.success) {
             return c.json({ success: true, token: result.token, link: \`/share/view/\${itemType}/\${result.token}\` });
        } else {
             return c.json({ success: false, message: result.message }, 500);
        }
    } catch (e) {
        return c.json({ success: false, message: '创建分享失败: ' + e.message }, 500);
    }
});

// 取消分享
app.post('/api/share/cancel', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const { itemId, itemType } = await c.req.json();
    await data.cancelShare(db, itemId, itemType, user.id);
    return c.json({ success: true });
});

// 文件夹加密
app.post('/api/folder/lock', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const { folderId, password } = await c.req.json();
    
    if (!folderId || !password) return c.json({ success: false, message: '参数错误' }, 400);
    
    // 解密 ID
    const realIdStr = decrypt(folderId);
    const realId = realIdStr ? parseInt(realIdStr) : null;
    if (!realId) return c.json({ success: false, message: '无效的文件夹 ID' }, 400);

    const bcrypt = await import('bcryptjs');
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(password, salt);

    try {
        await data.setFolderPassword(db, realId, hash, user.id);
        return c.json({ success: true });
    } catch (e) {
        return c.json({ success: false, message: e.message }, 500);
    }
});


// =================================================================================
// 7. 管理员路由
// =================================================================================

app.get('/api/admin/users', adminMiddleware, async (c) => {
    const db = c.get('db');
    const users = await data.listAllUsers(db);
    return c.json(users);
});

app.get('/api/admin/users-with-quota', adminMiddleware, async (c) => {
    const db = c.get('db');
    const users = await data.listAllUsersWithQuota(db);
    return c.json({ users });
});

app.post('/api/admin/storage-mode', adminMiddleware, async (c) => {
    const configManager = c.get('configManager');
    const { mode } = await c.req.json();
    
    if (!['telegram', 'webdav', 's3', 'local'].includes(mode)) {
        return c.json({ success: false, message: '无效模式' }, 400);
    }
    
    await configManager.save({ storageMode: mode });
    return c.json({ success: true });
});

// WebDAV 配置 API
app.get('/api/admin/webdav', adminMiddleware, async (c) => {
    const configManager = c.get('configManager');
    const config = await configManager.load();
    const wd = config.webdav || {};
    return c.json(wd.url ? [{ id: 1, ...wd }] : []);
});

app.post('/api/admin/webdav', adminMiddleware, async (c) => {
    const configManager = c.get('configManager');
    const { url, username, password } = await c.req.json();
    const config = await configManager.load();
    
    const newWebdav = { url, username };
    if (password) newWebdav.password = password;
    else if (config.webdav) newWebdav.password = config.webdav.password;

    await configManager.save({ webdav: newWebdav });
    return c.json({ success: true });
});

app.delete('/api/admin/webdav/:id', adminMiddleware, async (c) => {
    const configManager = c.get('configManager');
    await configManager.save({ webdav: {} });
    return c.json({ success: true });
});

// S3 配置 API
app.get('/api/admin/s3', adminMiddleware, async (c) => {
    const configManager = c.get('configManager');
    const config = await configManager.load();
    const s3 = { ...config.s3 };
    delete s3.secretAccessKey;
    return c.json({ s3 });
});

app.post('/api/admin/s3', adminMiddleware, async (c) => {
    const configManager = c.get('configManager');
    const newConfig = await c.req.json();
    const config = await configManager.load();
    
    const s3 = { ...config.s3, ...newConfig };
    if (!newConfig.secretAccessKey && config.s3?.secretAccessKey) {
        s3.secretAccessKey = config.s3.secretAccessKey;
    }
    
    await configManager.save({ s3 });
    return c.json({ success: true });
});

// 用户管理 API
app.post('/api/admin/add-user', adminMiddleware, async (c) => {
    const db = c.get('db');
    const { username, password } = await c.req.json();
    const bcrypt = await import('bcryptjs');
    
    if (await data.findUserByName(db, username)) {
        return c.json({ success: false, message: '用户名已存在' }, 400);
    }
    
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(password, salt);
    await data.createUser(db, username, hash);
    return c.json({ success: true });
});

app.post('/api/admin/change-password', adminMiddleware, async (c) => {
    const db = c.get('db');
    const { userId, newPassword } = await c.req.json();
    const bcrypt = await import('bcryptjs');
    
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(newPassword, salt);
    await data.changeUserPassword(db, userId, hash);
    return c.json({ success: true });
});

app.post('/api/admin/delete-user', adminMiddleware, async (c) => {
    const db = c.get('db');
    const { userId } = await c.req.json();
    await data.deleteUser(db, userId);
    return c.json({ success: true });
});

app.post('/api/admin/set-quota', adminMiddleware, async (c) => {
    const db = c.get('db');
    const { userId, maxBytes } = await c.req.json();
    await data.setMaxStorageForUser(db, userId, maxBytes);
    return c.json({ success: true });
});

// 管理员扫描 (Mock实现，因Worker超时限制)
app.post('/api/admin/scan', adminMiddleware, async (c) => {
    const { userId, storageType } = await c.req.json();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(\`正在初始化 \${storageType} 扫描 (User ID: \${userId})...\n\`));
            setTimeout(() => {
                controller.enqueue(new TextEncoder().encode("错误: Cloudflare Workers 环境下的全量扫描功能暂未完全实现。\n"));
                controller.enqueue(new TextEncoder().encode("提示: 请确保数据库与存储桶保持同步。\n"));
                controller.close();
            }, 1000);
        }
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
});

// =================================================================================
// 8. 静态资源 Fallback
// =================================================================================
app.get('/login', (c) => c.html('<html><body><h1>Please host the frontend static files (public/login.html)</h1></body></html>'));
app.get('/view/*', (c) => c.html('<html><body><h1>Manager App Loading... (Host public/manager.html)</h1></body></html>'));

export default app;`
}
