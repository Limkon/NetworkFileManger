import path from 'node:path';
import bcrypt from 'bcryptjs';
import { encrypt, decrypt } from './crypto.js';

const ALL_FILE_COLUMNS = `
    fileName, mimetype, file_id, thumb_file_id, date, size, folder_id, user_id, storage_type, is_deleted, deleted_at
`;

// 修正：強制將 ID 轉換為 TEXT 字符串輸出，防止前端 JS 處理 BigInt 精度丟失或類型混淆
const SAFE_SELECT_MESSAGE_ID = `CAST(message_id AS TEXT) AS message_id`;
const SAFE_SELECT_ID_AS_TEXT = `CAST(message_id AS TEXT) AS id`;

// =================================================================================
// 1. 輔助功能
// =================================================================================

/**
 * 獲取不衝突的唯一文件名/文件夾名 (忽略已刪除的項目)
 */
export async function getUniqueName(db, folderId, originalName, userId, type) {
    const table = type === 'file' ? 'files' : 'folders';
    const col = type === 'file' ? 'fileName' : 'name';
    const parentCol = type === 'file' ? 'folder_id' : 'parent_id';
    
    // 檢查是否存在同名且未刪除的項目，使用 deleted_at IS NULL
    const exists = await db.get(
        `SELECT 1 as exists_flag FROM ${table} WHERE ${col} = ? AND ${parentCol} = ? AND user_id = ? AND deleted_at IS NULL`, 
        [originalName, folderId, userId]
    );
    
    if (!exists) return originalName;

    let name = originalName;
    let ext = '';
    if (type === 'file') {
        const lastDotIndex = originalName.lastIndexOf('.');
        if (lastDotIndex !== -1 && lastDotIndex !== 0) {
            name = originalName.substring(0, lastDotIndex);
            ext = originalName.substring(lastDotIndex);
        }
    }

    let counter = 1;
    while (true) {
        const newName = `${name} (${counter})${ext}`;
        const check = await db.get(
            `SELECT 1 as exists_flag FROM ${table} WHERE ${col} = ? AND ${parentCol} = ? AND user_id = ? AND deleted_at IS NULL`, 
            [newName, folderId, userId]
        );
        if (!check) return newName;
        counter++;
    }
}

// =================================================================================
// 2. 用戶管理
// =================================================================================

export async function createUser(db, username, hashedPassword) {
    const sql = `INSERT INTO users (username, password, is_admin, max_storage_bytes) VALUES (?, ?, 0, 1073741824)`;
    const result = await db.run(sql, [username, hashedPassword]);
    let newId = result?.meta?.last_row_id;
    if (!newId) {
        const u = await findUserByName(db, username);
        newId = u.id;
    }
    return { id: newId, username };
}

export async function findUserByName(db, username) {
    return await db.get("SELECT * FROM users WHERE username = ?", [username]);
}

export async function findUserById(db, id) {
    return await db.get("SELECT * FROM users WHERE id = ?", [id]);
}

export async function changeUserPassword(db, userId, newHashedPassword) {
    const sql = `UPDATE users SET password = ? WHERE id = ?`;
    const result = await db.run(sql, [newHashedPassword, userId]);
    return { success: true, changes: result.meta.changes };
}

export async function listAllUsers(db) {
    const sql = `SELECT id, username FROM users ORDER BY username ASC`;
    return await db.all(sql);
}

export async function deleteUser(db, userId) {
    const sql = `DELETE FROM users WHERE id = ? AND is_admin = 0`;
    const result = await db.run(sql, [userId]);
    return { success: true, changes: result.meta.changes };
}

// =================================================================================
// 3. 配額管理
// =================================================================================

export async function getUserQuota(db, userId) {
    const user = await db.get("SELECT max_storage_bytes FROM users WHERE id = ?", [userId]);
    // 修正: 使用 deleted_at IS NULL 替代 (is_deleted = 0 OR is_deleted IS NULL)
    const usage = await db.get("SELECT SUM(size) as total_size FROM files WHERE user_id = ? AND deleted_at IS NULL", [userId]);
    return {
        max: user ? (user.max_storage_bytes || 1073741824) : 1073741824,
        used: usage && usage.total_size ? usage.total_size : 0
    };
}

export async function checkQuota(db, userId, incomingSize) {
    const quota = await getUserQuota(db, userId);
    if (quota.max === 0) return true; 
    return (quota.used + incomingSize) <= quota.max;
}

export async function listAllUsersWithQuota(db) {
    const sql = `SELECT id, username, is_admin, max_storage_bytes FROM users ORDER BY is_admin DESC, username ASC`;
    const users = await db.all(sql);
    if (users.length === 0) return [];
    const userIds = users.map(u => u.id);
    const placeholders = userIds.map(() => '?').join(',');
    // 修正: 僅統計未刪除文件的佔用，使用 deleted_at IS NULL
    const usageSql = `SELECT user_id, SUM(size) as total_size FROM files WHERE user_id IN (${placeholders}) AND deleted_at IS NULL GROUP BY user_id`;
    const usageData = await db.all(usageSql, userIds);
    const usageMap = new Map(usageData.map(row => [row.user_id, row.total_size]));
    return users.map(user => ({
        id: user.id, username: user.username, is_admin: user.is_admin,
        max_storage_bytes: user.max_storage_bytes || 1073741824, 
        used_storage_bytes: usageMap.get(user.id) || 0
    }));
}

export async function setMaxStorageForUser(db, userId, maxBytes) {
    const sql = `UPDATE users SET max_storage_bytes = ? WHERE id = ? AND is_admin = 0`; 
    const result = await db.run(sql, [maxBytes, userId]);
    return { success: true, changes: result.meta.changes };
}

// =================================================================================
// 4. 文件操作 (已修正 ID 類型處理)
// =================================================================================

export async function addFile(db, fileData, folderId = 1, userId, storageType) {
    const { message_id, fileName, mimetype, file_id, thumb_file_id, date, size } = fileData;
    // 修正：message_id 傳入時已是字符串，直接使用
    const sql = `INSERT INTO files (message_id, fileName, mimetype, file_id, thumb_file_id, date, size, folder_id, user_id, storage_type, is_deleted)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`;
    const result = await db.run(sql, [message_id, fileName, mimetype, file_id, thumb_file_id, date, size, folderId, userId, storageType]);
    return { success: true, id: result.meta.last_row_id || 0, fileId: message_id };
}

export async function updateFile(db, fileId, updates, userId) {
    const fields = []; const values = [];
    const validKeys = ['fileName', 'mimetype', 'file_id', 'thumb_file_id', 'size', 'date', 'message_id'];
    for (const key in updates) {
        if (Object.hasOwnProperty.call(updates, key) && validKeys.includes(key)) {
            fields.push(`${key} = ?`);
            values.push(updates[key]);
        }
    }
    // 强制复活文件
    fields.push('is_deleted = 0');
    fields.push('deleted_at = NULL');
    
    if (fields.length === 0) return { success: true, changes: 0 };
    // 修正：fileId 已是字符串，直接使用
    values.push(fileId, userId);
    const sql = `UPDATE files SET ${fields.join(', ')} WHERE message_id = ? AND user_id = ?`;
    const result = await db.run(sql, values);
    return { success: true, changes: result.meta.changes };
}

export async function getFilesByIds(db, messageIds, userId) {
    if (!messageIds || messageIds.length === 0) return [];
    // 修正：messageIds 為字符串數組
    const placeholders = messageIds.map(() => '?').join(',');
    const sql = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files WHERE message_id IN (${placeholders}) AND user_id = ?`;
    return await db.all(sql, [...messageIds, userId]);
}

/**
 * 檢查文件是否已存在 (未刪除狀態)
 * @param {Database} db 
 * @param {number} folderId 
 * @param {string} fileName 
 * @param {number} userId 
 * @returns {Promise<boolean>}
 */
export async function checkFileExist(db, folderId, fileName, userId) {
    const result = await db.get(
        // 修正: 使用 deleted_at IS NULL 替代 (is_deleted = 0 OR is_deleted IS NULL)
        "SELECT 1 FROM files WHERE folder_id = ? AND fileName = ? AND user_id = ? AND deleted_at IS NULL", 
        [folderId, fileName, userId]
    );
    return !!result;
}

// =================================================================================
// 5. 文件夾操作
// =================================================================================

export async function createFolder(db, name, parentId, userId) {
    const sql = `INSERT INTO folders (name, parent_id, user_id, is_deleted) VALUES (?, ?, ?, 0)`;
    try {
        const result = await db.run(sql, [name, parentId, userId]);
        let newId = result?.meta?.last_row_id;
        if (!newId) {
            let querySql = ""; let params = [];
            if (parentId === null) { querySql = "SELECT id FROM folders WHERE name = ? AND parent_id IS NULL AND user_id = ?"; params = [name, userId]; } 
            else { querySql = "SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?"; params = [name, parentId, userId]; }
            const row = await db.get(querySql, params);
            if (row) newId = row.id;
        }
        return { success: true, id: newId };
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
            let row;
            const whereClause = parentId === null ? "parent_id IS NULL" : "parent_id = ?";
            const params = parentId === null ? [name, userId] : [name, parentId, userId];
            
            // 修正 BUG: 1. 查找所有可能造成衝突的現有記錄（不限定是否已刪除），獲取 deleted_at
            row = await db.get(`SELECT id, deleted_at FROM folders WHERE name = ? AND ${whereClause} AND user_id = ?`, params); 
            
            if (row) {
                // 2. 檢查記錄是否已刪除 (deleted_at 不為 NULL 表示在回收站中)
                if (row.deleted_at !== null) {
                    // 是已刪除的文件夾，執行復原操作：清除 deleted_at 並設置 is_deleted = 0
                    await db.run("UPDATE folders SET is_deleted = 0, deleted_at = NULL WHERE id = ?", [row.id]); 
                    return { success: true, id: row.id, restored: true };
                } else {
                    // 這是活躍的文件夾，拋出衝突錯誤
                    throw new Error('文件夾已存在');
                }
            } 
            // 如果 UNIQUE 衝突發生，但找不到記錄（理論上不該發生），則拋出原始錯誤
            throw err;
        }
        throw err;
    }
}

export async function getFolderContents(db, folderId, userId) {
    // 修正: 使用 deleted_at IS NULL 替代 (is_deleted = 0 OR is_deleted IS NULL)
    const sqlFolders = `SELECT id, name, parent_id, 'folder' as type, password IS NOT NULL as is_locked FROM folders WHERE parent_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY name ASC`;
    // 修正: 使用 deleted_at IS NULL 替代 (is_deleted = 0 OR is_deleted IS NULL)
    const sqlFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS}, ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, 'file' as type FROM files WHERE folder_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY name ASC`;
    
    const folders = await db.all(sqlFolders, [folderId, userId]);
    const files = await db.all(sqlFiles, [folderId, userId]);

    return {
        folders: folders.map(f => ({ ...f, encrypted_id: encrypt(f.id) })),
        files: files
    };
}

export async function getRootFolder(db, userId) {
    return await db.get("SELECT id FROM folders WHERE user_id = ? AND parent_id IS NULL", [userId]);
}

export async function getFolderPath(db, folderId, userId) {
    let pathArr = []; let currentId = folderId;
    while (currentId) {
        const folder = await db.get("SELECT id, name, parent_id FROM folders WHERE id = ? AND user_id = ?", [currentId, userId]);
        if (folder) {
            pathArr.unshift({ id: folder.id, name: folder.name, encrypted_id: encrypt(folder.id) });
            currentId = folder.parent_id;
        } else { break; }
    }
    return pathArr;
}

export async function getAllFolders(db, userId) {
    // 修正: 使用 deleted_at IS NULL 替代 (is_deleted = 0 OR is_deleted IS NULL)
    const sql = "SELECT id, name, parent_id FROM folders WHERE user_id = ? AND deleted_at IS NULL ORDER BY parent_id, name ASC";
    const rows = await db.all(sql, [userId]);
    return rows.map(folder => ({ ...folder, encrypted_id: encrypt(folder.id) }));
}

// =================================================================================
// 6. 搜索
// =================================================================================

export async function searchItems(db, query, userId) {
    const searchQuery = `%${query}%`;
    const baseQuery = `
        WITH RECURSIVE folder_ancestry(id, parent_id, is_locked, is_deleted) AS (
            SELECT id, parent_id, (password IS NOT NULL) as is_locked, is_deleted
            FROM folders WHERE user_id = ?
            UNION ALL
            SELECT fa.id, f.parent_id, (fa.is_locked OR (f.password IS NOT NULL)), (fa.is_deleted OR f.is_deleted)
            FROM folders f JOIN folder_ancestry fa ON f.id = fa.parent_id WHERE f.user_id = ?
        ),
        folder_status AS ( SELECT id, MAX(is_locked) as is_path_locked, MAX(is_deleted) as is_path_deleted FROM folder_ancestry GROUP BY id )
    `;
    const sqlFiles = baseQuery + `
        SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS}, ${SAFE_SELECT_ID_AS_TEXT}, f.fileName as name, 'file' as type
        FROM files f JOIN folder_status fs ON f.folder_id = fs.id
        WHERE f.fileName LIKE ? AND f.user_id = ? AND fs.is_path_locked = 0 
        AND f.deleted_at IS NULL
        ORDER BY f.date DESC;
    `;
    const sqlFolders = baseQuery + `
        SELECT f.id, f.name, f.parent_id, 'folder' as type, (f.password IS NOT NULL) as is_locked
        FROM folders f JOIN folder_status fs ON f.id = fs.id
        WHERE f.name LIKE ? AND f.user_id = ? AND fs.is_path_locked = 0 
        AND f.deleted_at IS NULL
        AND f.parent_id IS NOT NULL
        ORDER BY f.name ASC;
    `;
    const folders = await db.all(sqlFolders, [userId, userId, searchQuery, userId]);
    const files = await db.all(sqlFiles, [userId, userId, searchQuery, userId]);
    return { folders: folders.map(f => ({ ...f, encrypted_id: encrypt(f.id) })), files };
}

// =================================================================================
// 7. 回收站與刪除 (修正 ID 為字符串處理)
// =================================================================================

export async function unifiedDelete(db, storage, itemId, itemType, userId, explicitFileIds = null, explicitFolderIds = null) {
    let filesForStorage = []; let foldersForStorage = [];
    if (explicitFileIds || explicitFolderIds) {
        if (explicitFileIds && explicitFileIds.length > 0) filesForStorage.push(...await getFilesByIds(db, explicitFileIds, userId));
        if (explicitFolderIds && explicitFolderIds.length > 0) {
             for(const fid of explicitFolderIds) {
                 const deletionData = await getFolderDeletionData(db, fid, userId);
                 filesForStorage.push(...deletionData.files);
                 foldersForStorage.push(...deletionData.folders);
             }
        }
    } else {
        if (itemType === 'folder') {
            const deletionData = await getFolderDeletionData(db, itemId, userId);
            filesForStorage.push(...deletionData.files);
            foldersForStorage.push(...deletionData.folders);
        } else {
            filesForStorage.push(...await getFilesByIds(db, [itemId], userId));
        }
    }
    if (storage && storage.remove) {
        try { await storage.remove(filesForStorage, foldersForStorage, userId); } catch (err) { console.error("實體刪除失敗:", err); }
    }
    // 修正：直接映射 String ID
    const fileIdsToDelete = filesForStorage.map(f => f.message_id);
    let folderIdsToDelete = foldersForStorage.map(f => f.id);
    if (explicitFolderIds) folderIdsToDelete = [...new Set([...folderIdsToDelete, ...explicitFolderIds])];
    else if (itemType === 'folder') folderIdsToDelete.push(itemId);
    await executeDeletion(db, fileIdsToDelete, folderIdsToDelete, userId);
}

export async function getFolderDeletionData(db, folderId, userId) {
    let filesToDelete = []; let foldersToDeleteIds = [folderId];
    async function findContentsRecursive(currentFolderId) {
        const sqlFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files WHERE folder_id = ? AND user_id = ?`;
        const files = await db.all(sqlFiles, [currentFolderId, userId]);
        filesToDelete.push(...files);
        const sqlFolders = `SELECT id FROM folders WHERE parent_id = ? AND user_id = ?`;
        const subFolders = await db.all(sqlFolders, [currentFolderId, userId]);
        for (const subFolder of subFolders) {
            foldersToDeleteIds.push(subFolder.id);
            await findContentsRecursive(subFolder.id);
        }
    }
    await findContentsRecursive(folderId);
    const foldersToDelete = foldersToDeleteIds.map(id => ({ id }));
    return { files: filesToDelete, folders: foldersToDelete };
}

export async function executeDeletion(db, fileIds, folderIds, userId) {
    if (fileIds.length === 0 && folderIds.length === 0) return { success: true };
    if (fileIds.length > 0) {
        // 修正：使用字符串數組
        const place = fileIds.map(() => '?').join(',');
        await db.run(`DELETE FROM files WHERE message_id IN (${place}) AND user_id = ?`, [...fileIds, userId]);
    }
    if (folderIds.length > 0) {
        const place = Array.from(new Set(folderIds)).map(() => '?').join(',');
        await db.run(`DELETE FROM folders WHERE id IN (${place}) AND user_id = ?`, [...new Set(folderIds), userId]);
    }
    return { success: true };
}

export async function softDeleteItems(db, fileIds = [], folderIds = [], userId) {
    const now = Date.now();
    if (fileIds.length > 0) {
        // 修正：使用字符串數組
        const place = fileIds.map(() => '?').join(',');
        // 確保 message_id 匹配時考慮字符串類型
        await db.run(`UPDATE files SET is_deleted = 1, deleted_at = ? WHERE message_id IN (${place}) AND user_id = ?`, [now, ...fileIds, userId]);
    }
    if (folderIds.length > 0) {
        const place = folderIds.map(() => '?').join(',');
        await db.run(`UPDATE folders SET is_deleted = 1, deleted_at = ? WHERE id IN (${place}) AND user_id = ?`, [now, ...folderIds, userId]);
    }
    return { success: true };
}

export async function restoreItems(db, fileIds = [], folderIds = [], userId) {
    if (fileIds.length > 0) {
        // 修正：使用字符串數組
        const place = fileIds.map(() => '?').join(',');
        // 修正: 清除 deleted_at
        await db.run(`UPDATE files SET is_deleted = 0, deleted_at = NULL WHERE message_id IN (${place}) AND user_id = ?`, [...fileIds, userId]);
    }
    if (folderIds.length > 0) {
        const place = folderIds.map(() => '?').join(',');
        // 修正: 清除 deleted_at
        await db.run(`UPDATE folders SET is_deleted = 0, deleted_at = NULL WHERE id IN (${place}) AND user_id = ?`, [...folderIds, userId]);
    }
    return { success: true };
}

// =================================================================================
// 8. 回收站內容
// =================================================================================

export async function getTrashContents(db, userId) {
    const sqlFolders = `SELECT id, name, deleted_at, 'folder' as type FROM folders WHERE user_id = ? AND is_deleted = 1 ORDER BY deleted_at DESC`;
    const sqlFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, size, deleted_at, 'file' as type FROM files WHERE user_id = ? AND is_deleted = 1 ORDER BY deleted_at DESC`;
    const folders = await db.all(sqlFolders, [userId]);
    const files = await db.all(sqlFiles, [userId]);
    return { folders: folders.map(f => ({ ...f, encrypted_id: encrypt(f.id) })), files };
}

export async function emptyTrash(db, storage, userId) {
    const files = await db.all(`SELECT ${SAFE_SELECT_MESSAGE_ID}, file_id FROM files WHERE is_deleted = 1 AND user_id = ?`, [userId]);
    const folders = await db.all(`SELECT id FROM folders WHERE is_deleted = 1 AND user_id = ?`, [userId]);
    // 修正：映射為字符串 ID
    const fileIds = files.map(f => f.message_id);
    const folderIds = folders.map(f => f.id);
    if (fileIds.length === 0 && folderIds.length === 0) return { success: true };
    await unifiedDelete(db, storage, null, null, userId, fileIds, folderIds);
    return { success: true };
}

// =================================================================================
// 9. 分享與加密 (修正 ID 處理)
// =================================================================================

export async function createShareLink(db, itemId, itemType, expiresIn, userId, password = null, customExpiresAt = null) {
    const tokenArray = new Uint8Array(8); crypto.getRandomValues(tokenArray);
    const token = Array.from(tokenArray).map(b => b.toString(16).padStart(2, '0')).join('');
    let expiresAt = null;
    if (expiresIn !== '0') {
        const now = Date.now();
        if (expiresIn === 'custom' && customExpiresAt) expiresAt = parseInt(customExpiresAt, 10);
        else {
            const hour = 3600000; const day = 24 * hour;
            if (expiresIn === '1h') expiresAt = now + hour;
            else if (expiresIn === '24h') expiresAt = now + day;
            else if (expiresIn === '7d') expiresAt = now + 7 * day;
            else expiresAt = now + day;
        }
    }
    const table = itemType === 'folder' ? 'folders' : 'files';
    const idColumn = itemType === 'folder' ? 'id' : 'message_id';
    let hashedPassword = null;
    if (password && password.length > 0) { const salt = await bcrypt.genSalt(10); hashedPassword = await bcrypt.hash(password, salt); }
    const sql = `UPDATE ${table} SET share_token = ?, share_expires_at = ?, share_password = ? WHERE ${idColumn} = ? AND user_id = ?`;
    // itemId 直接使用 (File=String, Folder=Int)
    const result = await db.run(sql, [token, expiresAt, hashedPassword, itemId, userId]);
    if (result.meta.changes === 0) return { success: false, message: '項目未找到。' };
    return { success: true, token };
}

export async function getFileByShareToken(db, token) {
    const row = await db.get(`SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS}, share_password, share_expires_at FROM files WHERE share_token = ?`, [token]);
    if (!row) return null;
    if (row.share_expires_at && Date.now() > row.share_expires_at) return null;
    return row;
}

export async function getFolderByShareToken(db, token) {
    const row = await db.get("SELECT *, password as share_password FROM folders WHERE share_token = ?", [token]);
    if (!row) return null;
    if (row.share_expires_at && Date.now() > row.share_expires_at) return null;
    return row;
}

export async function cancelShare(db, itemId, itemType, userId) {
    const table = itemType === 'folder' ? 'folders' : 'files';
    const idColumn = itemType === 'folder' ? 'id' : 'message_id';
    await db.run(`UPDATE ${table} SET share_token = NULL, share_expires_at = NULL, share_password = NULL WHERE ${idColumn} = ? AND user_id = ?`, [itemId, userId]);
    return { success: true };
}

export async function getActiveShares(db, userId) {
    const now = Date.now();
    const files = await db.all(`SELECT ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, 'file' as type, share_token, share_expires_at FROM files WHERE share_token IS NOT NULL AND (share_expires_at IS NULL OR share_expires_at > ?) AND user_id = ?`, [now, userId]);
    const folders = await db.all(`SELECT id, name, 'folder' as type, share_token, share_expires_at FROM folders WHERE share_token IS NOT NULL AND (share_expires_at IS NULL OR share_expires_at > ?) AND user_id = ?`, [now, userId]);
    return [...files, ...folders];
}

export async function setFolderPassword(db, folderId, password, userId) {
    const result = await db.run(`UPDATE folders SET password = ? WHERE id = ? AND user_id = ?`, [password, folderId, userId]);
    if (result.meta.changes === 0) throw new Error('文件夾未找到');
    return { success: true };
}

// =================================================================================
// 10. 移動與重命名 (修正 BigInt 轉換)
// =================================================================================

export async function moveItems(db, storage, fileIds = [], folderIds = [], targetFolderId, userId, conflictMode = 'rename') {
    // 修正：fileIds 是字符串數組
    for (const fileId of fileIds) {
        const file = await db.get("SELECT fileName FROM files WHERE message_id = ? AND user_id = ?", [fileId, userId]);
        if (file) {
            let finalName = file.fileName;
            const existing = await db.get(
                // 修正: 使用 deleted_at IS NULL 替代 (is_deleted = 0 OR is_deleted IS NULL)
                "SELECT message_id FROM files WHERE folder_id = ? AND fileName = ? AND user_id = ? AND deleted_at IS NULL", 
                [targetFolderId, file.fileName, userId]
            );

            if (existing) {
                if (conflictMode === 'overwrite') {
                    // 移動覆蓋：將目標位置的文件軟刪除
                    await db.run("UPDATE files SET is_deleted = 1, deleted_at = ? WHERE message_id = ? AND user_id = ?", [Date.now(), existing.message_id, userId]);
                } else if (conflictMode === 'skip') {
                    continue; 
                } else {
                    finalName = await getUniqueName(db, targetFolderId, file.fileName, userId, 'file');
                }
            }
            
            await db.run(
                "UPDATE files SET folder_id = ?, fileName = ? WHERE message_id = ? AND user_id = ?", 
                [targetFolderId, finalName, fileId, userId]
            );
        }
    }

    for (const folderId of folderIds) {
        if (folderId === targetFolderId) continue; 
        const folder = await db.get("SELECT name FROM folders WHERE id = ? AND user_id = ?", [folderId, userId]);
        if (folder) {
            const uniqueName = await getUniqueName(db, targetFolderId, folder.name, userId, 'folder');
            await db.run(
                "UPDATE folders SET parent_id = ?, name = ? WHERE id = ? AND user_id = ?", 
                [targetFolderId, uniqueName, folderId, userId]
            );
        }
    }
    return { success: true };
}

export async function renameFile(db, storage, messageId, newFileName, userId) {
    // 修正：messageId 是字符串
    const result = await db.run(`UPDATE files SET fileName = ? WHERE message_id = ? AND user_id = ?`, [newFileName, messageId, userId]);
    // if (result.meta.changes === 0) throw new Error('文件未找到'); 
    return { success: true };
}

export async function renameFolder(db, storage, folderId, newFolderName, userId) {
    const result = await db.run(`UPDATE folders SET name = ? WHERE id = ? AND user_id = ?`, [newFolderName, folderId, userId]);
    // if (result.meta.changes === 0) throw new Error('文件夾未找到'); 
    return { success: true };
}

// =================================================================================
// 11. 認證 Token
// =================================================================================

export async function createAuthToken(db, userId, token, expiresAt) {
    await db.run(`INSERT INTO auth_tokens (user_id, token, expires_at) VALUES (?, ?, ?)`, [userId, token, expiresAt]);
}

export async function findAuthToken(db, token) {
    return await db.get(`SELECT t.id, t.user_id, t.expires_at, u.username, u.is_admin FROM auth_tokens t JOIN users u ON t.user_id = u.id WHERE t.token = ?`, [token]);
}

export async function deleteAuthToken(db, token) {
    await db.run(`DELETE FROM auth_tokens WHERE token = ?`, [token]);
}

// =================================================================================
// 12. 掃描與導入
// =================================================================================

export async function scanStorageAndImport(db, storage, userId, controller) {
    const encoder = new TextEncoder();
    const log = (msg) => controller.enqueue(encoder.encode(msg + '\n'));
    log('開始掃描儲存...');
    try {
        if (!storage.list) { log('錯誤: 當前儲存後端不支持列表掃描'); return; }
        const prefix = `${userId}/`;
        const remoteFiles = await storage.list(prefix);
        log(`掃描到 ${remoteFiles.length} 個文件，開始比對...`);
        const rootFolder = await getRootFolder(db, userId);
        let importedCount = 0;
        for (const remote of remoteFiles) {
            const filename = path.basename(remote.fileId);
            if (filename.startsWith('.')) continue;
            // 修正: 檢查時應使用 deleted_at IS NULL
            const existing = await db.get("SELECT 1 FROM files WHERE file_id = ? AND user_id = ? AND deleted_at IS NULL", [remote.fileId, userId]);
            if (!existing) {
                // 修正：生成字符串 ID
                const messageId = (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();
                const uniqueName = await getUniqueName(db, rootFolder.id, filename, userId, 'file');
                
                await addFile(db, {
                    message_id: messageId, fileName: uniqueName, mimetype: 'application/octet-stream',
                    file_id: remote.fileId, size: remote.size, date: remote.updatedAt || Date.now()
                }, rootFolder.id, userId, 'imported');
                log(`[導入] ${uniqueName} (${(remote.size/1024).toFixed(1)} KB)`);
                importedCount++;
            }
        }
        log(`掃描完成。新增導入 ${importedCount} 個文件。`);
    } catch (e) { log(`掃描過程發生錯誤: ${e.message}`); }
}
