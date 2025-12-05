// src/data.js

import path from 'node:path';
import bcrypt from 'bcryptjs';
import { encrypt, decrypt } from './crypto.js';

const ALL_FILE_COLUMNS = `
    fileName, mimetype, file_id, thumb_file_id, date, size, folder_id, user_id, storage_type, is_deleted, deleted_at
`;
const SAFE_SELECT_MESSAGE_ID = `CAST(message_id AS TEXT) AS message_id`;
const SAFE_SELECT_ID_AS_TEXT = `CAST(message_id AS TEXT) AS id`;

// =================================================================================
// 辅助函数：路径计算 (用于物理存储映射)
// =================================================================================

// 获取文件夹的相对路径字符串 (例如 "Docs/Work/")
export async function getFolderPathString(db, folderId, userId) {
    let pathParts = [];
    let currentId = folderId;
    
    // 循环向上查找父目录
    while (currentId) {
        const folder = await db.get("SELECT id, name, parent_id FROM folders WHERE id = ? AND user_id = ?", [currentId, userId]);
        if (!folder) break;
        if (folder.parent_id === null) break; // 到达根目录，停止（根目录不显示在路径中）
        
        pathParts.unshift(folder.name);
        currentId = folder.parent_id;
    }
    
    // 如果有路径，添加结尾斜杠
    return pathParts.length > 0 ? pathParts.join('/') + '/' : '';
}

// 获取文件的完整物理路径 (例如 "/1/Docs/file.txt") - 主要用于 WebDAV
async function getFilePhysicalPath(db, fileId, userId) {
    const file = await db.get("SELECT fileName, folder_id, file_id FROM files WHERE message_id = ?", [fileId.toString()]);
    if (!file) return null;
    
    // 如果是 WebDAV，我们需要计算完整路径
    const folderPath = await getFolderPathString(db, file.folder_id, userId);
    return `/${userId}/${folderPath}${file.fileName}`;
}

// 获取文件夹的完整物理路径 - 主要用于 WebDAV
async function getFolderPhysicalPath(db, folderId, userId) {
    const folderPath = await getFolderPathString(db, folderId, userId);
    // getFolderPathString 返回 "A/B/"，我们需要 "/userId/A/B"
    // 注意去掉末尾斜杠以适配 WebDAV MOVE 操作
    const cleanPath = folderPath.endsWith('/') ? folderPath.slice(0, -1) : folderPath;
    return `/${userId}/${cleanPath}`;
}

// =================================================================================
// 用户管理模块
// =================================================================================

export async function createUser(db, username, hashedPassword) {
    const sql = `INSERT INTO users (username, password, is_admin, max_storage_bytes) VALUES (?, ?, 0, 1073741824)`;
    const result = await db.run(sql, [username, hashedPassword]);
    
    // 兼容性修复：如果 last_row_id 不存在，尝试反查
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
// 用户配额管理
// =================================================================================

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
        id: user.id,
        username: user.username,
        is_admin: user.is_admin,
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
// 核心文件操作
// =================================================================================

export async function addFile(db, fileData, folderId = 1, userId, storageType) {
    const { message_id, fileName, mimetype, file_id, thumb_file_id, date, size } = fileData;
    const sql = `INSERT INTO files (message_id, fileName, mimetype, file_id, thumb_file_id, date, size, folder_id, user_id, storage_type)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const result = await db.run(sql, [message_id.toString(), fileName, mimetype, file_id, thumb_file_id, date, size, folderId, userId, storageType]);
    return { success: true, id: result.meta.last_row_id, fileId: message_id };
}

export async function updateFile(db, fileId, updates, userId) {
    const fields = [];
    const values = [];
    const validKeys = ['fileName', 'mimetype', 'file_id', 'thumb_file_id', 'size', 'date', 'message_id'];

    for (const key in updates) {
        if (Object.hasOwnProperty.call(updates, key) && validKeys.includes(key)) {
            fields.push(`${key} = ?`);
            values.push(key === 'message_id' ? updates[key].toString() : updates[key]);
        }
    }
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

// =================================================================================
// 文件夹与路径操作
// =================================================================================

// 创建文件夹 (支持物理存储同步创建)
export async function createFolder(db, name, parentId, userId, storage = null) {
    const sql = `INSERT INTO folders (name, parent_id, user_id) VALUES (?, ?, ?)`;
    try {
        const result = await db.run(sql, [name, parentId, userId]);
        
        // 关键修复：确保获取到 ID。如果 last_row_id 不存在，则手动查询。
        let newId = result?.meta?.last_row_id;
        
        if (!newId) {
            // 回退方案：根据名称和父ID反查
            let querySql = "";
            let params = [];
            if (parentId === null) {
                querySql = "SELECT id FROM folders WHERE name = ? AND parent_id IS NULL AND user_id = ?";
                params = [name, userId];
            } else {
                querySql = "SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?";
                params = [name, parentId, userId];
            }
            const row = await db.get(querySql, params);
            if (row) newId = row.id;
        }

        // 物理存储创建：S3 和 WebDAV 都执行此逻辑
        // 这确保了存储桶里会有对应的目录结构
        if (newId && storage && storage.createDir) {
            const pathStr = await getFolderPathString(db, newId, userId);
            if (pathStr) {
                // 异步调用，不阻塞 DB 返回
                storage.createDir(pathStr, userId).catch(err => console.error("物理目录创建失败:", err));
            }
        }
        
        return { success: true, id: newId };
    } catch (err) {
        // 处理同名文件夹：如果存在且已删除，则恢复
        if (err.message && err.message.includes('UNIQUE')) {
            // 简化处理，直接报错
            return { success: false, message: '文件夹已存在' };
        }
        throw err;
    }
}

export async function getFolderContents(db, folderId, userId) {
    const sqlFolders = `SELECT id, name, parent_id, 'folder' as type, password IS NOT NULL as is_locked FROM folders WHERE parent_id = ? AND user_id = ? AND is_deleted = 0 ORDER BY name ASC`;
    const sqlFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS}, ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, 'file' as type FROM files WHERE folder_id = ? AND user_id = ? AND is_deleted = 0 ORDER BY name ASC`;
    
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
    let pathArr = [];
    let currentId = folderId;
    
    while (currentId) {
        const folder = await db.get("SELECT id, name, parent_id FROM folders WHERE id = ? AND user_id = ?", [currentId, userId]);
        if (folder) {
            pathArr.unshift({ id: folder.id, name: folder.name, encrypted_id: encrypt(folder.id) });
            currentId = folder.parent_id;
        } else {
            break;
        }
    }
    return pathArr;
}

export async function getAllFolders(db, userId) {
    const sql = "SELECT id, name, parent_id FROM folders WHERE user_id = ? AND is_deleted = 0 ORDER BY parent_id, name ASC";
    const rows = await db.all(sql, [userId]);
    return rows.map(folder => ({
        ...folder,
        encrypted_id: encrypt(folder.id)
    }));
}

// =================================================================================
// 搜索功能
// =================================================================================

export async function searchItems(db, query, userId) {
    const searchQuery = `%${query}%`;
    // 使用递归 CTE 排除被锁定或已删除文件夹下的内容
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
        WHERE f.fileName LIKE ? AND f.user_id = ? AND fs.is_path_locked = 0 AND fs.is_path_deleted = 0 AND f.is_deleted = 0
        ORDER BY f.date DESC;
    `;
    const sqlFolders = baseQuery + `
        SELECT f.id, f.name, f.parent_id, 'folder' as type, (f.password IS NOT NULL) as is_locked
        FROM folders f JOIN folder_status fs ON f.id = fs.id
        WHERE f.name LIKE ? AND f.user_id = ? AND fs.is_path_locked = 0 AND fs.is_path_deleted = 0 AND f.is_deleted = 0 AND f.parent_id IS NOT NULL
        ORDER BY f.name ASC;
    `;
    const folders = await db.all(sqlFolders, [userId, userId, searchQuery, userId]);
    const files = await db.all(sqlFiles, [userId, userId, searchQuery, userId]);
    return { folders: folders.map(f => ({ ...f, encrypted_id: encrypt(f.id) })), files };
}

// =================================================================================
// 移动、重命名 (WebDAV 增强)
// =================================================================================

export async function moveItems(db, storage, fileIds = [], folderIds = [], targetFolderId, userId) {
    const isWebDAV = storage && storage.isWebDAV;
    
    // 1. 移动文件
    if (fileIds.length > 0) {
        for (const fid of fileIds) {
            if (isWebDAV) {
                // 计算物理路径进行移动
                const oldPath = await getFilePhysicalPath(db, fid, userId);
                const targetPathStr = await getFolderPathString(db, targetFolderId, userId);
                const fileName = oldPath.split('/').pop(); 
                const newPath = `/${userId}/${targetPathStr}${fileName}`;
                
                try { await storage.moveFile(oldPath, newPath); } catch(e) { console.error("WebDAV 文件移动失败", e); }
                
                // 更新 WebDAV 下文件在 DB 中的路径引用 (file_id 字段)
                await db.run(`UPDATE files SET file_id=? WHERE message_id=?`, [newPath, fid.toString()]);
            }
        }
        
        const place = fileIds.map(() => '?').join(',');
        await db.run(`UPDATE files SET folder_id = ? WHERE message_id IN (${place}) AND user_id = ?`, [targetFolderId, ...fileIds.map(id => id.toString()), userId]);
    }

    // 2. 移动文件夹
    if (folderIds.length > 0) {
        for (const fid of folderIds) {
            if (isWebDAV) {
                const oldPath = await getFolderPhysicalPath(db, fid, userId);
                const targetPathStr = await getFolderPathString(db, targetFolderId, userId);
                const folderName = oldPath.split('/').pop();
                const newPath = `/${userId}/${targetPathStr}${folderName}`;
                
                try { await storage.moveFile(oldPath, newPath); } catch(e) { console.error("WebDAV 目录移动失败", e); }
            }
        }
        
        const place = folderIds.map(() => '?').join(',');
        await db.run(`UPDATE folders SET parent_id = ? WHERE id IN (${place}) AND user_id = ?`, [targetFolderId, ...folderIds, userId]);
    }
    return { success: true };
}

export async function renameFile(db, storage, messageId, newFileName, userId) {
    if (storage && storage.isWebDAV) {
        const oldPath = await getFilePhysicalPath(db, messageId, userId);
        const folderPath = oldPath.substring(0, oldPath.lastIndexOf('/') + 1);
        const newPath = folderPath + newFileName;
        await storage.moveFile(oldPath, newPath);
        // 更新物理路径引用
        await db.run(`UPDATE files SET file_id=? WHERE message_id=?`, [newPath, messageId.toString()]);
    }
    const result = await db.run(`UPDATE files SET fileName = ? WHERE message_id = ? AND user_id = ?`, [newFileName, messageId.toString(), userId]);
    if (result.meta.changes === 0) throw new Error('文件未找到');
    return { success: true };
}

export async function renameFolder(db, storage, folderId, newFolderName, userId) {
    if (storage && storage.isWebDAV) {
        const oldPath = await getFolderPhysicalPath(db, folderId, userId);
        const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/') + 1);
        const newPath = parentPath + newFolderName;
        await storage.moveFile(oldPath, newPath);
    }
    const result = await db.run(`UPDATE folders SET name = ? WHERE id = ? AND user_id = ?`, [newFolderName, folderId, userId]);
    if (result.meta.changes === 0) throw new Error('文件夹未找到');
    return { success: true };
}

// =================================================================================
// 统一删除 (物理 + DB)
// =================================================================================

export async function unifiedDelete(db, storage, itemId, itemType, userId, explicitFileIds = null, explicitFolderIds = null) {
    let filesForStorage = [];
    let folderPathsForStorage = [];
    
    // 1. 收集需要删除的文件
    if (explicitFileIds || explicitFolderIds) {
        if (explicitFileIds && explicitFileIds.length > 0) {
             filesForStorage.push(...await getFilesByIds(db, explicitFileIds, userId));
        }
        if (explicitFolderIds && explicitFolderIds.length > 0) {
             for(const fid of explicitFolderIds) {
                 const deletionData = await getFolderDeletionData(db, fid, userId);
                 filesForStorage.push(...deletionData.files);
                 // WebDAV 需要物理文件夹路径
                 if (storage && storage.isWebDAV) {
                     const pathStr = await getFolderPhysicalPath(db, fid, userId);
                     if(pathStr) folderPathsForStorage.push({ path: pathStr, id: fid });
                 }
             }
        }
    } else {
        // 单个删除逻辑 (旧兼容)
        if (itemType === 'folder') {
            const deletionData = await getFolderDeletionData(db, itemId, userId);
            filesForStorage.push(...deletionData.files);
            if (storage && storage.isWebDAV) {
                const pathStr = await getFolderPhysicalPath(db, itemId, userId);
                if(pathStr) folderPathsForStorage.push({ path: pathStr, id: itemId });
            }
        } else {
            filesForStorage.push(...await getFilesByIds(db, [itemId], userId));
        }
    }
    
    // 2. 执行物理删除
    if (storage && storage.remove) {
        try {
            await storage.remove(filesForStorage, folderPathsForStorage, userId);
        } catch (err) {
            console.error("实体文件删除失败:", err);
        }
    }
    
    // 3. 执行数据库硬删除
    const fileIdsToDelete = filesForStorage.map(f => BigInt(f.message_id));
    let folderIdsToDelete = explicitFolderIds || [];
    
    // 注意：如果是删除单个文件夹，unifiedDelete 的 explicitFolderIds 为空，需补充
    if (!explicitFolderIds && !explicitFileIds && itemType === 'folder') {
        folderIdsToDelete.push(itemId);
    }
    
    await executeDeletion(db, fileIdsToDelete, folderIdsToDelete, userId);
}

// 辅助：递归获取文件夹下所有文件 (用于删除)
export async function getFolderDeletionData(db, folderId, userId) {
    let filesToDelete = [];
    async function findContentsRecursive(currentFolderId) {
        const sqlFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files WHERE folder_id = ? AND user_id = ?`;
        const files = await db.all(sqlFiles, [currentFolderId, userId]);
        filesToDelete.push(...files);
        
        const sqlFolders = `SELECT id FROM folders WHERE parent_id = ? AND user_id = ?`;
        const subFolders = await db.all(sqlFolders, [currentFolderId, userId]);
        for (const subFolder of subFolders) {
            await findContentsRecursive(subFolder.id);
        }
    }
    await findContentsRecursive(folderId);
    return { files: filesToDelete };
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

// =================================================================================
// 回收站与软删除
// =================================================================================

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

// [重构] 还原项目：增加自动重命名逻辑，防止同名冲突
export async function restoreItems(db, fileIds = [], folderIds = [], userId) {
    // 1. 恢复文件 (带冲突检测和自动重命名)
    if (fileIds.length > 0) {
        const stringFileIds = fileIds.map(id => id.toString());
        // 获取要恢复的文件详情
        const filesToRestore = await getFilesByIds(db, stringFileIds, userId);

        for (const file of filesToRestore) {
            let checkName = file.fileName;
            let counter = 1;
            
            // 循环检查目标文件夹下是否存在同名且未删除的文件
            while (true) {
                // 检查是否存在同名且 is_deleted=0 的文件
                const existing = await db.get(
                    "SELECT 1 FROM files WHERE folder_id = ? AND user_id = ? AND is_deleted = 0 AND fileName = ?", 
                    [file.folder_id, userId, checkName]
                );
                if (!existing) break; // 没有冲突，跳出循环
                
                // 生成新文件名: name.txt -> name (1).txt -> name (2).txt
                const lastDotIndex = file.fileName.lastIndexOf('.');
                if (lastDotIndex !== -1) {
                    const name = file.fileName.substring(0, lastDotIndex);
                    const ext = file.fileName.substring(lastDotIndex);
                    checkName = `${name} (${counter})${ext}`;
                } else {
                    checkName = `${file.fileName} (${counter})`;
                }
                counter++;
            }
            
            // 执行恢复，如果名字变了则同时更新文件名
            await db.run(
                `UPDATE files SET is_deleted = 0, deleted_at = NULL, fileName = ? WHERE message_id = ? AND user_id = ?`, 
                [checkName, file.message_id, userId]
            );
        }
    }

    // 2. 恢复文件夹 (带冲突检测和自动重命名，防止触发 UNIQUE 约束报错)
    if (folderIds.length > 0) {
         for (const folderId of folderIds) {
            const folder = await db.get("SELECT name, parent_id FROM folders WHERE id = ?", [folderId]);
            if (!folder) continue;
            
            let checkName = folder.name;
            let counter = 1;
            
            while (true) {
                let querySql = "";
                let params = [];
                if (folder.parent_id === null) {
                    querySql = "SELECT 1 FROM folders WHERE parent_id IS NULL AND user_id = ? AND is_deleted = 0 AND name = ? AND id != ?";
                    params = [userId, checkName, folderId];
                } else {
                    querySql = "SELECT 1 FROM folders WHERE parent_id = ? AND user_id = ? AND is_deleted = 0 AND name = ? AND id != ?";
                    params = [folder.parent_id, userId, checkName, folderId];
                }
                
                const existing = await db.get(querySql, params);
                if (!existing) break;
                
                checkName = `${folder.name} (${counter})`;
                counter++;
            }

            await db.run(
                `UPDATE folders SET is_deleted = 0, deleted_at = NULL, name = ? WHERE id = ? AND user_id = ?`,
                [checkName, folderId, userId]
            );
         }
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

// =================================================================================
// 分享与加密
// =================================================================================

export async function createShareLink(db, itemId, itemType, expiresIn, userId, password = null, customExpiresAt = null) {
    const tokenArray = new Uint8Array(8); 
    crypto.getRandomValues(tokenArray);
    const token = Array.from(tokenArray).map(b => b.toString(16).padStart(2, '0')).join('');

    let expiresAt = null;
    if (expiresIn !== '0') { 
        const now = Date.now();
        if (expiresIn === 'custom' && customExpiresAt) {
            expiresAt = parseInt(customExpiresAt, 10);
        } else {
            const hour = 3600000;
            const day = 24 * hour;
            if (expiresIn === '1h') expiresAt = now + hour;
            else if (expiresIn === '24h') expiresAt = now + day;
            else if (expiresIn === '7d') expiresAt = now + 7 * day;
            else expiresAt = now + day;
        }
    }

    const table = itemType === 'folder' ? 'folders' : 'files';
    const idColumn = itemType === 'folder' ? 'id' : 'message_id';
    let hashedPassword = null;
    if (password && password.length > 0) {
        const salt = await bcrypt.genSalt(10);
        hashedPassword = await bcrypt.hash(password, salt);
    }

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

// =================================================================================
// 认证 / 扫描
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
                await addFile(db, {
                    message_id: messageId, fileName: filename, mimetype: 'application/octet-stream',
                    file_id: remote.fileId, size: remote.size, date: remote.updatedAt || Date.now()
                }, rootFolder.id, userId, 'imported');
                log(`[导入] ${filename} (${(remote.size/1024).toFixed(1)} KB)`);
                importedCount++;
            }
        }
        log(`扫描完成。新增导入 ${importedCount} 个文件。`);
    } catch (e) { log(`扫描过程发生错误: ${e.message}`); }
}

// =================================================================================
// 上传冲突检查 (新增)
// =================================================================================

export async function checkFileExistence(db, files, folderId, userId) {
    if (!files || files.length === 0) return [];
    
    const names = files.map(f => f.relativePath);
    const placeholders = names.map(() => '?').join(',');
    
    // 关键修正：添加 AND is_deleted = 0 条件，忽略回收站中的文件
    const sql = `SELECT fileName FROM files WHERE folder_id = ? AND user_id = ? AND is_deleted = 0 AND fileName IN (${placeholders})`;
    
    const existing = await db.all(sql, [folderId, userId, ...names]);
    const existingSet = new Set(existing.map(e => e.fileName));
    
    return files.map(f => ({
        relativePath: f.relativePath,
        exists: existingSet.has(f.relativePath)
    }));
}
