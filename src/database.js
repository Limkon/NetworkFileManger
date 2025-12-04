// src/database.js
import { initSQL } from './schema.js';

export default class Database {
    constructor(d1) {
        this.d1 = d1;
    }

    async initDB() {
        // D1 的 exec 方法允許執行多條 SQL 語句
        try {
            await this.d1.exec(initSQL);
            console.log("Database initialized successfully.");
        } catch (e) {
            console.error("Database initialization failed:", e);
            throw e;
        }
    }

    // 封裝 get 方法 (查詢單條)
    async get(sql, params = []) {
        const stmt = this.d1.prepare(sql).bind(...params);
        return await stmt.first();
    }

    // 封裝 all 方法 (查詢多條)
    async all(sql, params = []) {
        const stmt = this.d1.prepare(sql).bind(...params);
        const { results } = await stmt.all();
        return results || [];
    }

    // 封裝 run 方法 (插入/更新/刪除)
    async run(sql, params = []) {
        const stmt = this.d1.prepare(sql).bind(...params);
        return await stmt.run();
    }
}
