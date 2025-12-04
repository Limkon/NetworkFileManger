// src/crypto.js
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

// 預設密鑰，稍後通過 initCrypto 覆蓋 (保持原有的預設值以兼容舊數據或開發環境)
let SECRET_KEY = 'a8e2a32e9b1c7d5f6a7b3c4d5e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f';
let KEY = crypto.createHash('sha256').update(String(SECRET_KEY)).digest('base64').substring(0, 32);

/**
 * 初始化加密模塊，注入環境變數中的 SECRET
 * @param {string} secretEnv - 從 env 獲取的 SESSION_SECRET
 */
export function initCrypto(secretEnv) {
    if (secretEnv) {
        SECRET_KEY = secretEnv;
        KEY = crypto.createHash('sha256').update(String(SECRET_KEY)).digest('base64').substring(0, 32);
    }
}

/**
 * 加密函數
 * @param {string | number} text 要加密的文字或數字
 * @returns {string} 加密後的字串
 */
export function encrypt(text) {
    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(KEY), iv);
        let encrypted = cipher.update(String(text));
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        // 使用 Base64 URL 安全編碼，以避免 URL 中的特殊字元問題
        return iv.toString('base64url') + ':' + encrypted.toString('base64url');
    } catch (error) {
        console.error("加密失敗:", error);
        return String(text); // 加密失敗時返回原文字(轉字串)
    }
}

/**
 * 解密函數
 * @param {string} text 要解密的字串
 * @returns {string|null} 解密後的字串，若失敗則為 null
 */
export function decrypt(text) {
    if (!text) return null;
    try {
        const textParts = text.split(':');
        if (textParts.length < 2) return null; // 格式不正確
        const iv = Buffer.from(textParts.shift(), 'base64url');
        const encryptedText = Buffer.from(textParts.join(':'), 'base64url');
        const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(KEY), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (error) {
        console.error(`解密失敗: "${text}"`, error);
        return null; // 解密失敗
    }
}
