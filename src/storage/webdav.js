// src/storage/webdav.js

export default class WebdavStorage {
    constructor(config) {
        // 移除 URL 结尾的斜杠，确保路径拼接正确
        this.url = config.url ? config.url.replace(/\/$/, '') : '';
        this.username = config.username || '';
        this.password = config.password || '';
        // 标记此存储为 WebDAV，以便 data.js 在移动/重命名时执行物理操作
        this.isWebDAV = true;
    }

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
     * @param {number} folderId - (未使用)
     * @param {object} config - (未使用)
     * @param {string} folderPath - 相对路径 (例如 "Docs/Work/")
     */
    async upload(fileStream, fileName, type, userId, folderId, config, folderPath = '') {
        // 构造物理存储路径: /userId/folderPath/fileName
        // 注意 folderPath 通常以 / 结尾，或者为空
        const storagePath = `/${userId}/${folderPath}${fileName}`;

        // 确保根目录存在 (简化的容错处理，尝试创建用户根目录)
        await this._request('MKCOL', `/${userId}`).catch(() => {});

        // 注意：WebDAV 标准要求父目录必须存在才能上传文件。
        // 这里假设 data.js 中的 createFolder 逻辑已经调用 createDir 保证了目录结构的存在。
        
        const response = await this._request('PUT', storagePath, {
            'Content-Type': type || 'application/octet-stream'
        }, fileStream);

        if (!response.ok) {
            throw new Error(`WebDAV 上传失败: ${response.status} ${response.statusText}`);
        }

        return {
            fileId: storagePath, // 数据库将保存这个完整路径
            thumbId: null
        };
    }

    /**
     * 创建物理目录
     * @param {string} folderPath - 相对路径 (例如 "A/B/")
     * @param {number} userId - 用户ID
     */
    async createDir(folderPath, userId) {
        // folderPath 可能包含多级，例如 "Parent/Child/"
        const parts = folderPath.split('/').filter(p => p);
        let currentPath = `/${userId}`;

        // 确保用户根目录存在
        await this._request('MKCOL', currentPath).catch(() => {});

        // 递归检查/创建每一级目录
        for (const part of parts) {
            currentPath += `/${part}`;
            // 忽略已存在错误 (405 Method Not Allowed)
            await this._request('MKCOL', currentPath).catch(() => {});
        }
    }

    /**
     * 下载文件
     * @param {string} fileId - 存储在数据库中的完整路径
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
     * @param {Array} files - 文件对象列表
     * @param {Array} folders - 文件夹对象列表 (包含 path 属性)
     * @param {number} userId - 用户ID
     */
    async remove(files, folders, userId) {
        // 合并处理，优先处理文件
        const items = [...(files || [])];

        // 处理文件删除
        for (const item of items) {
            // file_id 存储的是 WebDAV 完整路径
            let pathToDelete = item.file_id;
            if (pathToDelete) {
                try {
                    await this._request('DELETE', pathToDelete);
                } catch (e) {
                    console.warn(`WebDAV 删除文件失败 (${pathToDelete}):`, e.message);
                }
            }
        }

        // 处理文件夹删除 (WebDAV DELETE 通常支持递归删除)
        if (folders) {
            for (const folder of folders) {
                // data.js 传递过来的 folders 应该包含计算好的 path
                if (folder.path) {
                    // 确保路径以 /userId 开头，或者由调用方传递完整路径
                    // data.js 中的 getFolderPhysicalPath 返回的是完整路径 (/${userId}/...)
                    // 如果传入的是完整路径：
                    const fullPath = folder.path.startsWith('/') ? folder.path : `/${userId}/${folder.path}`;
                    try {
                        await this._request('DELETE', fullPath);
                    } catch (e) {
                        console.warn(`WebDAV 删除目录失败 (${fullPath}):`, e.message);
                    }
                }
            }
        }
    }

    /**
     * 移动或重命名文件/文件夹 (WebDAV MOVE)
     * @param {string} oldPath - 原路径
     * @param {string} newPath - 新路径
     */
    async moveFile(oldPath, newPath) {
        // Destination Header 必须是完整的绝对 URL
        const destPath = newPath.startsWith('/') ? newPath : '/' + newPath;
        const encodedDestPath = destPath.split('/').map(encodeURIComponent).join('/');
        const destinationUrl = this.url + encodedDestPath;

        const response = await this._request('MOVE', oldPath, {
            'Destination': destinationUrl,
            'Overwrite': 'T' // 允许覆盖
        });

        if (!response.ok) {
            // 如果是 404，可能是数据库有记录但物理文件已丢失，可以选择忽略或抛出
            if (response.status !== 404) {
                throw new Error(`WebDAV 移动失败: ${response.status} ${response.statusText}`);
            }
        }
    }

    /**
     * 列出目录内容 (PROPFIND)
     * 用于扫描导入功能
     */
    async list(prefix = '/') {
        // WebDAV 使用 PROPFIND 方法列出目录
        const response = await this._request('PROPFIND', prefix, {
            'Depth': '1'
        });

        if (!response.ok) {
            // 如果目录不存在，返回空列表
            if (response.status === 404) return [];
            throw new Error(`WebDAV List 失败: ${response.status}`);
        }
        
        const text = await response.text();

        // 简单正则解析 XML (提取 href 和 contentlength)
        // 注意: 这种解析适用于简单场景。
        const contents = [];
        // 兼容常见的 D: 或 R: 命名空间
        const responses = text.split(/<\/[a-zA-Z0-9]+:response>/);
        
        for (const resp of responses) {
            if (!resp.match(/<[a-zA-Z0-9]+:response/)) continue;
            
            const hrefMatch = resp.match(/<[a-zA-Z0-9]+:href>(.*?)<\/[a-zA-Z0-9]+:href>/);
            const sizeMatch = resp.match(/<[a-zA-Z0-9]+:getcontentlength>(\d+)<\/[a-zA-Z0-9]+:getcontentlength>/);
            // 检查是否为文件夹 (通常包含 <collection/> 标签)
            const isCollection = resp.match(/<[a-zA-Z0-9]+:collection\/>/);
            
            if (hrefMatch && !isCollection) { // 只处理文件
                let rawPath = hrefMatch[1];
                try { rawPath = decodeURIComponent(rawPath); } catch(e){}
                
                // WebDAV 返回的 href 通常包含服务器的 path 前缀，
                // 实际使用中可能需要根据具体 WebDAV 服务器的行为进行路径清洗。
                // 这里直接作为 ID 返回，由 scan 逻辑进行比对。
                
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
