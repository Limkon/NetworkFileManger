// src/storage/telegram.js

export default class TelegramStorage {
    constructor(token, chatId) {
        this.token = token;
        this.chatId = chatId;
        this.apiBase = `https://api.telegram.org/bot${token}`;
    }

    /**
     * 上传文件到 Telegram
     * @param {ReadableStream|File} fileStream - 文件流或文件对象
     * @param {string} fileName - 文件名
     * @returns {Promise<{fileId: string}>}
     */
    async upload(fileStream, fileName) {
        if (!this.token || !this.chatId) {
            throw new Error('未配置 Telegram Bot Token 或 Chat ID');
        }

        // 构造 FormData
        const formData = new FormData();
        formData.append('chat_id', this.chatId);
        
        // 在 Cloudflare Workers 中，fileStream 通常是从 request.parseBody() 获取的 File 对象
        // 如果是纯 Stream，需要构造一个 Response 包装成 Blob (因为 FormData 接受 Blob/File)
        if (fileStream instanceof File) {
            formData.append('document', fileStream, fileName);
        } else {
            // 如果传入的是原始 ReadableStream，尝试转为 Blob (注意内存限制)
            // 对于大文件，建议确保传入的是 File 对象 (Hono 自动处理)
            const blob = await new Response(fileStream).blob();
            formData.append('document', blob, fileName);
        }

        const response = await fetch(`${this.apiBase}/sendDocument`, {
            method: 'POST',
            body: formData
        });

        const result = await response.json();

        if (!result.ok) {
            throw new Error(`Telegram 上传失败: ${result.description}`);
        }

        // 获取最佳质量的文件 ID (通常是 document 对象)
        const doc = result.result.document;
        if (!doc) {
            throw new Error('上传成功但未返回文档对象');
        }

        return {
            fileId: doc.file_id,
            size: doc.file_size
        };
    }

    /**
     * 下载文件
     * @param {string} fileId - Telegram 文件 ID
     * @returns {Promise<{stream: ReadableStream, contentType: string}>}
     */
    async download(fileId) {
        // 1. 获取文件路径
        const pathResponse = await fetch(`${this.apiBase}/getFile?file_id=${fileId}`);
        const pathResult = await pathResponse.json();

        if (!pathResult.ok) {
            throw new Error(`获取文件路径失败: ${pathResult.description}`);
        }

        const filePath = pathResult.result.file_path;
        const downloadUrl = `https://api.telegram.org/file/bot${this.token}/${filePath}`;

        // 2. 下载文件流
        const fileResponse = await fetch(downloadUrl);
        if (!fileResponse.ok) {
            throw new Error(`文件下载失败: ${fileResponse.statusText}`);
        }

        return {
            stream: fileResponse.body,
            contentType: fileResponse.headers.get('content-type') || 'application/octet-stream',
            headers: {
                'Content-Length': fileResponse.headers.get('content-length')
            }
        };
    }

    /**
     * 删除文件 (即删除消息)
     * @param {Array} files - 文件对象列表 [{message_id: ...}]
     */
    async remove(files) {
        // Telegram API 不支持直接通过 file_id 删除，只能删除消息
        // 我们假设数据库中存储的 message_id 对应 Telegram 的 message_id
        if (!files || files.length === 0) return;

        for (const file of files) {
            // message_id 在数据库存为字符串或 BigInt，需转为 int
            const msgId = parseInt(file.message_id); 
            if (isNaN(msgId)) continue;

            try {
                await fetch(`${this.apiBase}/deleteMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: this.chatId,
                        message_id: msgId
                    })
                });
            } catch (e) {
                console.warn(`删除 Telegram 消息 ${msgId} 失败:`, e);
                // 忽略删除失败，可能是消息太久远或已被删除
            }
        }
    }
}
