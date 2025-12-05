export class WebDAVStorage {
    constructor(config) {
        // 去除 endpoint 末尾的斜杠
        this.endpoint = config.endpoint.endsWith('/') ? config.endpoint.slice(0, -1) : config.endpoint;
        this.username = config.username;
        this.password = config.password;
        this.authHeader = 'Basic ' + btoa(`${this.username}:${this.password}`);
    }

    async ensureDir(path) {
        const parts = path.split('/').filter(p => p);
        let currentUrl = this.endpoint;
        
        for (const part of parts) {
            currentUrl += '/' + encodeURIComponent(part); // WebDAV 路径必须编码
            
            // 检查目录是否存在
            const check = await fetch(currentUrl, {
                method: 'PROPFIND',
                headers: { 
                    'Authorization': this.authHeader,
                    'Depth': '0'
                }
            });
            
            // 如果不存在，创建它
            if (check.status === 404) {
                await fetch(currentUrl, {
                    method: 'MKCOL',
                    headers: { 'Authorization': this.authHeader }
                });
            }
        }
    }

    async upload(file, fileName, contentType, userId, folderId) {
        // WebDAV 需要先确保存储路径的文件夹存在
        const dirPath = `${userId}/${folderId}`;
        await this.ensureDir(dirPath);
        
        const key = `${dirPath}/${fileName}`;
        // 注意：WebDAV 的 URL 路径部分通常需要编码
        const url = `${this.endpoint}/${userId}/${folderId}/${encodeURIComponent(fileName)}`;
        
        const res = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': this.authHeader,
                'Content-Type': contentType
            },
            body: file
        });

        if (!res.ok) {
            throw new Error(`WebDAV Upload Failed: ${res.status} ${res.statusText}`);
        }

        return {
            fileId: key, // 存储相对路径作为 ID
            thumbId: null
        };
    }

    async download(fileId, userId) {
        // fileId 是相对路径，例如 "1/5/hello.txt"
        // 拼接 URL 时需要对每一段进行编码，或者 fileId 本身在生成时已规范化
        // 这里简单处理：将 fileId 拆分并编码
        const encodedPath = fileId.split('/').map(encodeURIComponent).join('/');
        const url = `${this.endpoint}/${encodedPath}`;

        const res = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': this.authHeader }
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
        // WebDAV 逐个删除
        const targets = files.map(f => f.file_id);
        
        for (const path of targets) {
            const encodedPath = path.split('/').map(encodeURIComponent).join('/');
            const url = `${this.endpoint}/${encodedPath}`;
            await fetch(url, {
                method: 'DELETE',
                headers: { 'Authorization': this.authHeader }
            });
        }
    }

    async list(prefix) {
        // WebDAV 的 PROPFIND 返回 XML，解析较为复杂且消耗资源
        // 暂不支持自动扫描 WebDAV 导入，仅记录日志
        console.warn("WebDAV storage scan is not implemented yet.");
        return [];
    }
}
