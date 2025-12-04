// src/storage/s3.js
import { AwsClient } from 'aws4fetch';

export default class S3Storage {
    constructor(config) {
        this.type = 's3';
        this.bucket = config.bucket;
        this.region = config.region || 'auto';
        this.endpoint = config.endpoint; // 可選，用於 R2/MinIO
        this.accessKeyId = config.accessKeyId;
        this.secretAccessKey = config.secretAccessKey;

        if (!this.bucket || !this.accessKeyId || !this.secretAccessKey) {
            console.warn('S3 存儲配置不完整，部分功能可能無法使用');
        }

        // 初始化 aws4fetch 客戶端
        this.client = new AwsClient({
            accessKeyId: this.accessKeyId,
            secretAccessKey: this.secretAccessKey,
            region: this.region,
            service: 's3',
        });
    }

    /**
     * 兼容 data.js 的 getClient 調用習慣
     */
    getClient() {
        return this;
    }

    /**
     * 構建完整的對象 URL
     */
    getUrl(path) {
        // 去除開頭的 /
        const cleanPath = path.startsWith('/') ? path.slice(1) : path;

        if (this.endpoint) {
            // 自定義 Endpoint (如 R2, MinIO)
            // 格式通常為: https://endpoint/bucket/key
            const baseUrl = this.endpoint.endsWith('/') ? this.endpoint.slice(0, -1) : this.endpoint;
            return `${baseUrl}/${this.bucket}/${cleanPath}`;
        } else {
            // 標準 AWS S3
            // 格式: https://bucket.s3.region.amazonaws.com/key
            return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${cleanPath}`;
        }
    }

    /**
     * 上傳文件 (PUT)
     */
    async upload(fileStream, fileName, mimeType, userId, folderId, config) {
        // 生成存儲鍵名，例如: user_123/myphoto.jpg
        // 你可以根據需求調整目錄結構
        const key = `user_${userId}/${fileName}`;
        const url = this.getUrl(key);

        const response = await this.client.fetch(url, {
            method: 'PUT',
            headers: {
                'Content-Type': mimeType || 'application/octet-stream',
                // 可選：添加 ACL 或其他元數據
                // 'x-amz-acl': 'private'
            },
            body: fileStream // aws4fetch 支持 ReadableStream
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`S3 Upload Failed: ${response.status} ${err}`);
        }

        return {
            fileId: key, // S3 中使用 Key 作為 ID
        };
    }

    /**
     * 下載文件 (GET)
     */
    async download(fileId) {
        const url = this.getUrl(fileId);
        const response = await this.client.fetch(url, {
            method: 'GET'
        });

        if (!response.ok) {
            throw new Error(`S3 Download Failed: ${response.status}`);
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
     * 刪除文件 (DELETE)
     * 支持批量刪除
     */
    async remove(files, folders, userId) {
        const items = [...(files || []), ...(folders || [])];
        
        // 為了通用性（兼容不支持 DeleteObjects XML 的端點），這裡使用並發的單個 DELETE
        // Cloudflare Workers 的並發請求能力很強
        await Promise.all(items.map(async (item) => {
            // 兼容 file_id 或 path
            const key = item.file_id || item.path; 
            if (!key) return;
            
            // 忽略虛擬文件夾（沒有物理 key 的文件夾）
            if (item.type === 'folder' && !item.file_id) return;

            const url = this.getUrl(key);
            try {
                await this.client.fetch(url, { method: 'DELETE' });
            } catch (e) {
                console.error(`S3 Delete Failed (${key}):`, e);
            }
        }));
    }

    /**
     * 移動/重命名文件 (Copy + Delete)
     * S3 不支持直接 Rename，需要先 Copy Object 再 Delete Object
     */
    async moveFile(oldPath, newPath) {
        const destUrl = this.getUrl(newPath);
        
        // 構建 Copy Source 頭部：/bucket/key
        // 必須進行 URL 編碼
        const cleanOldPath = oldPath.startsWith('/') ? oldPath.slice(1) : oldPath;
        const copySource = `/${this.bucket}/${cleanOldPath}`;
        
        // 1. 複製對象
        const copyRes = await this.client.fetch(destUrl, {
            method: 'PUT',
            headers: {
                'x-amz-copy-source': encodeURI(copySource)
            }
        });

        if (!copyRes.ok) {
            const err = await copyRes.text();
            throw new Error(`S3 Move (Copy) Failed: ${copyRes.status} ${err}`);
        }

        // 2. 刪除舊對象
        const delUrl = this.getUrl(oldPath);
        const delRes = await this.client.fetch(delUrl, { method: 'DELETE' });
        
        if (!delRes.ok) {
            console.warn(`S3 Move (Delete Old) Failed: ${delRes.status}. File copied but old one remains.`);
        }
    }
    
    // 兼容 WebDAV 接口的 createDirectory（S3 不需要顯式創建目錄，留空即可）
    async createDirectory(path) {
        return true;
    }
}
