// src/config.js

// 定義在 KV 中存儲配置的鍵名
const CONFIG_KEY = 'system_config';

export default class ConfigManager {
    /**
     * @param {KVNamespace} kv - Cloudflare KV 綁定對象
     */
    constructor(kv) {
        this.kv = kv;
        // 簡單的內存緩存，減少 KV 讀取費用 (Cloudflare Workers 實例重啟前有效)
        this.cachedConfig = null;
    }

    /**
     * 加載配置
     * 優先從內存獲取，否則從 KV 讀取並合併默認值
     */
    async load() {
        if (this.cachedConfig) {
            return this.cachedConfig;
        }

        try {
            // 從 KV 獲取配置，指定類型為 json
            const data = await this.kv.get(CONFIG_KEY, 'json');
            
            // 默認配置結構
            const defaults = {
                storageMode: 'telegram', // 默認存儲模式
                uploadMode: 'stream',    // Workers 強制使用流式上傳
                webdav: {},              // WebDAV 配置對象
                s3: {}                   // S3 配置對象
            };

            // 合併配置：默認值 < KV數據
            this.cachedConfig = { ...defaults, ...(data || {}) };
            
            // 強制覆蓋 uploadMode，因為 Workers 不支持本地磁盤緩衝
            this.cachedConfig.uploadMode = 'stream';

            return this.cachedConfig;
        } catch (error) {
            console.error('加載配置失敗:', error);
            // 發生錯誤時返回安全默認值
            return {
                storageMode: 'telegram',
                uploadMode: 'stream',
                webdav: {},
                s3: {}
            };
        }
    }

    /**
     * 保存配置
     * @param {Object} newConfig - 要更新的配置片段
     */
    async save(newConfig) {
        try {
            // 先獲取當前完整配置
            const current = await this.load();
            
            // 合併新舊配置
            const merged = { ...current, ...newConfig };
            
            // 寫入 KV
            await this.kv.put(CONFIG_KEY, JSON.stringify(merged));
            
            // 更新內存緩存
            this.cachedConfig = merged;
            
            return true;
        } catch (error) {
            console.error('保存配置失敗:', error);
            return false;
        }
    }
}
