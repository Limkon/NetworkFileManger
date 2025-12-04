import { initSQL } from './schema.js';

export default class Database {
    constructor(d1) {
        this.d1 = d1;
    }

    async initDB() {
        // 修复方案：手动分割 SQL 语句并逐条执行，避免 D1 exec() 方法的内部 Bug
        if (!initSQL) return;

        // 1. 移除注释 (简单处理，移除 -- 开头的行)
        const cleanSQL = initSQL.replace(/--.*$/gm, '');

        // 2. 按分号分割语句
        const statements = cleanSQL
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0);

        console.log(`Initializing DB with ${statements.length} statements...`);

        // 3. 逐条执行
        for (const sql of statements) {
            try {
                await this.d1.prepare(sql).run();
            } catch (e) {
                // 忽略 "表已存在" 等非致命错误，或者打印出来排查
                console.warn("SQL Execution Warning:", e.message, "SQL:", sql.substring(0, 50));
            }
        }
        
        console.log("Database initialized successfully.");
    }

    // 封装 get 方法 (查询单条)
    async get(sql, params = []) {
        const stmt = this.d1.prepare(sql).bind(...params);
        return await stmt.first();
    }

    // 封装 all 方法 (查询多条)
    async all(sql, params = []) {
        const stmt = this.d1.prepare(sql).bind(...params);
        const { results } = await stmt.all();
        return results || [];
    }

    // 封装 run 方法 (插入/更新/删除)
    async run(sql, params = []) {
        const stmt = this.d1.prepare(sql).bind(...params);
        return await stmt.run();
    }
}
