{
type: "file_content_update",
fileName: "limkon/networkfilemanger/NetworkFileManger-ff9f914d786efd7cd80c55485f0fe871f93b3f13/src/storage/s3.js",
fullContent: `// src/storage/s3.js
import { AwsClient } from 'aws4fetch';

export default class S3Storage {
    constructor(config) {
        this.bucket = config.bucket;
        this.region = config.region || 'auto';
        this.endpoint = config.endpoint || \`https://s3.\${this.region}.amazonaws.com\`;
        
        // 确保 endpoint 不带结尾斜杠
        if (this.endpoint.endsWith('/')) {
            this.endpoint = this.endpoint.slice(0, -1);
        }

        // 初始化 AwsClient
        this.client = new AwsClient({
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
            region: this.region,
            service: 's3'
        });

        // 构造 Bucket 基础 URL
        this.bucketUrl = \`\${this.endpoint}/\${this.bucket}\`;
    }

    _normalizeKey(key) {
        return key.startsWith('/') ? key.slice(1) : key;
    }

    async upload(fileStream, fileName, type, userId) {
        // 构造存储路径: userId/fileName
        const key = \`\${userId}/\${fileName}\`;
        const normalizedKey = this._normalizeKey(key);
        const url = \`\${this.bucketUrl}/\${encodeURIComponent(normalizedKey)}\`;

        const response = await this.client.fetch(url, {
            method: 'PUT',
            headers: {
                'Content-Type': type || 'application/octet-stream'
            },
            body: fileStream
        });

        if (!response.ok) {
            throw new Error(\`S3 上传失败: \${response.status} \${response.statusText}\`);
        }

        return {
            fileId: key, 
            thumbId: null
        };
    }

    async download(fileId) {
        const normalizedKey = this._normalizeKey(fileId);
        const url = \`\${this.bucketUrl}/\${encodeURIComponent(normalizedKey)}\`;

        const response = await this.client.fetch(url, {
            method: 'GET'
        });

        if (!response.ok) {
            throw new Error(\`S3 下载失败: \${response.status} \${response.statusText}\`);
        }

        return {
            stream: response.body,
            contentType: response.headers.get('content-type'),
            headers: {
                'Content-Length': response.headers.get('content-length'),
                'ETag': response.headers.get('etag'),
                'Last-Modified': response.headers.get('last-modified')
            }
        };
    }

    async remove(files, folders) {
        const items = [...(files || [])];
        const deletePromises = items.map(async (item) => {
            const fileId = item.file_id || item.path; 
            if (!fileId) return;

            const normalizedKey = this._normalizeKey(fileId);
            const url = \`\${this.bucketUrl}/\${encodeURIComponent(normalizedKey)}\`;
            
            try {
                await this.client.fetch(url, { method: 'DELETE' });
            } catch (e) {
                console.warn(\`S3 删除失败 (\${fileId}):\`, e.message);
            }
        });

        await Promise.all(deletePromises);
    }

    async moveFile(oldPath, newPath) {
        const sourceKey = this._normalizeKey(oldPath);
        const destKey = this._normalizeKey(newPath);
        const copySource = \`/\${this.bucket}/\${sourceKey}\`; 
        const destUrl = \`\${this.bucketUrl}/\${encodeURIComponent(destKey)}\`;
        const copySourceHeader = encodeURI(copySource);

        const copyRes = await this.client.fetch(destUrl, {
            method: 'PUT',
            headers: {
                'x-amz-copy-source': copySourceHeader
            }
        });

        if (!copyRes.ok) {
            throw new Error(\`S3 移动(复制)失败: \${copyRes.status} \${copyRes.statusText}\`);
        }

        const oldUrl = \`\${this.bucketUrl}/\${encodeURIComponent(sourceKey)}\`;
        const delRes = await this.client.fetch(oldUrl, { method: 'DELETE' });

        if (!delRes.ok) {
            console.warn(\`S3 移动(删除旧文件)失败: \${oldPath}\`);
        }
    }

    /**
     * 列出文件 (List Objects V2)
     * @param {string} prefix - 前缀 (通常是 userId/)
     */
    async list(prefix = '') {
        const normalizedPrefix = this._normalizeKey(prefix);
        const url = \`\${this.bucketUrl}?list-type=2&prefix=\${encodeURIComponent(normalizedPrefix)}\`;

        const response = await this.client.fetch(url, { method: 'GET' });
        if (!response.ok) throw new Error(\`S3 List 失败: \${response.status}\`);

        const text = await response.text();
        
        // 简单 XML 解析 (Workers 中没有 DOMParser，使用正则提取)
        // 注意: 这只是一个简单的实现，对于非常大的 bucket 可能需要处理分页 (NextContinuationToken)
        const contents = [];
        const regex = /<Key>(.*?)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>/g;
        let match;
        
        while ((match = regex.exec(text)) !== null) {
            contents.push({
                fileId: match[1], // Key
                size: parseInt(match[2]),
                updatedAt: Date.now() // S3 XML LastModified 格式较复杂，这里简化
            });
        }
        
        return contents;
    }
}`
}
