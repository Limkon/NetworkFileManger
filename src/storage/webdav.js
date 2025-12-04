// src/storage/webdav.js

export default class WebdavStorage {
    constructor(config) {
        // 移除 URL 结尾的斜杠，确保路径拼接正确
        this.url = config.url ? config.url.replace(/\/$/, '') : '';
        this.username = config.username || '';
        this.password = config.password || '';
    }

    /**
     * 获取 WebDAV 客户端实例
     * data.js 中调用了 storage.getClient().moveFile(...)
     * 因此返回 this 自身即可
     */
    getClient() {
        return this;
    }

    /**
     * 发送 WebDAV 请求的辅助方法
     */
    async _request(method, relativePath, headers = {}, body = null) {
        if (!this.url) throw new Error('WebDAV URL 未配置');
        
        // 确保 relativePath 以 / 开头
        const path = relativePath.startsWith('/') ? relativePath : '/' + relativePath;
        // 对路径进行编码，但保留 / 符号
        const encodedPath = path.split('/').map(encodeURIComponent).join('/');
        const fullUrl = this.url + encodedPath;
        
        const auth = btoa(`${this.username}:${this.password}`);
        
        const fetchHeaders = {
            'Authorization': `Basic ${auth}`,
            ...headers
        };

        const response = await fetch(fullUrl, {
            method,
            headers: fetchHeaders,
            body
        });

        return response;
    }

    /**
     * 上传文件
     * @param {ReadableStream|File} fileStream - 文件流
     * @param {string} fileName - 文件名
     * @param {string} type - MIME 类型
     * @param {number} userId - 用户ID
     * @returns {Promise<{fileId: string}>}
     */
    async upload(fileStream, fileName, type, userId) {
        // 为了避免文件名冲突，建议使用 /<userId>/<fileName> 结构，这里简化为根目录
        // 实际存储路径建议包含用户隔离
        const storagePath = `/${userId}/${fileName}`;

        // 确保目录存在 (MKCOL) - 简化的容错处理，尝试创建用户目录
        await this._request('MKCOL', `/${userId}`).catch(() => {});

        const response = await this._request('PUT', storagePath, {
            'Content-Type': type || 'application/octet-stream'
        }, fileStream);

        if (!response.ok) {
            throw new Error(`WebDAV 上传失败: ${response.status} ${response.statusText}`);
        }

        return {
            fileId: storagePath, // 数据库将保存这个路径
            thumbId: null
        };
    }

    /**
     * 下载文件
     * @param {string} fileId - 存储在数据库中的路径 (如 /1/image.png)
     */
    async download(fileId) {
        const response = await this._request('GET', fileId);
        
        if (!response.ok) {
            throw new Error(`WebDAV 下载失败: ${response.status} ${response.statusText}`);
        }

        return {
            stream: response.body,
            contentType: response.headers.get('content-type'),
            headers: {
                'Content-Length': response.headers.get('content-length'),
                'ETag': response.headers.get('etag')
            }
        };
    }

    /**
     * 删除文件或文件夹
     * @param {Array} files - 文件列表
     * @param {Array} folders - 文件夹列表
     */
    async remove(files, folders) {
        const items = [...(files || []), ...(folders || [])];
        
        for (const item of items) {
            // file_id 存储的是 WebDAV 路径
            let pathToDelete = item.file_id || item.path;

            if (pathToDelete) {
                try {
                    await this._request('DELETE', pathToDelete);
                } catch (e) {
                    console.warn(`WebDAV 删除失败 (${pathToDelete}):`, e.message);
                }
            }
        }
    }

    /**
     * 移动文件 (WebDAV MOVE)
     * @param {string} oldPath 
     * @param {string} newPath 
     */
    async moveFile(oldPath, newPath) {
        // Destination Header 必须是完整的 URL
        const destPath = newPath.startsWith('/') ? newPath : '/' + newPath;
        const encodedDestPath = destPath.split('/').map(encodeURIComponent).join('/');
        const destinationUrl = this.url + encodedDestPath;

        const response = await this._request('MOVE', oldPath, {
            'Destination': destinationUrl,
            'Overwrite': 'T'
        });

        if (!response.ok) {
            throw new Error(`WebDAV 移动失败: ${response.status} ${response.statusText}`);
        }
    }

    /**
     * 列出目录内容 (PROPFIND)
     * 简单 XML 解析获取文件名和大小
     * 用于扫描导入功能
     */
    async list(prefix = '/') {
        // WebDAV 使用 PROPFIND 方法列出目录
        const response = await this._request('PROPFIND', prefix, {
            'Depth': '1'
        });

        if (!response.ok) throw new Error(`WebDAV List 失败: ${response.status}`);
        const text = await response.text();

        // 简单正则解析 XML (WebDAV 响应包含 href 和 getcontentlength)
        // 注意: 这种解析适用于简单场景。生产环境如需处理复杂 XML 命名空间，建议引入 XML Parser。
        const contents = [];
        const responses = text.split(/<\/[Dd]:response>|<\/[Rr]:response>/); // 兼容常见的 D: 或 R: 命名空间
        
        for (const resp of responses) {
            if (!resp.match(/<[a-zA-Z0-9]+:response/)) continue;
            
            const hrefMatch = resp.match(/<[a-zA-Z0-9]+:href>(.*?)<\/[a-zA-Z0-9]+:href>/);
            const sizeMatch = resp.match(/<[a-zA-Z0-9]+:getcontentlength>(\d+)<\/[a-zA-Z0-9]+:getcontentlength>/);
            // 检查是否为文件夹 (通常包含 <collection/> 标签)
            const isCollection = resp.match(/<[a-zA-Z0-9]+:collection\/>/);
            
            if (hrefMatch && !isCollection) { // 只处理文件
                let rawPath = hrefMatch[1];
                try { rawPath = decodeURIComponent(rawPath); } catch(e){}
                
                // 有些 WebDAV 服务器返回绝对路径，这里暂时直接使用，
                // 实际逻辑中可能需要去除服务器根路径以匹配存储逻辑
                
                contents.push({
                    fileId: rawPath, 
                    size: sizeMatch ? parseInt(sizeMatch[1]) : 0,
                    updatedAt: Date.now()
                });
            }
        }
        return contents;
    }
}
