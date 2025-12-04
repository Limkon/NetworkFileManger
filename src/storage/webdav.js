// src/storage/webdav.js

export default class WebdavStorage {
    constructor(config) {
        this.type = 'webdav';
        this.url = config.url;
        this.username = config.username;
        this.password = config.password;

        if (!this.url) throw new Error('WebDAV URL 未配置');
        
        // 確保 URL 結尾沒有 /
        if (this.url.endsWith('/')) {
            this.url = this.url.slice(0, -1);
        }

        // 構建 Basic Auth 頭
        const creds = btoa(`${this.username}:${this.password}`);
        this.authHeader = { 'Authorization': `Basic ${creds}` };
    }

    /**
     * 獲取底層客戶端 (兼容 data.js 調用習慣)
     * 在這個自定義實現中，client 就是 this
     */
    getClient() {
        return this;
    }

    /**
     * 上傳文件 (PUT)
     */
    async upload(fileStream, fileName, mimeType, userId, folderId, config) {
        // 構建遠程路徑： /userId/fileName
        // 你可以根據需要自定義目錄結構，這裡保持與原邏輯類似的結構
        const remoteDir = `/${userId}`;
        const remotePath = `${remoteDir}/${fileName}`;

        // 1. 確保用戶目錄存在 (MKCOL)
        // 為了性能，可以選擇不每次都檢查，或者依賴錯誤重試
        await this.createDirectory(remoteDir).catch(() => {}); 

        // 2. 上傳文件
        const fullUrl = this.url + remotePath.split('/').map(encodeURIComponent).join('/');
        
        const response = await fetch(fullUrl, {
            method: 'PUT',
            headers: {
                ...this.authHeader,
                'Content-Type': mimeType || 'application/octet-stream',
            },
            body: fileStream // fetch 支持 ReadableStream
        });

        if (!response.ok) {
            throw new Error(`WebDAV Upload Failed: ${response.status} ${response.statusText}`);
        }

        return {
            fileId: remotePath, // WebDAV 使用路徑作為 ID
        };
    }

    /**
     * 下載文件 (GET)
     */
    async download(fileId) {
        // fileId 是相對路徑 (例如 /1/photo.jpg)
        const fullUrl = this.url + fileId.split('/').map(encodeURIComponent).join('/');
        
        const response = await fetch(fullUrl, {
            method: 'GET',
            headers: {
                ...this.authHeader
            }
        });

        if (!response.ok) {
            throw new Error(`WebDAV Download Failed: ${response.status}`);
        }

        return {
            stream: response.body,
            contentType: response.headers.get('content-type'),
            headers: {
                'Content-Length': response.headers.get('content-length')
            }
        };
    }

    /**
     * 移動/重命名文件 (MOVE)
     * @param {string} oldPath - 舊的相對路徑
     * @param {string} newPath - 新的相對路徑
     */
    async moveFile(oldPath, newPath) {
        const sourceUrl = this.url + oldPath.split('/').map(encodeURIComponent).join('/');
        const destUrl = this.url + newPath.split('/').map(encodeURIComponent).join('/');
        
        const response = await fetch(sourceUrl, {
            method: 'MOVE',
            headers: {
                ...this.authHeader,
                'Destination': destUrl,
                'Overwrite': 'T'
            }
        });

        // 201 Created 或 204 No Content 都表示成功
        if (!response.ok && response.status !== 201 && response.status !== 204) {
            throw new Error(`WebDAV Move Failed: ${response.status}`);
        }
    }

    /**
     * 刪除文件 (DELETE)
     * 兼容 unifiedDelete 的調用：remove(files, folders, userId)
     */
    async remove(files, folders, userId) {
        const items = [...(files || []), ...(folders || [])];
        
        // WebDAV 刪除通常是串行的，或者你可以用 Promise.all 並發
        // 這裡 file.file_id 存儲的是 WebDAV 的路徑
        await Promise.all(items.map(async (item) => {
            const path = item.file_id || item.path; // 兼容不同結構
            if (!path) return;

            // 確保路徑以 / 開頭
            const normalizedPath = path.startsWith('/') ? path : `/${path}`;
            const fullUrl = this.url + normalizedPath.split('/').map(encodeURIComponent).join('/');

            try {
                await fetch(fullUrl, {
                    method: 'DELETE',
                    headers: { ...this.authHeader }
                });
            } catch (e) {
                console.error(`WebDAV Delete Error (${path}):`, e);
            }
        }));
    }

    /**
     * 創建目錄 (MKCOL)
     */
    async createDirectory(path) {
        const normalizedPath = path.startsWith('/') ? path : `/${path}`;
        const fullUrl = this.url + normalizedPath.split('/').map(encodeURIComponent).join('/');
        
        const response = await fetch(fullUrl, {
            method: 'MKCOL',
            headers: { ...this.authHeader }
        });

        if (!response.ok && response.status !== 405) { 
            // 405 Method Not Allowed 通常意味著目錄已存在
            throw new Error(`WebDAV MKCOL Failed: ${response.status}`);
        }
    }
}
