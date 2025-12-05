export class WebDAVStorage {
    constructor(config) {
        // 安全检查：防止 config 为空导致崩溃
        if (!config) {
            throw new Error("WebDAV 配置对象为空");
        }
        if (!config.endpoint) {
            // 如果是在初始化阶段没有配置，抛出明确错误，让 Worker 能够捕获并提示用户
            throw new Error("WebDAV Endpoint 未填写，请进入后台设置");
        }

        // 去除 endpoint 末尾的斜杠
        this.endpoint = config.endpoint.endsWith('/') ? config.endpoint.slice(0, -1) : config.endpoint;
        this.username = config.username || '';
        this.password = config.password || '';
        
        // 只有当有用户名密码时才生成 Auth Header (某些内网 WebDAV 可能无需密码)
        if (this.username || this.password) {
            this.authHeader = 'Basic ' + btoa(`${this.username}:${this.password}`);
        } else {
            this.authHeader = null;
        }
    }

    async ensureDir(path) {
        const parts = path.split('/').filter(p => p);
        let currentUrl = this.endpoint;
        
        for (const part of parts) {
            currentUrl += '/' + encodeURIComponent(part); 
            
            const headers = { 'Depth': '0' };
            if (this.authHeader) headers['Authorization'] = this.authHeader;

            // 检查目录是否存在
            const check = await fetch(currentUrl, {
                method: 'PROPFIND',
                headers: headers
            });
            
            // 如果不存在，创建它
            if (check.status === 404) {
                const mkHeaders = {};
                if (this.authHeader) mkHeaders['Authorization'] = this.authHeader;
                
                await fetch(currentUrl, {
                    method: 'MKCOL',
                    headers: mkHeaders
                });
            }
        }
    }

    async upload(file, fileName, contentType, userId, folderId) {
        const dirPath = `${userId}/${folderId}`;
        await this.ensureDir(dirPath);
        
        const key = `${dirPath}/${fileName}`;
        const url = `${this.endpoint}/${userId}/${folderId}/${encodeURIComponent(fileName)}`;
        
        const headers = { 'Content-Type': contentType };
        if (this.authHeader) headers['Authorization'] = this.authHeader;

        const res = await fetch(url, {
            method: 'PUT',
            headers: headers,
            body: file
        });

        if (!res.ok) {
            throw new Error(`WebDAV Upload Failed: ${res.status} ${res.statusText}`);
        }

        return {
            fileId: key, 
            thumbId: null
        };
    }

    async download(fileId, userId) {
        // 简单处理：将 fileId (相对路径) 拆分并编码
        const encodedPath = fileId.split('/').map(encodeURIComponent).join('/');
        const url = `${this.endpoint}/${encodedPath}`;

        const headers = {};
        if (this.authHeader) headers['Authorization'] = this.authHeader;

        const res = await fetch(url, {
            method: 'GET',
            headers: headers
        });

        if (!res.ok) throw new Error(`WebDAV Download Failed: ${res.status}`);

        return {
            stream: res.body,
            contentType: res.headers.get('Content-Type') || 'application/octet-stream',
            headers: {
                'Content-Length': res.headers.get('Content-Length'),
                'ETag': res.headers.get('ETag')
            }
        };
    }

    async remove(files, folders, userId) {
        const targets = files.map(f => f.file_id);
        
        for (const path of targets) {
            const encodedPath = path.split('/').map(encodeURIComponent).join('/');
            const url = `${this.endpoint}/${encodedPath}`;
            
            const headers = {};
            if (this.authHeader) headers['Authorization'] = this.authHeader;

            await fetch(url, {
                method: 'DELETE',
                headers: headers
            });
        }
    }

    async list(prefix) {
        console.warn("WebDAV storage scan is not implemented yet.");
        return [];
    }
}
