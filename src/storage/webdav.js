{
type: "file_content_update",
fileName: "limkon/networkfilemanger/NetworkFileManger-ff9f914d786efd7cd80c55485f0fe871f93b3f13/src/storage/webdav.js",
fullContent: `// src/storage/webdav.js

export default class WebdavStorage {
    constructor(config) {
        this.url = config.url ? config.url.replace(/\/$/, '') : '';
        this.username = config.username || '';
        this.password = config.password || '';
    }

    getClient() {
        return this;
    }

    async _request(method, relativePath, headers = {}, body = null) {
        if (!this.url) throw new Error('WebDAV URL 未配置');
        const path = relativePath.startsWith('/') ? relativePath : '/' + relativePath;
        const encodedPath = path.split('/').map(encodeURIComponent).join('/');
        const fullUrl = this.url + encodedPath;
        const auth = btoa(\`\${this.username}:\${this.password}\`);
        
        const fetchHeaders = {
            'Authorization': \`Basic \${auth}\`,
            ...headers
        };

        const response = await fetch(fullUrl, { method, headers: fetchHeaders, body });
        return response;
    }

    async upload(fileStream, fileName, type, userId) {
        const storagePath = \`/\${userId}/\${fileName}\`;
        await this._request('MKCOL', \`/\${userId}\`).catch(() => {});
        const response = await this._request('PUT', storagePath, {
            'Content-Type': type || 'application/octet-stream'
        }, fileStream);

        if (!response.ok) {
            throw new Error(\`WebDAV 上传失败: \${response.status} \${response.statusText}\`);
        }

        return { fileId: storagePath, thumbId: null };
    }

    async download(fileId) {
        const response = await this._request('GET', fileId);
        if (!response.ok) throw new Error(\`WebDAV 下载失败: \${response.status} \${response.statusText}\`);

        return {
            stream: response.body,
            contentType: response.headers.get('content-type'),
            headers: {
                'Content-Length': response.headers.get('content-length'),
                'ETag': response.headers.get('etag')
            }
        };
    }

    async remove(files, folders) {
        const items = [...(files || []), ...(folders || [])];
        for (const item of items) {
            let pathToDelete = item.file_id || item.path;
            if (pathToDelete) {
                try {
                    await this._request('DELETE', pathToDelete);
                } catch (e) {
                    console.warn(\`WebDAV 删除失败 (\${pathToDelete}):\`, e.message);
                }
            }
        }
    }

    async moveFile(oldPath, newPath) {
        const destPath = newPath.startsWith('/') ? newPath : '/' + newPath;
        const encodedDestPath = destPath.split('/').map(encodeURIComponent).join('/');
        const destinationUrl = this.url + encodedDestPath;

        const response = await this._request('MOVE', oldPath, {
            'Destination': destinationUrl,
            'Overwrite': 'T'
        });

        if (!response.ok) throw new Error(\`WebDAV 移动失败: \${response.status} \${response.statusText}\`);
    }

    /**
     * 列出目录内容 (PROPFIND)
     * 简单 XML 解析获取文件名和大小
     */
    async list(prefix = '/') {
        const response = await this._request('PROPFIND', prefix, {
            'Depth': '1'
        });

        if (!response.ok) throw new Error(\`WebDAV List 失败: \${response.status}\`);
        const text = await response.text();

        // 简单正则解析 XML
        const contents = [];
        // 提取 href 和 contentlength
        // 注意: 这种解析非常脆弱，仅供演示。生产环境建议使用 XML Parser 库
        const responses = text.split('</D:response>');
        
        for (const resp of responses) {
            if (!resp.includes('D:response')) continue;
            
            const hrefMatch = resp.match(/<D:href>(.*?)<\/D:href>/);
            const sizeMatch = resp.match(/<D:getcontentlength>(\d+)<\/D:getcontentlength>/);
            const isCollection = resp.includes('<D:collection/>');
            
            if (hrefMatch && !isCollection) { // 只处理文件
                let rawPath = hrefMatch[1];
                // 移除 WebDAV Server 可能返回的 Host 前缀或 base path，這裡簡化處理
                // 假設 href 返回的是相對路徑或全路徑
                // 簡單解碼
                try { rawPath = decodeURIComponent(rawPath); } catch(e){}
                
                // 如果 rawPath 包含 url 前缀需要去除，这里假设用户配置的 URL 和返回的路径一致性需要适配
                // 暂时直接作为 ID
                
                contents.push({
                    fileId: rawPath, 
                    size: sizeMatch ? parseInt(sizeMatch[1]) : 0,
                    updatedAt: Date.now()
                });
            }
        }
        return contents;
    }
}`
}
