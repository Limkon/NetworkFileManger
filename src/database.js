// src/database.js
import { INIT_SQL } from './schema.js';

export default class Database {
    /**
     * @param {D1Database} d1 - Cloudflare D1 綁定對象
     */
    constructor(d1) {
        this.d1 = d1;
    }

    /**
     * 獲取單行數據
     * @param {string} sql - SQL 查詢語句
     * @param {Array} params - 查詢參數
     */
    async get(sql, params = []) {
        const stmt = this.d1.prepare(sql).bind(...params);
        return await stmt.first();
    }

    /**
     * 獲取多行數據
     * @param {string} sql - SQL 查詢語句
     * @param {Array} params - 查詢參數
     */
    async all(sql, params = []) {
        const stmt = this.d1.prepare(sql).bind(...params);
        const { results } = await stmt.all();
        return results || [];
    }

    /**
     * 執行寫入操作 (INSERT, UPDATE, DELETE)
     * @param {string} sql - SQL 語句
     * @param {Array} params - 參數
     */
    async run(sql, params = []) {
        const stmt = this.d1.prepare(sql).bind(...params);
        return await stmt.run();
    }

    /**
     * 執行原始 SQL (通常用於批量執行或不帶參數的語句)
     * @param {string} sql 
     */
    async exec(sql) {
        return await this.d1.exec(sql);
    }

    /**
     * 初始化數據庫表結構
     */
    async initDB() {
        try {
            await this.d1.exec(INIT_SQL);
            return { success: true, message: "數據庫表結構已初始化" };
        } catch (error) {
            console.error("數據庫初始化失敗:", error);
            throw new Error(`數據庫初始化失敗: ${error.message}`);
        }
    }
}
