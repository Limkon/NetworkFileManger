import path from 'node:path';
import bcrypt from 'bcryptjs';
import { encrypt, decrypt } from './crypto.js';

const ALL_FILE_COLUMNS = `
    fileName, mimetype, file_id, thumb_file_id, date, size, folder_id, user_id, storage_type, is_deleted, deleted_at
`;
const SAFE_SELECT_MESSAGE_ID = `CAST(message_id AS TEXT) AS message_id`;
const SAFE_SELECT_ID_AS_TEXT = `CAST(message_id AS TEXT) AS id`;

// --- 辅助功能 ---

export async function getUniqueName(db, folderId, originalName, userId, type) {
    const table = type === 'file' ? 'files' : 'folders';
    const col = type === 'file' ? 'fileName' : 'name';
    const parentCol = type === 'file' ? 'folder_id' : 'parent_id';
    
    // 宽容检查: (is_deleted = 0 OR is_deleted IS NULL)
    const exists = await db.get(
        `SELECT id FROM ${table} WHERE ${col} = ? AND ${parentCol} = ? AND user_id = ? AND (is_deleted = 0 OR is_deleted IS NULL)`, 
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
            `SELECT id FROM ${table} WHERE ${col} = ? AND ${parentCol} = ? AND user_id = ? AND (is_deleted = 0 OR is_deleted IS NULL)`, 
            [newName, folderId, userId]
        );
        if (!check) return newName;
        counter++;
    }
}

// --- 用户管理 ---

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

// --- 配额 ---

export async function getUserQuota(db, userId) {
    const user = await db.get("SELECT max_storage_bytes FROM users WHERE id = ?", [userId]);
    const usage = await db.get("SELECT SUM(size) as total_size FROM files WHERE user_id = ?", [userId]);
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
    const usageSql = `SELECT user_id, SUM(size) as total_size FROM files WHERE user_id IN (${placeholders}) GROUP BY user_id`;
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

// --- 文件操作 ---

export async function addFile(db, fileData, folderId = 1, userId, storageType) {
    const { message_id, fileName, mimetype, file_id, thumb_file_id, date, size } = fileData;
    // 强制 is_deleted = 0
    const sql = `INSERT INTO files (message_id, fileName, mimetype, file_id, thumb_file_id, date, size, folder_id, user_id, storage_type, is_deleted)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`;
    const result = await db.run(sql, [message_id.toString(), fileName, mimetype, file_id, thumb_file_id, date, size, folderId, userId, storageType]);
    return { success: true, id: result.meta.last_row_id, fileId: message_id };
}

export async function updateFile(db, fileId, updates, userId) {
    const fields = []; const values = [];
    const validKeys = ['fileName', 'mimetype', 'file_id', 'thumb_file_id', 'size', 'date', 'message_id'];
    for (const key in updates) {
        if (Object.hasOwnProperty.call(updates, key) && validKeys.includes(key)) {
            fields.push(`${key} = ?`);
            values.push(key === 'message_id' ? updates[key].toString() : updates[key]);
        }
    }
    // 确保更新后文件可见
    fields.push('is_deleted = 0');
    if (fields.length === 0) return { success: true, changes: 0 };
    values.push(fileId.toString(), userId);
    const sql = `UPDATE files SET ${fields.join(', ')} WHERE message_id = ? AND user_id = ?`;
    const result = await db.run(sql, values);
    return { success: true, changes: result.meta.changes };
}

export async function getFilesByIds(db, messageIds, userId) {
    if (!messageIds || messageIds.length === 0) return [];
    const stringMessageIds = messageIds.map(id => id.toString());
    const placeholders = stringMessageIds.map(() => '?').join(',');
    const sql = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files WHERE message_id IN (${placeholders}) AND user_id = ?`;
    return await db.all(sql, [...stringMessageIds, userId]);
}

// --- 文件夹操作 ---

export async function createFolder(db, name, parentId, userId) {
    // 强制 is_deleted = 0
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
            // 宽容检查
            const whereClause = parentId === null ? "parent_id IS NULL" : "parent_id = ?";
            const params = parentId === null ? [name, userId] : [name, parentId, userId];
            row = await db.get(`SELECT id, is_deleted FROM folders WHERE name = ? AND ${whereClause} AND user_id = ?`, params);
            
            if (row) {
                if (row.is_deleted) {
                    await db.run("UPDATE folders SET is_deleted = 0 WHERE id = ?", [row.id]);
                    return { success: true, id: row.id, restored: true };
                } else {
                    throw new Error('文件夹已存在');
                }
            }
        }
        throw err;
    }
}

export async function getFolderContents(db, folderId, userId) {
    // 修复：宽容检查 (is_deleted = 0 OR is_deleted IS NULL)
    const sqlFolders = `SELECT id, name, parent_id, 'folder' as type, password IS NOT NULL as is_locked FROM folders WHERE parent_id = ? AND user_id = ? AND (is_deleted = 0 OR is_deleted IS NULL) ORDER BY name ASC`;
    const sqlFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS}, ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, 'file' as type FROM files WHERE folder_id = ? AND user_id = ? AND (is_deleted = 0 OR is_deleted IS NULL) ORDER BY name ASC`;
    
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
    const sql = "SELECT id, name, parent_id FROM folders WHERE user_id = ? AND (is_deleted = 0 OR is_deleted IS NULL) ORDER BY parent_id, name ASC";
    const rows = await db.all(sql, [userId]);
    return rows.map(folder => ({ ...folder, encrypted_id: encrypt(folder.id) }));
}

// --- 搜索 ---

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
        AND (fs.is_path_deleted = 0 OR fs.is_path_deleted IS NULL)
        AND (f.is_deleted = 0 OR f.is_deleted IS NULL)
        ORDER BY f.date DESC;
    `;
    const sqlFolders = baseQuery + `
        SELECT f.id, f.name, f.parent_id, 'folder' as type, (f.password IS NOT NULL) as is_locked
        FROM folders f JOIN folder_status fs ON f.id = fs.id
        WHERE f.name LIKE ? AND f.user_id = ? AND fs.is_path_locked = 0 
        AND (fs.is_path_deleted = 0 OR fs.is_path_deleted IS NULL)
        AND (f.is_deleted = 0 OR f.is_deleted IS NULL)
        AND f.parent_id IS NOT NULL
        ORDER BY f.name ASC;
    `;
    const folders = await db.all(sqlFolders, [userId, userId, searchQuery, userId]);
    const files = await db.all(sqlFiles, [userId, userId, searchQuery, userId]);
    return { folders: folders.map(f => ({ ...f, encrypted_id: encrypt(f.id) })), files };
}

// --- 回收站与删除 ---

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
        try { await storage.remove(filesForStorage, foldersForStorage, userId); } catch (err) { console.error("实体删除失败:", err); }
    }
    const fileIdsToDelete = filesForStorage.map(f => BigInt(f.message_id));
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
        const stringFileIds = Array.from(new Set(fileIds)).map(id => id.toString());
        const place = stringFileIds.map(() => '?').join(',');
        await db.run(`DELETE FROM files WHERE message_id IN (${place}) AND user_id = ?`, [...stringFileIds, userId]);
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
        const stringFileIds = fileIds.map(id => id.toString());
        const place = stringFileIds.map(() => '?').join(',');
        await db.run(`UPDATE files SET is_deleted = 1, deleted_at = ? WHERE message_id IN (${place}) AND user_id = ?`, [now, ...stringFileIds, userId]);
    }
    if (folderIds.length > 0) {
        const place = folderIds.map(() => '?').join(',');
        await db.run(`UPDATE folders SET is_deleted = 1, deleted_at = ? WHERE id IN (${place}) AND user_id = ?`, [now, ...folderIds, userId]);
    }
    return { success: true };
}

export async function restoreItems(db, fileIds = [], folderIds = [], userId) {
    if (fileIds.length > 0) {
        const stringFileIds = fileIds.map(id => id.toString());
        const place = stringFileIds.map(() => '?').join(',');
        await db.run(`UPDATE files SET is_deleted = 0, deleted_at = NULL WHERE message_id IN (${place}) AND user_id = ?`, [...stringFileIds, userId]);
    }
    if (folderIds.length > 0) {
        const place = folderIds.map(() => '?').join(',');
        await db.run(`UPDATE folders SET is_deleted = 0, deleted_at = NULL WHERE id IN (${place}) AND user_id = ?`, [...folderIds, userId]);
    }
    return { success: true };
}

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
    const fileIds = files.map(f => BigInt(f.message_id));
    const folderIds = folders.map(f => f.id);
    if (fileIds.length === 0 && folderIds.length === 0) return { success: true };
    await unifiedDelete(db, storage, null, null, userId, fileIds, folderIds);
    return { success: true };
}

export async function cleanupTrash(db, storage, retentionDays = 30) {
    const cutoffDate = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    const expiredFilesSql = `SELECT ${SAFE_SELECT_MESSAGE_ID}, user_id FROM files WHERE is_deleted = 1 AND deleted_at < ?`;
    const expiredFoldersSql = `SELECT id, user_id FROM folders WHERE is_deleted = 1 AND deleted_at < ?`;
    const files = await db.all(expiredFilesSql, [cutoffDate]);
    const folders = await db.all(expiredFoldersSql, [cutoffDate]);
    const itemsByUser = {};
    files.forEach(f => {
        if(!itemsByUser[f.user_id]) itemsByUser[f.user_id] = { files: [], folders: [] };
        itemsByUser[f.user_id].files.push(BigInt(f.message_id));
    });
    folders.forEach(f => {
        if(!itemsByUser[f.user_id]) itemsByUser[f.user_id] = { files: [], folders: [] };
        itemsByUser[f.user_id].folders.push(f.id);
    });
    for (const userId in itemsByUser) {
        const { files, folders } = itemsByUser[userId];
        if (files.length > 0 || folders.length > 0) {
            await unifiedDelete(db, storage, null, null, parseInt(userId), files, folders);
        }
    }
    return { filesCount: files.length, foldersCount: folders.length };
}

// --- 分享与加密 ---

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
    const stringItemId = itemType === 'folder' ? itemId : itemId.toString();
    const result = await db.run(sql, [token, expiresAt, hashedPassword, stringItemId, userId]);
    if (result.meta.changes === 0) return { success: false, message: '项目未找到。' };
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
    const stringItemId = itemType === 'folder' ? itemId : itemId.toString();
    await db.run(`UPDATE ${table} SET share_token = NULL, share_expires_at = NULL, share_password = NULL WHERE ${idColumn} = ? AND user_id = ?`, [stringItemId, userId]);
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
    if (result.meta.changes === 0) throw new Error('文件夹未找到');
    return { success: true };
}

// --- 移动 ---

export async function moveItems(db, storage, fileIds = [], folderIds = [], targetFolderId, userId, conflictMode = 'rename') {
    // 处理文件
    for (const fileId of fileIds) {
        const file = await db.get("SELECT fileName FROM files WHERE message_id = ? AND user_id = ?", [fileId.toString(), userId]);
        if (file) {
            let finalName = file.fileName;
            const existing = await db.get(
                "SELECT message_id FROM files WHERE folder_id = ? AND fileName = ? AND user_id = ? AND (is_deleted = 0 OR is_deleted IS NULL)", 
                [targetFolderId, file.fileName, userId]
            );

            if (existing) {
                if (conflictMode === 'overwrite') {
                    // 删除目标文件 (软删除)
                    await db.run("UPDATE files SET is_deleted = 1, deleted_at = ? WHERE message_id = ? AND user_id = ?", [Date.now(), existing.message_id, userId]);
                } else if (conflictMode === 'skip') {
                    continue; 
                } else {
                    finalName = await getUniqueName(db, targetFolderId, file.fileName, userId, 'file');
                }
            }
            
            await db.run(
                "UPDATE files SET folder_id = ?, fileName = ? WHERE message_id = ? AND user_id = ?", 
                [targetFolderId, finalName, fileId.toString(), userId]
            );
        }
    }

    // 处理文件夹
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
    const result = await db.run(`UPDATE files SET fileName = ? WHERE message_id = ? AND user_id = ?`, [newFileName, messageId.toString(), userId]);
    if (result.meta.changes === 0) throw new Error('文件未找到');
    return { success: true };
}

export async function renameFolder(db, storage, folderId, newFolderName, userId) {
    const result = await db.run(`UPDATE folders SET name = ? WHERE id = ? AND user_id = ?`, [newFolderName, folderId, userId]);
    if (result.meta.changes === 0) throw new Error('文件夹未找到');
    return { success: true };
}

// --- 认证 ---

export async function createAuthToken(db, userId, token, expiresAt) {
    await db.run(`INSERT INTO auth_tokens (user_id, token, expires_at) VALUES (?, ?, ?)`, [userId, token, expiresAt]);
}

export async function findAuthToken(db, token) {
    return await db.get(`SELECT t.id, t.user_id, t.expires_at, u.username, u.is_admin FROM auth_tokens t JOIN users u ON t.user_id = u.id WHERE t.token = ?`, [token]);
}

export async function deleteAuthToken(db, token) {
    await db.run(`DELETE FROM auth_tokens WHERE token = ?`, [token]);
}

// --- 扫描与导入 ---

export async function scanStorageAndImport(db, storage, userId, controller) {
    const encoder = new TextEncoder();
    const log = (msg) => controller.enqueue(encoder.encode(msg + '\n'));
    log('开始扫描存储...');
    try {
        if (!storage.list) { log('错误: 当前存储后端不支持列表扫描'); return; }
        const prefix = `${userId}/`;
        const remoteFiles = await storage.list(prefix);
        log(`扫描到 ${remoteFiles.length} 个文件，开始比对...`);
        const rootFolder = await getRootFolder(db, userId);
        let importedCount = 0;
        for (const remote of remoteFiles) {
            const filename = path.basename(remote.fileId);
            if (filename.startsWith('.')) continue;
            const existing = await db.get("SELECT message_id FROM files WHERE file_id = ? AND user_id = ?", [remote.fileId, userId]);
            if (!existing) {
                const messageId = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
                const uniqueName = await getUniqueName(db, rootFolder.id, filename, userId, 'file');
                
                await addFile(db, {
                    message_id: messageId, fileName: uniqueName, mimetype: 'application/octet-stream',
                    file_id: remote.fileId, size: remote.size, date: remote.updatedAt || Date.now()
                }, rootFolder.id, userId, 'imported');
                log(`[导入] ${uniqueName} (${(remote.size/1024).toFixed(1)} KB)`);
                importedCount++;
            }
        }
        log(`扫描完成。新增导入 ${importedCount} 个文件。`);
    } catch (e) { log(`扫描过程发生错误: ${e.message}`); }
}
