// database.js

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
require('dotenv').config();

const dbPath = path.join(__dirname, 'data', 'database.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("致命错误：连接资料库失败！", err.message);
        return;
    }
    createTables();
});

function createTables() {
    db.serialize(() => {
        // 既有的 users 表
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            is_admin INTEGER DEFAULT 0,
            max_storage_bytes INTEGER DEFAULT 1073741824
        )`, (err) => {
            if (err) { return; }
            
            db.all("PRAGMA table_info(users)", (pragmaErr, columns) => {
                if (!pragmaErr && !columns.some(col => col.name === 'max_storage_bytes')) {
                    db.run("ALTER TABLE users ADD COLUMN max_storage_bytes INTEGER DEFAULT 1073741824");
                }
            });

            createDependentTables();
        });

        // --- 新增：系统配置 KV 表 ---
        db.run(`CREATE TABLE IF NOT EXISTS system_config (
            key TEXT PRIMARY KEY,
            value TEXT
        )`);
    });
}

function createDependentTables() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            parent_id INTEGER,
            user_id INTEGER NOT NULL,
            share_token TEXT,
            share_expires_at INTEGER,
            password TEXT,
            share_password TEXT,
            is_deleted INTEGER DEFAULT 0,
            deleted_at INTEGER,
            FOREIGN KEY (parent_id) REFERENCES folders (id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
            UNIQUE(name, parent_id, user_id)
        )`, (err) => {
            if (err) { return; }

            db.all("PRAGMA table_info(folders)", (pragmaErr, columns) => {
                if (pragmaErr) return;

                if (!columns.some(col => col.name === 'share_password')) {
                    db.run("ALTER TABLE folders ADD COLUMN share_password TEXT");
                }
                if (!columns.some(col => col.name === 'is_deleted')) {
                    db.run("ALTER TABLE folders ADD COLUMN is_deleted INTEGER DEFAULT 0");
                    db.run("ALTER TABLE folders ADD COLUMN deleted_at INTEGER");
                }
                createFilesTable();
            });
        });
    });
}

function createFilesTable() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS files (
            message_id INTEGER PRIMARY KEY,
            fileName TEXT NOT NULL,
            mimetype TEXT,
            file_id TEXT NOT NULL,
            thumb_file_id TEXT,
            size INTEGER,
            date INTEGER NOT NULL,
            share_token TEXT,
            share_expires_at INTEGER,
            folder_id INTEGER NOT NULL DEFAULT 1,
            user_id INTEGER NOT NULL,
            storage_type TEXT NOT NULL DEFAULT 'telegram',
            share_password TEXT,
            is_deleted INTEGER DEFAULT 0,
            deleted_at INTEGER,
            UNIQUE(fileName, folder_id, user_id),
            FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`, (err) => {
            if (err) { return; }

            db.all("PRAGMA table_info(files)", (pragmaErr, columns) => {
                if (pragmaErr) return;

                if (!columns.some(col => col.name === 'share_password')) {
                    db.run("ALTER TABLE files ADD COLUMN share_password TEXT");
                }
                if (!columns.some(col => col.name === 'is_deleted')) {
                    db.run("ALTER TABLE files ADD COLUMN is_deleted INTEGER DEFAULT 0");
                    db.run("ALTER TABLE files ADD COLUMN deleted_at INTEGER");
                }
                createAuthTokenTable();
            });
        });
    });
}

function createAuthTokenTable() {
    db.run(`CREATE TABLE IF NOT EXISTS auth_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`, (err) => {
        if (err) { return; }
        checkAndCreateAdmin();
    });
}

function checkAndCreateAdmin() {
    db.get("SELECT * FROM users WHERE is_admin = 1", (err, admin) => {
        if (err) return;
        
        if (!admin) {
            const adminUser = process.env.ADMIN_USER || 'admin';
            const adminPass = process.env.ADMIN_PASS || 'admin';
            
            bcrypt.genSalt(10, (saltErr, salt) => {
                if (saltErr) return;
                bcrypt.hash(adminPass, salt, (hashErr, hashedPassword) => {
                    if (hashErr) return;

                    db.run("INSERT INTO users (username, password, is_admin) VALUES (?, ?, 1)", [adminUser, hashedPassword], function(insertErr) {
                        if (insertErr) return;
                        const adminId = this.lastID;
                        db.run("INSERT INTO folders (name, parent_id, user_id) VALUES (?, NULL, ?)", ['/', adminId], (folderErr) => {});
                    });
                });
            });
        }
    });
}

// --- KV 存储相关方法 ---

function getConfig() {
    return new Promise((resolve) => {
        db.get("SELECT value FROM system_config WHERE key = 'main'", (err, row) => {
            if (err || !row) resolve(null);
            else {
                try {
                    resolve(JSON.parse(row.value));
                } catch (e) {
                    resolve(null);
                }
            }
        });
    });
}

function saveConfig(config) {
    return new Promise((resolve, reject) => {
        db.run("INSERT OR REPLACE INTO system_config (key, value) VALUES ('main', ?)", [JSON.stringify(config)], (err) => {
            if (err) reject(err);
            else resolve(true);
        });
    });
}

// 导出 db 对象以及新添加的方法
db.getConfig = getConfig;
db.saveConfig = saveConfig;

module.exports = db;
