import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

let SECRET_KEY = null;
const IV_LENGTH = 16; 

export function initCrypto(secret) {
    try {
        // --- 核心保障逻辑 ---
        // 如果 secret 为空 (undefined/null/"")，自动使用内置的默认字符串
        // String(secret) 确保哪怕传入数字也能正常处理
        let safeSecret;
        
        if (secret) {
            safeSecret = String(secret);
        } else {
            console.warn("⚠️ [Security Warning] No SESSION_SECRET found. Using internal fallback key.");
            safeSecret = 'default-insecure-fallback-key-2024'; // 内置保底密钥
        }

        // 使用 SHA-256 生成 32 字节的固定长度密钥
        SECRET_KEY = crypto.createHash('sha256').update(safeSecret).digest();
        
    } catch (e) {
        console.error("Crypto Init Failed (Critical):", e);
        // 终极熔断机制：如果上面的 Hash 也失败了，生成一个全 0 密钥，保证服务不挂
        SECRET_KEY = Buffer.alloc(32, 0);
    }
}

export function encrypt(text) {
    if (text === null || text === undefined) return null;
    
    // 双重保障：如果在调用加密时密钥仍未初始化（极罕见情况），立即执行懒加载初始化
    if (!SECRET_KEY) {
        console.log("⚠️ Lazy-init crypto with fallback key");
        initCrypto(null); // 传入 null 触发内置保底逻辑
    }

    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv('aes-256-cbc', SECRET_KEY, iv);
        
        // 强制转为字符串，防止传入数字导致报错
        const textStr = String(text);
        
        let encrypted = cipher.update(textStr);
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        return iv.toString('hex') + ':' + encrypted.toString('hex');
    } catch (e) {
        console.error("Encrypt error:", e);
        return null;
    }
}

export function decrypt(text) {
    if (!text) return null;
    
    // 双重保障
    if (!SECRET_KEY) {
        initCrypto(null);
    }

    try {
        const textParts = text.split(':');
        if (textParts.length !== 2) return null;
        
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        
        const decipher = crypto.createDecipheriv('aes-256-cbc', SECRET_KEY, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (e) {
        // 解密失败通常是正常的（如密钥不匹配或数据篡改），返回 null 即可
        return null;
    }
}
