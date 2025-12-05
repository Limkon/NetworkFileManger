import { AwsClient } from 'aws4fetch';

export class S3Storage {
    constructor(config) {
        this.config = config;
        this.isR2Binding = config.isR2Binding; // 特殊标志：是否为 R2 绑定
        
        if (this.isR2Binding) {
            this.bucket = config.bucket; // R2 绑定对象
        } else {
            // 标准 S3 / R2 API 配置
            this.client = new AwsClient({
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
                service: 's3',
                region: config.region || 'auto',
            });
            this.endpoint = config.endpoint;
            this.bucketName = config.bucketName;
            this.publicUrl = config.publicUrl;
        }
    }

    async upload(file, fileName, contentType, userId, folderId) {
        const key = `${userId}/${folderId}/${fileName}`; // 简单的路径结构
        
        if (this.isR2Binding) {
            await this.bucket.put(key, file, {
                httpMetadata: { contentType: contentType }
            });
        } else {
            const url = `${this.endpoint}/${this.bucketName}/${encodeURIComponent(key)}`;
            await this.client.fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': contentType },
                body: file
            });
        }

        return {
            fileId: key, // S3 Key 作为 fileId
            thumbId: null
        };
    }

    async download(fileId, userId) {
        // fileId 即为 S3 Key
        if (this.isR2Binding) {
            const object = await this.bucket.get(fileId);
            if (!object) throw new Error('File not found in R2');
            
            return {
                stream: object.body,
                contentType: object.httpMetadata?.contentType || 'application/octet-stream',
                headers: {
                    'Content-Length': object.size,
                    'ETag': object.etag
                }
            };
        } else {
            const url = `${this.endpoint}/${this.bucketName}/${encodeURIComponent(fileId)}`;
            const res = await this.client.fetch(url, { method: 'GET' });
            if (!res.ok) throw new Error(`S3 Download Error: ${res.status}`);
            
            return {
                stream: res.body,
                contentType: res.headers.get('Content-Type'),
                headers: {
                    'Content-Length': res.headers.get('Content-Length'),
                    'ETag': res.headers.get('ETag')
                }
            };
        }
    }

    async remove(files, folders, userId) {
        // 批量删除文件
        const keysToDelete = files.map(f => f.file_id);
        
        // 简单的逐个删除实现 (R2 binding 支持 delete(key))
        if (this.isR2Binding) {
            for (const key of keysToDelete) {
                await this.bucket.delete(key);
            }
        } else {
            // S3 API 逐个删除 (生产环境建议使用 DeleteObjects XML 批量删除)
            for (const key of keysToDelete) {
                const url = `${this.endpoint}/${this.bucketName}/${encodeURIComponent(key)}`;
                await this.client.fetch(url, { method: 'DELETE' });
            }
        }
    }

    async list(prefix) {
        // 用于扫描导入功能
        if (this.isR2Binding) {
            const listed = await this.bucket.list({ prefix: prefix });
            return listed.objects.map(obj => ({
                fileId: obj.key,
                size: obj.size,
                updatedAt: obj.uploaded
            }));
        } else {
            // 标准 S3 ListObjectsV2 实现略复杂，这里简化处理或暂不支持
            // 如果需要支持 S3 导入，需要解析 XML 响应
            console.warn("标准 S3 模式下的 List 功能尚未完全实现 XML 解析");
            return [];
        }
    }
}
