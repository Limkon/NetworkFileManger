import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import Database from './database.js';
import ConfigManager from './config.js';
import * as data from './data.js';
import { initStorage } from './storage/index.js';
import { initCrypto } from './crypto.js';

const app = new Hono();

// =================================================================================
// 0. 靜態 HTML Shell (用於渲染分享頁面)
// =================================================================================
const SHARE_HTML = `
<!DOCTYPE html>
<html lang="zh">
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
        <h2 style="text-align:center;">正在加載...</h2>
    </div>
    <script>
        const pathParts = window.location.pathname.split('/');
        const token = pathParts.pop(); // 獲取 URL 最後一段作為 token
        const app = document.getElementById('app');

        async function load() {
            try {
                const res = await fetch('/api/public/share/' + token);
                const data = await res.json();
                
                if (!res.ok) throw new Error(data.message || '加載失敗');

                if (data.isLocked && !data.isUnlocked) {
                    renderPasswordForm(data.name);
                } else if (data.type === 'file') {
                    renderFile(data);
                } else {
                    renderFolder(data);
                }
            } catch (e) {
                app.innerHTML = '<div style="text-align:center;color:red;"><h3>錯誤</h3><p>' + e.message + '</p></div>';
            }
        }

        function renderPasswordForm(name) {
            app.innerHTML = \`
                <div class="locked-screen">
                    <i class="fas fa-lock file-icon"></i>
                    <h3>\${name} 受密碼保護</h3>
                    <div style="margin:20px 0;">
                        <input type="password" id="pass" placeholder="請輸入密碼" style="padding:10px; width:200px;">
                        <button class="btn" onclick="submitPass()">解鎖</button>
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
                    <p>時間: \${new Date(data.date).toLocaleString()}</p>
                    <div style="margin-top:30px;">
                        <a href="\${data.downloadUrl}" class="btn"><i class="fas fa-download"></i> 下載文件</a>
                    </div>
                </div>
            \`;
        }

        function renderFolder(data) {
            let html = \`<h3>\${data.name} (資料夾)</h3><div class="list">\`;
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
`;

// =================================================================================
// 1. 全局中間件：注入 DB, Config, Storage, Crypto
// =================================================================================
app.use('*', async (c, next) => {
    // 0. 初始化環境變數中的加密密鑰 (Cloudflare Workers 中 process.env 不可用)
    initCrypto(c.env.SESSION_SECRET);

    // 1. 初始化 DB
    const db = new Database(c.env.DB);
    c.set('db', db);

    // 2. 初始化 Config
    const configManager = new ConfigManager(c.env.CONFIG_KV);
    c.set('configManager', configManager);

    // 3. 預加載配置
    const config = await configManager.load();
    c.set('config', config);

    // 4. 初始化存儲後端 (將 c.env 傳入以獲取 BOT_TOKEN 等環境變數)
    const storage = initStorage(config, c.env); 
    c.set('storage', storage);

    await next();
});

// =================================================================================
// 2. 認證中間件
// =================================================================================
const authMiddleware = async (c, next) => {
    // 排除公開路由
    const publicPaths = [
        '/login', 
        '/register', 
        '/setup', 
        '/api/public', // 分享相關 API
        '/share/view', // 分享頁面
        '/share/download', // 分享下載
        '/assets',     // 靜態資源路徑 (如果需要)
        '/favicon.ico'
    ];
    
    if (publicPaths.some(path => c.req.path.startsWith(path))) {
        return await next();
    }

    const token = getCookie(c, 'remember_me');
    if (!token) {
        if (c.req.path.startsWith('/api') || c.req.header('accept')?.includes('json')) {
            return c.json({ success: false, message: '未登入' }, 401);
        }
        return c.redirect('/login');
    }

    const db = c.get('db');
    const tokenData = await data.findAuthToken(db, token);

    if (!tokenData || tokenData.expires_at < Date.now()) {
        if (tokenData) await data.deleteAuthToken(db, token);
        deleteCookie(c, 'remember_me');
        if (c.req.path.startsWith('/api') || c.req.header('accept')?.includes('json')) {
            return c.json({ success: false, message: '會話已過期' }, 401);
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
        return c.json({ success: false, message: '權限不足' }, 403);
    }
    await next();
};

app.use('*', authMiddleware);

// =================================================================================
// 3. 核心路由：系統初始化與認證
// =================================================================================

// 系統初始化 (部署後建議刪除或保護)
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
            
            return c.text("✅ 初始化成功: 預設管理員 admin / admin");
        }
        return c.text("✅ 資料庫結構已就緒");
    } catch (e) {
        return c.text(`❌ 初始化失敗: ${e.message}`, 500);
    }
});

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
        return c.text('帳號或密碼錯誤', 401);
    }
});

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
// 4. 分享功能路由 (公開 API)
// =================================================================================

// 獲取分享資訊
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
        return c.json({ success: false, message: '分享連結無效或已過期' }, 404);
    }

    const isLocked = !!item.share_password;
    const unlockCookie = getCookie(c, `share_unlock_${token}`);
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
            downloadUrl: `/share/download/${token}`
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

// 分享密碼驗證
app.post('/api/public/share/:token/auth', async (c) => {
    const db = c.get('db');
    const token = c.req.param('token');
    const { password } = await c.req.parseBody();

    let item = await data.getFileByShareToken(db, token);
    if (!item) item = await data.getFolderByShareToken(db, token);
    
    if (!item) return c.json({ success: false, message: '無效連結' }, 404);

    const bcrypt = await import('bcryptjs');
    if (item.share_password && bcrypt.compareSync(password, item.share_password)) {
        setCookie(c, `share_unlock_${token}`, 'true', { path: '/', maxAge: 86400, httpOnly: true, secure: true });
        return c.json({ success: true });
    }
    
    return c.json({ success: false, message: '密碼錯誤' }, 401);
});

// 分享文件下載
app.get('/share/download/:token', async (c) => {
    const db = c.get('db');
    const storage = c.get('storage');
    const token = c.req.param('token');
    
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
    } catch (e) {
        return c.text('Download failed', 500);
    }
});

// 渲染分享頁面 (返回靜態 HTML Shell)
app.get('/share/view/:type/:token', (c) => c.html(SHARE_HTML));


// =================================================================================
// 5. 核心業務路由
// =================================================================================

app.get('/', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    
    let root = await data.getRootFolder(db, user.id);
    if (!root) {
        const res = await data.createFolder(db, '/', null, user.id);
        root = { id: res.id };
    }
    
    // 這裡我們直接導向前端路由，前端會處理 ID 加密
    // 但為了保持一致性，後端可以做加密
    const { encrypt } = await import('./crypto.js'); 
    return c.redirect(`/view/${encrypt(root.id)}`);
});

app.get('/api/folder/:encryptedId', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const encId = c.req.param('encryptedId');
    
    const { decrypt } = await import('./crypto.js');
    const folderIdStr = decrypt(encId);
    if (!folderIdStr) return c.json({ success: false, message: '無效 ID' }, 400);
    
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

app.post('/upload', async (c) => {
    const db = c.get('db');
    const storage = c.get('storage');
    const user = c.get('user');
    const config = c.get('config');

    const body = await c.req.parseBody(); 
    const folderIdStr = c.req.query('folderId');
    const folderId = parseInt(folderIdStr);

    if (isNaN(folderId)) return c.json({ success: false, message: '缺少 folderId' }, 400);

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

    if (files.length === 0) return c.json({ success: false, message: '沒有檢測到文件' }, 400);

    const totalSize = files.reduce((acc, f) => acc + f.size, 0);
    if (!await data.checkQuota(db, user.id, totalSize)) {
        return c.json({ success: false, message: '空間不足' }, 413);
    }

    const results = [];
    
    for (const file of files) {
        try {
            const messageId = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
            
            const uploadResult = await storage.upload(
                file.stream(), 
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
        responseHeaders.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileInfo.fileName)}`);
        responseHeaders.set('Content-Type', fileInfo.mimetype || contentType || 'application/octet-stream');
        
        return new Response(stream, {
            headers: responseHeaders
        });
    } catch (e) {
        return c.text(`Download failed: ${e.message}`, 500);
    }
});

// =================================================================================
// 6. 管理員路由
// =================================================================================

app.get('/api/admin/users', adminMiddleware, async (c) => {
    const db = c.get('db');
    const users = await data.listAllUsers(db);
    return c.json(users);
});

app.post('/api/admin/storage-mode', adminMiddleware, async (c) => {
    const configManager = c.get('configManager');
    const { mode } = await c.req.parseBody();
    
    if (!['telegram', 'webdav', 's3'].includes(mode)) {
        return c.json({ success: false, message: '無效模式' }, 400);
    }
    
    await configManager.save({ storageMode: mode });
    return c.json({ success: true });
});

// =================================================================================
// 7. 靜態資源 Fallback
// =================================================================================
// 對於 public/ 下的靜態頁面（如 login.html），Cloudflare Assets 會自動攔截
// 這裡處理前端路由的 Fallback，提示使用者若未配置 Assets
app.get('/login', (c) => c.html('<html><body><h1>Please host the frontend static files (public/login.html)</h1></body></html>'));
app.get('/view/*', (c) => c.html('<html><body><h1>Manager App Loading... (Host public/manager.html)</h1></body></html>'));

export default app;
