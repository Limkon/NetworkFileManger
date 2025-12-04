// src/worker.js

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serveStatic } from 'hono/cloudflare-workers';
import Database from './database.js';
import ConfigManager from './config.js';
import * as data from './data.js';
// 我们将在下一步重构 storage 模块
import { getStorage, initStorage } from './storage/index.js';

const app = new Hono();

// --- 1. 全局中间件：注入 DB 和 Config ---
app.use('*', async (c, next) => {
    // 初始化 DB (使用 env.DB 绑定)
    const db = new Database(c.env.DB);
    c.set('db', db);

    // 初始化 Config (使用 env.CONFIG_KV 绑定)
    const configManager = new ConfigManager(c.env.CONFIG_KV);
    c.set('configManager', configManager);

    // 预加载配置 (缓存到本次请求)
    const config = await configManager.load();
    c.set('config', config);

    // 初始化存储后端 (传入当前配置)
    // 注意：Workers 是无状态的，所以每次请求可能都需要初始化轻量级客户端
    const storage = initStorage(config); 
    c.set('storage', storage);

    await next();
});

// --- 2. 认证中间件 ---
const authMiddleware = async (c, next) => {
    // 排除公开路由
    const publicPaths = ['/login', '/register', '/setup', '/share', '/api/public'];
    if (publicPaths.some(path => c.req.path.startsWith(path))) {
        return await next();
    }

    const token = getCookie(c, 'remember_me');
    if (!token) {
        // 如果是 API 请求，返回 401
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

    // 注入用户信息
    c.set('user', { 
        id: tokenData.user_id, 
        username: tokenData.username, 
        isAdmin: !!tokenData.is_admin 
    });
    
    // 简单的 Session 模拟 (用于 unlockedFolders)
    // 在 Workers 中通常不使用内存 Session，这里建议客户端存储状态或使用 KV Session
    // 简化起见，这里暂不实现 folder lock 的 session 保持
    
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

// --- 3. 核心路由 ---

// 初始化路由 (建议部署后移除或加锁)
app.get('/setup', async (c) => {
    const db = c.get('db');
    try {
        await db.initDB();
        
        // 检查是否需要创建默认管理员
        const admin = await data.findUserByName(db, 'admin');
        if (!admin) {
            // 注意：这里需要 bcryptjs 依赖
            const bcrypt = await import('bcryptjs');
            const salt = bcrypt.genSaltSync(10);
            const hash = bcrypt.hashSync('admin', salt);
            
            const newUser = await data.createUser(db, 'admin', hash);
            // 手动设为管理员
            await db.run("UPDATE users SET is_admin = 1 WHERE id = ?", [newUser.id]);
            await data.createFolder(db, '/', null, newUser.id);
            
            return c.text("✅ 初始化成功: 默认管理员 admin / admin");
        }
        return c.text("✅ 数据库结构已就绪");
    } catch (e) {
        return c.text(`❌ 初始化失败: ${e.message}`, 500);
    }
});

// 登录
app.post('/login', async (c) => {
    const { username, password } = await c.req.parseBody();
    const db = c.get('db');
    
    const user = await data.findUserByName(db, username);
    const bcrypt = await import('bcryptjs');
    
    if (user && bcrypt.compareSync(password, user.password)) {
        // 生成 Token
        // Workers 中使用 Web Crypto API 生成随机串
        const array = new Uint8Array(32);
        crypto.getRandomValues(array);
        const token = Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
        
        const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
        await data.createAuthToken(db, user.id, token, expiresAt);
        
        setCookie(c, 'remember_me', token, {
            httpOnly: true,
            secure: true, // Workers 默认 HTTPS
            maxAge: 30 * 24 * 60 * 60,
            path: '/'
        });
        
        return c.redirect('/');
    } else {
        return c.text('账号或密码错误', 401);
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

// 首页重定向
app.get('/', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    
    let root = await data.getRootFolder(db, user.id);
    if (!root) {
        // 如果没有根目录自动创建
        const res = await data.createFolder(db, '/', null, user.id);
        root = { id: res.id };
    }
    
    // 使用 data.js 导出的 encryptId 逻辑 (需要在 data.js 导出 encrypt/decrypt 封装)
    // 这里假设 data.js 内部使用的 crypto.js 已经兼容 Workers (无 Buffer 依赖或 Polyfill)
    const { encrypt } = await import('./crypto.js'); 
    return c.redirect(`/view/${encrypt(root.id)}`);
});

// API: 获取文件夹内容
app.get('/api/folder/:encryptedId', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const encId = c.req.param('encryptedId');
    
    const { decrypt } = await import('./crypto.js');
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

// API: 文件上传 (关键部分)
app.post('/upload', async (c) => {
    const db = c.get('db');
    const storage = c.get('storage');
    const user = c.get('user');
    const config = c.get('config');

    // 解析 FormData
    // Workers 的 parseBody 会自动处理文件为 File 对象
    const body = await c.req.parseBody(); 
    const folderIdStr = c.req.query('folderId');
    const folderId = parseInt(folderIdStr);

    if (isNaN(folderId)) return c.json({ success: false, message: '缺少 folderId' }, 400);

    // 获取所有上传的文件 (支持多文件)
    // 注意: Hono parseBody 对同名字段会返回数组，或者我们需要遍历
    // 这里假设前端使用 standard multipart upload
    
    const files = [];
    // Hono parseBody 返回的对象中，key 是字段名。如果是多文件上传且字段名相同，可能是数组
    // 这里简化处理，假设前端为每个文件通过 'files' 字段上传，或遍历 body
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

    // 检查配额
    const totalSize = files.reduce((acc, f) => acc + f.size, 0);
    if (!await data.checkQuota(db, user.id, totalSize)) {
        return c.json({ success: false, message: '空间不足' }, 413);
    }

    const results = [];
    
    for (const file of files) {
        try {
            // 调用 storage 上传
            // 我们将在 storage/index.js 中实现 upload 方法，接受 File/Stream
            // 生成 message_id (BigInt 模拟)
            const messageId = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
            
            // 检查同名冲突 (简化版：直接覆盖或报错，建议完善)
            // ... checkFullConflict logic ...

            // 执行上传 (Stream)
            // file.stream() 返回 ReadableStream
            const uploadResult = await storage.upload(
                file.stream(), 
                file.name, 
                file.type, 
                user.id, 
                folderId, 
                config
            );

            // 写入数据库
            await data.addFile(db, {
                message_id: messageId,
                fileName: file.name,
                mimetype: file.type,
                size: file.size,
                file_id: uploadResult.fileId, // 远程路径或ID
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

// API: 文件下载/流式传输
app.get('/download/proxy/:messageId', async (c) => {
    const db = c.get('db');
    const storage = c.get('storage');
    const user = c.get('user');
    const msgId = c.req.param('messageId');

    const files = await data.getFilesByIds(db, [BigInt(msgId)], user.id);
    const fileInfo = files[0];
    
    if (!fileInfo) return c.text('File not found', 404);

    // 获取文件流
    try {
        const { stream, contentType, headers } = await storage.download(fileInfo.file_id, user.id);
        
        // 设置响应头
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

// 管理员 API 示例
app.get('/api/admin/users', adminMiddleware, async (c) => {
    const db = c.get('db');
    const users = await data.listAllUsers(db);
    return c.json(users);
});

app.post('/api/admin/storage-mode', adminMiddleware, async (c) => {
    const configManager = c.get('configManager');
    const { mode } = await c.req.parseBody();
    
    if (!['telegram', 'webdav', 's3'].includes(mode)) {
        return c.json({ success: false, message: '无效模式' }, 400);
    }
    
    await configManager.save({ storageMode: mode });
    return c.json({ success: true });
});

// --- 静态页面路由 (Placeholder) ---
// 在真实部署中，你应该将 views/ 中的 HTML 文件放在 public/ 或 assets/ 目录
// 并配置 wrangler.toml 的 [assets]
// 这里为了演示，对于非 API 路由，如果没有匹配到，返回 404 或前端入口

// 示例：如果请求 HTML 页面，提示用户前端需要静态托管
app.get('/login', (c) => c.html('<html><body><h1>Please host the frontend static files (views/login.html)</h1></body></html>'));
app.get('/view/*', (c) => c.html('<html><body><h1>Manager App Loading... (Host views/manager.html)</h1></body></html>'));

export default app;
