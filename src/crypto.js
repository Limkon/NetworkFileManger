// src/crypto.js
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

let SECRET_KEY = null;
const IV_LENGTH = 16; // AES block size

export function initCrypto(secret) {
    if (!secret) {
        console.warn("No SESSION_SECRET provided, using insecure default.");
        // 如果沒有提供密鑰，使用一個默認值（僅用於開發，生產環境請務必設置環境變量）
        SECRET_KEY = crypto.createHash('sha256').update('default-insecure-secret').digest();
    } else {
        // 使用 SHA-256 將任意長度的字符串轉換為 32 字節的密鑰
        SECRET_KEY = crypto.createHash('sha256').update(secret).digest();
    }
}

// 簡單的 ID 加密 (用於 URL 參數，避免直接暴露自增 ID)
export function encrypt(text) {
    if (!text && text !== 0) return null;
    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv('aes-256-cbc', SECRET_KEY, iv);
        let encrypted = cipher.update(text.toString());
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        return iv.toString('hex') + ':' + encrypted.toString('hex');
    } catch (e) {
        console.error("Encrypt error:", e);
        return null;
    }
}

export function decrypt(text) {
    if (!text) return null;
    try {
        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', SECRET_KEY, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (e) {
        // 解密失敗通常意味著 ID 無效或偽造
        return null;
    }
}
