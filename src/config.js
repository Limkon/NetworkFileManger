// src/config.js

export default class ConfigManager {
    constructor(kv) {
        this.kv = kv;
        this.cache = null;
    }

    async load() {
        // 簡單內存緩存，避免單次請求重複讀取 KV
        if (this.cache) return this.cache;
        
        try {
            // 從 KV 獲取配置
            const data = await this.kv.get('app_config', 'json');
            
            // 如果 KV 為空，返回默認配置結構
            this.cache = data || {
                storageMode: 'local', // 默認模式 (注意：Worker 本地存儲不持久，建議盡快配置 S3)
                s3: {},
                webdav: {}
            };
        } catch (e) {
            console.error("Config load failed", e);
            // 發生錯誤時返回空對象防止崩潰
            this.cache = {};
        }
        return this.cache;
    }

    async save(newConfig) {
        const current = await this.load();
        // 合併新舊配置
        const updated = { ...current, ...newConfig };
        
        // 寫入 KV
        await this.kv.put('app_config', JSON.stringify(updated));
        
        // 更新緩存
        this.cache = updated;
    }
}
