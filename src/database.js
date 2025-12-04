// src/database.js
import { INIT_SQL } from './schema.js';

export default class Database {
    /**
     * @param {D1Database} d1 - Cloudflare D1 绑定对象
     */
    constructor(d1) {
        this.d1 = d1;
    }

    /**
     * 获取单行数据
     * @param {string} sql - SQL 查询语句
     * @param {Array} params - 查询参数
     */
    async get(sql, params = []) {
        const stmt = this.d1.prepare(sql).bind(...params);
        return await stmt.first();
    }

    /**
     * 获取多行数据
     * @param {string} sql - SQL 查询语句
     * @param {Array} params - 查询参数
     */
    async all(sql, params = []) {
        const stmt = this.d1.prepare(sql).bind(...params);
        const { results } = await stmt.all();
        return results || [];
    }

    /**
     * 执行写入操作 (INSERT, UPDATE, DELETE)
     * @param {string} sql - SQL 语句
     * @param {Array} params - 参数
     */
    async run(sql, params = []) {
        const stmt = this.d1.prepare(sql).bind(...params);
        return await stmt.run();
    }

    /**
     * 执行原始 SQL (通常用于批量执行或不带参数的语句)
     * @param {string} sql 
     */
    async exec(sql) {
        return await this.d1.exec(sql);
    }

    /**
     * 初始化数据库表结构
     */
    async initDB() {
        try {
            await this.d1.exec(INIT_SQL);
            return { success: true, message: "数据库表结构已初始化" };
        } catch (error) {
            console.error("数据库初始化失败:", error);
            throw new Error(`数据库初始化失败: ${error.message}`);
        }
    }
}
