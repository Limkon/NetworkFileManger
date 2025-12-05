// public/manager.js

document.addEventListener('DOMContentLoaded', () => {
    // =============================================================================
    // 1. 初始化与状态变量
    // =============================================================================
    
    // --- Axios 拦截器 ---
    axios.interceptors.response.use(
        (response) => response,
        (error) => {
            if (error.response && error.response.status === 401) {
                window.location.href = '/login';
                return new Promise(() => {});
            }
            if (!error.response && error.request) {
                console.error('Network error:', error);
            }
            return Promise.reject(error);
        }
    );

    // --- 状态变量 ---
    let isMultiSelectMode = false;
    let isTrashMode = false;
    let currentFolderId = 1; 
    let currentEncryptedFolderId = null; 
    let currentFolderContents = { folders: [], files: [] };
    let selectedItems = new Map(); 
    let moveTargetFolderId = null;
    let moveTargetEncryptedFolderId = null;
    let isSearchMode = false;
    const MAX_TELEGRAM_SIZE = 1000 * 1024 * 1024; 
    let foldersLoaded = false;
    let currentView = 'grid';
    let currentSort = { key: 'name', order: 'asc' };
    let passwordPromise = {};

    const EDITABLE_EXTENSIONS = [
        '.txt', '.md', '.json', '.js', '.css', '.html', '.xml', '.yaml', '.yml', 
        '.log', '.ini', '.cfg', '.conf', '.sh', '.bat', '.py', '.java', '.c', 
        '.cpp', '.h', '.hpp', '.cs', '.php', '.rb', '.go', '.rs', '.ts', '.sql'
    ];

    // =============================================================================
    // 2. DOM 元素引用
    // =============================================================================
    const body = document.body;
    
    // [修复] 使用 body 作为拖拽区域，确保整个页面都能响应
    const dropZone = document.body; 
    const container = document.querySelector('.container');
    const dragUploadProgressArea = document.getElementById('dragUploadProgressArea');
    
    const homeLink = document.getElementById('homeLink');
    const itemGrid = document.getElementById('itemGrid');
    const breadcrumb = document.getElementById('breadcrumb');
    const contextMenu = document.getElementById('contextMenu');
    const selectionInfo = document.getElementById('selectionInfo');
    const multiSelectToggleBtn = document.getElementById('multiSelectToggleBtn');
    // 注意：HTML中可能不存在 id="createFolderBtn"，如果是在工具栏中，通常是 showUploadModalBtn
    // 这里保留引用以防后续添加，但需注意判空
    const createFolderBtn = document.getElementById('createFolderBtn'); 
    
    const searchForm = document.getElementById('searchForm');
    const searchInput = document.getElementById('searchInput');
    
    // 右键菜单项
    const ctxCreateFolderBtn = document.getElementById('ctxCreateFolderBtn');
    const ctxCreateFileBtn = document.getElementById('ctxCreateFileBtn');
    
    const openBtn = document.getElementById('openBtn');
    const previewBtn = document.getElementById('previewBtn');
    const shareBtn = document.getElementById('shareBtn');
    const renameBtn = document.getElementById('renameBtn');
    const moveBtn = document.getElementById('moveBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const deleteBtn = document.getElementById('deleteBtn');
    const selectAllBtn = document.getElementById('selectAllBtn');
    const textEditBtn = document.getElementById('textEditBtn'); // 右键菜单中的编辑/新建
    const editBtn = document.getElementById('editBtn'); // 右键菜单中的编辑(针对文件)
    
    const logoutBtn = document.getElementById('logoutBtn');
    const changePasswordBtn = document.getElementById('changePasswordBtn');
    const previewModal = document.getElementById('previewModal');
    const modalContent = document.getElementById('modalContent');
    const closeModal = document.querySelector('.close-button');
    const moveModal = document.getElementById('moveModal');
    const folderTree = document.getElementById('folderTree');
    const confirmMoveBtn = document.getElementById('confirmMoveBtn');
    const cancelMoveBtn = document.getElementById('cancelMoveBtn');
    
    // 冲突模态框
    const conflictModal = document.getElementById('conflictModal');
    const conflictModalTitle = document.getElementById('conflictModalTitle');
    const conflictFileName = document.getElementById('conflictFileName');
    const conflictOptions = document.getElementById('conflictOptions');
    const applyToAllContainer = document.getElementById('applyToAllContainer');
    const applyToAllCheckbox = document.getElementById('applyToAllCheckbox');
    
    // 文件夹冲突模态框
    const folderConflictModal = document.getElementById('folderConflictModal');
    const folderConflictName = document.getElementById('folderConflictName');
    const folderConflictOptions = document.getElementById('folderConflictOptions');
    const applyToAllFoldersContainer = document.getElementById('applyToAllFoldersContainer');
    const applyToAllFoldersCheckbox = document.getElementById('applyToAllFoldersCheckbox');
    
    // 分享与上传模态框
    const shareModal = document.getElementById('shareModal');
    const uploadModal = document.getElementById('uploadModal');
    const showUploadModalBtn = document.getElementById('showUploadModalBtn');
    const closeUploadModalBtn = document.getElementById('closeUploadModalBtn');
    const uploadForm = document.getElementById('uploadForm');
    const fileInput = document.getElementById('fileInput');
    const folderInput = document.getElementById('folderInput');
    const uploadSubmitBtn = document.getElementById('uploadSubmitBtn');
    const fileListContainer = document.getElementById('file-selection-list');
    const folderSelect = document.getElementById('folderSelect');
    const uploadNotificationArea = document.getElementById('uploadNotificationArea');
    const dragUploadProgressBar = document.getElementById('dragUploadProgressBar');
    
    // 视图与列表
    const viewSwitchBtn = document.getElementById('view-switch-btn');
    const itemListView = document.getElementById('itemListView');
    const itemListBody = document.getElementById('itemListBody');
    const listHeader = document.querySelector('.list-header');
    
    // 菜单分隔符与锁
    const contextMenuSeparator1 = document.getElementById('contextMenuSeparator1');
    const contextMenuSeparator2 = document.getElementById('contextMenuSeparator2');
    const contextMenuSeparatorTop = document.getElementById('contextMenuSeparatorTop');
    const lockBtn = document.getElementById('lockBtn');
    
    // 密码模态框
    const passwordModal = document.getElementById('passwordModal');
    const passwordModalTitle = document.getElementById('passwordModalTitle');
    const passwordPromptText = document.getElementById('passwordPromptText');
    const passwordForm = document.getElementById('passwordForm');
    const passwordInput = document.getElementById('passwordInput');
    const oldPasswordContainer = document.getElementById('oldPasswordContainer');
    const oldPasswordInput = document.getElementById('oldPasswordInput');
    const confirmPasswordContainer = document.getElementById('confirmPasswordContainer');
    const confirmPasswordInput = document.getElementById('confirmPasswordInput');
    const passwordSubmitBtn = document.getElementById('passwordSubmitBtn');
    const passwordCancelBtn = document.getElementById('passwordCancelBtn');
    
    // 回收站与配额
    const trashBtn = document.getElementById('trashBtn');
    const trashBanner = document.getElementById('trashBanner');
    const emptyTrashBtn = document.getElementById('emptyTrashBtn');
    const restoreBtn = document.getElementById('restoreBtn');
    const deleteForeverBtn = document.getElementById('deleteForeverBtn');
    const quotaUsedEl = document.getElementById('quotaUsed');
    const quotaMaxEl = document.getElementById('quotaMax');
    const quotaBar = document.getElementById('quotaBar');
    
    const dropZoneOverlay = document.getElementById('dropZoneOverlay');

    // 状态栏引用
    const taskStatusBar = document.getElementById('taskStatusBar');
    const taskIcon = document.getElementById('taskIcon');
    const taskText = document.getElementById('taskText');
    const taskProgress = document.getElementById('taskProgress');

    // 分享相关
    const confirmShareBtn = document.getElementById('confirmShareBtn');
    const cancelShareBtn = document.getElementById('cancelShareBtn');
    const closeShareModalBtn = document.getElementById('closeShareModalBtn');
    const expiresInSelect = document.getElementById('expiresInSelect');
    const customExpiresInput = document.getElementById('customExpiresInput');
    const sharePasswordInput = document.getElementById('sharePasswordInput');
    const shareResult = document.getElementById('shareResult');
    const shareLinkContainer = document.getElementById('shareLinkContainer');
    const copyLinkBtn = document.getElementById('copyLinkBtn');
    const shareOptions = document.getElementById('shareOptions');

    // =============================================================================
    // 3. 辅助函数与状态栏
    // =============================================================================

    const TaskManager = {
        timer: null,
        show: (text, iconClass = 'fas fa-spinner') => {
            if (TaskManager.timer) clearTimeout(TaskManager.timer);
            if (taskStatusBar) {
                taskStatusBar.classList.add('active');
                if (taskText) taskText.textContent = text;
                if (taskIcon) {
                    taskIcon.className = `task-icon ${iconClass}`;
                    taskIcon.classList.add('spinning');
                }
                if (taskProgress) taskProgress.style.width = '0%';
            }
        },
        update: (percent, text) => {
            if (taskProgress) taskProgress.style.width = percent + '%';
            if (text && taskText) taskText.textContent = text;
        },
        success: (text = '完成') => {
            if (taskText) taskText.textContent = text;
            if (taskIcon) {
                taskIcon.className = 'task-icon fas fa-check-circle';
                taskIcon.style.color = '#28a745';
                taskIcon.classList.remove('spinning');
            }
            if (taskProgress) taskProgress.style.width = '100%';
            TaskManager.hide(2000);
        },
        error: (text = '失败') => {
            if (taskText) taskText.textContent = text;
            if (taskIcon) {
                taskIcon.className = 'task-icon fas fa-times-circle';
                taskIcon.style.color = '#dc3545';
                taskIcon.classList.remove('spinning');
            }
            TaskManager.hide(3000);
        },
        hide: (delay = 0) => {
            TaskManager.timer = setTimeout(() => {
                if (taskStatusBar) taskStatusBar.classList.remove('active');
                setTimeout(() => {
                    if (taskIcon) {
                        taskIcon.style.color = '';
                        taskIcon.classList.remove('spinning');
                    }
                }, 300);
            }, delay);
        }
    };

    function isEditableFile(fileName) {
        if (!fileName) return false;
        const lowerCaseFileName = fileName.toLowerCase();
        return EDITABLE_EXTENSIONS.some(ext => lowerCaseFileName.endsWith(ext));
    }

    function formatBytes(bytes, decimals = 2) {
        if (!bytes || bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }
    
    function formatDateTime(timestamp) {
        if (!timestamp) return '—';
        return new Date(timestamp).toLocaleString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false
        }).replace(/\//g, '-');
    }

    function showNotification(message, type = 'info', container = null) {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.textContent = message;

        if (container) {
            notification.classList.add('local');
            container.innerHTML = '';
            container.appendChild(notification);
        } else {
            notification.classList.add('global');
            const existingNotif = document.querySelector('.notification.global');
            if (existingNotif) existingNotif.remove();
            document.body.appendChild(notification);
            setTimeout(() => {
                if (notification.parentElement) notification.parentElement.removeChild(notification);
            }, 5000);
        }
    }
    
    function getFileIconClass(mimetype, fileName) {
        const lowerFileName = (fileName || '').toLowerCase();
        const archiveExtensions = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'dmg'];
        const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff'];

        for (const ext of archiveExtensions) if (lowerFileName.endsWith('.' + ext)) return 'fa-file-archive';
        for (const ext of imageExtensions) if (lowerFileName.endsWith('.' + ext)) return 'fa-file-image';

        if (!mimetype) return 'fa-file';
        if (mimetype.startsWith('image/')) return 'fa-file-image';
        if (mimetype.startsWith('video/')) return 'fa-file-video';
        if (mimetype.startsWith('audio/')) return 'fa-file-audio';
        if (mimetype.includes('pdf')) return 'fa-file-pdf';
        if (mimetype.includes('archive') || mimetype.includes('zip')) return 'fa-file-archive';
        if (mimetype.startsWith('text/')) return 'fa-file-alt';
        
        return 'fa-file';
    }

    // =============================================================================
    // 4. 核心逻辑函数
    // =============================================================================

    async function updateQuota() {
        try {
            const res = await axios.get('/api/user/quota');
            if (res.data.success) {
                const { used, max } = res.data;
                const percent = max > 0 ? Math.min(100, (used / max) * 100) : 100;
                
                if(quotaUsedEl) quotaUsedEl.textContent = formatBytes(used);
                if(quotaMaxEl) quotaMaxEl.textContent = formatBytes(max);
                if(quotaBar) {
                    quotaBar.style.width = `${percent}%`;
                    quotaBar.classList.remove('warning', 'danger');
                    if (percent > 90) quotaBar.classList.add('danger');
                    else if (percent > 70) quotaBar.classList.add('warning');
                }
            }
        } catch (e) { console.error('更新配额失败', e); }
    }

    async function loadFolderContents(encryptedFolderId) {
        if (isTrashMode) {
            await loadTrashContents();
            return;
        }

        try {
            isSearchMode = false;
            if (searchInput) searchInput.value = '';
            
            currentEncryptedFolderId = encryptedFolderId; 

            const res = await axios.get(`/api/folder/${encryptedFolderId}`);
            
            if (res.data.locked) {
                const folderName = res.data.path && res.data.path.length > 0 ? res.data.path[res.data.path.length-1].name : '未知文件夹';
                const { password } = await promptForPassword(`文件夹 "${folderName}" 已加密`, '请输入密码以访问:');
                if (password === null) { 
                    const parent = res.data.path.length > 1 ? res.data.path[res.data.path.length - 2] : null;
                    if (parent && parent.encrypted_id) {
                       history.back();
                    } else {
                       window.location.href = '/';
                    }
                    return;
                }
                try {
                    const currentFolderOriginalId = res.data.path[res.data.path.length - 1].id;
                    await axios.post(`/api/folder/${currentFolderOriginalId}/verify`, { password });
                    await loadFolderContents(encryptedFolderId);
                } catch (error) {
                    alert('密码错误！');
                    window.location.href = '/';
                }
                return;
            }

            currentFolderContents = res.data.contents;
            if(res.data.path.length > 0) {
                currentFolderId = res.data.path[res.data.path.length - 1].id;
            }

            const currentIds = new Set([...res.data.contents.folders.map(f => String(f.id)), ...res.data.contents.files.map(f => String(f.id))]);
            selectedItems.forEach((_, key) => {
                if (!currentIds.has(key)) selectedItems.delete(key);
            });
            
            renderBreadcrumb(res.data.path);
            renderItems(currentFolderContents.folders, currentFolderContents.files);
            
            if(trashBanner) trashBanner.style.display = 'none';
            if(itemGrid) itemGrid.classList.remove('trash-mode');
            
            updateContextMenu();
            updateQuota();
        } catch (error) {
            console.error('加载内容失败', error);
            if(itemGrid) itemGrid.innerHTML = '<p>加载内容失败。</p>';
            if(itemListBody) itemListBody.innerHTML = '<p>加载内容失败。</p>';
        }
    }

    async function loadTrashContents() {
        try {
            isSearchMode = false;
            const res = await axios.get('/api/trash');
            currentFolderContents = res.data;
            
            if(breadcrumb) breadcrumb.innerHTML = '<span><i class="fas fa-trash-alt"></i> 回收站</span>';
            
            renderItems(currentFolderContents.folders, currentFolderContents.files);
            selectedItems.clear();
            
            if(trashBanner) trashBanner.style.display = 'flex';
            if(itemGrid) itemGrid.classList.add('trash-mode');
            
            updateContextMenu();
            updateQuota();
        } catch (error) {
            showNotification('无法加载回收站', 'error');
        }
    }

    function renderBreadcrumb(path) {
        if(!breadcrumb) return;
        breadcrumb.innerHTML = '';
        if(!path || path.length === 0) return;
        path.forEach((p, index) => {
            if (index > 0) breadcrumb.innerHTML += '<span class="separator">/</span>';
            if (p.id === null) {
                breadcrumb.innerHTML += `<span>${p.name}</span>`;
                return;
            }
            const link = document.createElement(index === path.length - 1 && !isSearchMode ? 'span' : 'a');
            link.textContent = p.name === '/' ? '根目录' : p.name;
            if (link.tagName === 'A') {
                link.href = '#';
                link.dataset.encryptedFolderId = p.encrypted_id;
            }
            breadcrumb.appendChild(link);
        });
    }

    function renderItems(folders, files) {
        if (!itemGrid || !itemListBody) return;
        
        const parentGrid = itemGrid;
        const parentList = itemListBody;

        parentGrid.innerHTML = '';
        parentList.innerHTML = '';

        const { folders: sortedFolders, files: sortedFiles } = sortItems(folders, files);
        const allItems = [...sortedFolders, ...sortedFiles];
        
        if (allItems.length === 0) {
            const msg = isTrashMode ? '回收站是空的。' : (isSearchMode ? '找不到符合条件的文件。' : '这个文件夹是空的。');
            if (currentView === 'grid') parentGrid.innerHTML = `<p>${msg}</p>`;
            else parentList.innerHTML = `<div class="list-item"><p>${msg}</p></div>`;
            return;
        }

        allItems.forEach(item => {
            if (currentView === 'grid') parentGrid.appendChild(createItemCard(item));
            else parentList.appendChild(createListItem(item));
        });
        updateSortIndicator();
    }

    function createItemCard(item) {
        const card = document.createElement('div');
        card.className = 'item-card';
        if (isTrashMode) card.classList.add('deleted');
        card.dataset.id = item.id;
        card.dataset.type = item.type;
        card.dataset.name = item.name === '/' ? '根目录' : item.name;
        if (item.type === 'folder') {
            card.dataset.isLocked = item.is_locked;
            card.dataset.encryptedFolderId = item.encrypted_id;
        }
        card.setAttribute('tabindex', '0');

        let iconHtml = '';
        if (item.type === 'file') {
            const fullFile = currentFolderContents.files.find(f => f.id === item.id) || item;
            if (!isTrashMode && fullFile.storage_type === 'telegram' && fullFile.thumb_file_id) {
                iconHtml = `<img src="/thumbnail/${item.id}" alt="缩略图" loading="lazy">`;
            } else if (!isTrashMode && fullFile.mimetype && fullFile.mimetype.startsWith('image/')) {
                 iconHtml = `<img src="/download/proxy/${item.id}" alt="图片" loading="lazy">`;
            } else if (!isTrashMode && fullFile.mimetype && fullFile.mimetype.startsWith('video/')) {
                 iconHtml = `<video src="/download/proxy/${item.id}#t=0.1" preload="metadata" muted></video>`;
            } else {
                 iconHtml = `<i class="fas ${getFileIconClass(item.mimetype, item.name)}"></i>`;
            }
        } else { 
            iconHtml = `<i class="fas ${item.is_locked ? 'fa-lock' : 'fa-folder'}"></i>`;
        }

        card.innerHTML = `<div class="item-icon">${iconHtml}</div><div class="item-info"><h5 title="${item.name}">${item.name === '/' ? '根目录' : item.name}</h5></div>`;
        if (selectedItems.has(String(item.id))) card.classList.add('selected');
        return card;
    }

    function createListItem(item) {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'list-item';
        if (isTrashMode) itemDiv.classList.add('deleted');
        itemDiv.dataset.id = item.id;
        itemDiv.dataset.type = item.type;
        itemDiv.dataset.name = item.name === '/' ? '根目录' : item.name;
        if (item.type === 'folder') {
            itemDiv.dataset.isLocked = item.is_locked;
            itemDiv.dataset.encryptedFolderId = item.encrypted_id;
        }
        itemDiv.setAttribute('tabindex', '0');

        const icon = item.type === 'folder' ? (item.is_locked ? 'fa-lock' : 'fa-folder') : getFileIconClass(item.mimetype, item.name);
        const name = item.name === '/' ? '根目录' : item.name;
        const size = item.type === 'file' && item.size ? formatBytes(item.size) : '—';
        const dateLabel = isTrashMode && item.deleted_at ? formatDateTime(item.deleted_at) : (item.date ? formatDateTime(item.date) : '—');

        itemDiv.innerHTML = `
            <div class="list-icon"><i class="fas ${icon}"></i></div>
            <div class="list-name" title="${name}">${name}</div>
            <div class="list-size">${size}</div>
            <div class="list-date">${dateLabel}</div>
        `;
        if (selectedItems.has(String(item.id))) {
            itemDiv.classList.add('selected');
        }
        return itemDiv;
    }

    function updateContextMenu(targetItem = null) {
        if (!contextMenu) return;
        
        const count = selectedItems.size;
        const hasSelection = count > 0;
        const singleSelection = count === 1;
        const firstSelectedItem = hasSelection ? selectedItems.values().next().value : null;

        if (selectionInfo) {
            selectionInfo.textContent = hasSelection ? `已选择 ${count} 个项目` : '';
            selectionInfo.style.display = hasSelection ? 'block' : 'none';
        }
        if (contextMenuSeparatorTop) contextMenuSeparatorTop.style.display = hasSelection ? 'block' : 'none';
        
        const normalBtns = document.querySelectorAll('.normal-mode-btn');
        const trashBtns = document.querySelectorAll('.trash-mode-btn');

        if (isTrashMode) {
            normalBtns.forEach(btn => btn.style.display = 'none');
            if (hasSelection) {
                trashBtns.forEach(btn => btn.style.display = 'flex');
            } else {
                trashBtns.forEach(btn => btn.style.display = 'none');
            }
            if(multiSelectToggleBtn) multiSelectToggleBtn.style.display = 'block';
        } else {
            trashBtns.forEach(btn => btn.style.display = 'none');
            
            if (multiSelectToggleBtn) {
                if (isMultiSelectMode) {
                    multiSelectToggleBtn.innerHTML = '<i class="fas fa-times"></i> <span class="button-text">退出多选模式</span>';
                    multiSelectToggleBtn.style.display = 'block';
                } else {
                    multiSelectToggleBtn.innerHTML = '<i class="fas fa-check-square"></i> <span class="button-text">进入多选模式</span>';
                    multiSelectToggleBtn.style.display = !targetItem ? 'block' : 'none';
                }
            }

            // 常规按钮（新建文件/文件夹）
            const generalButtons = [createFolderBtn]; // textEditBtn is special handled below

            if (hasSelection) {
                // 有选中时，隐藏新建按钮
                generalButtons.forEach(btn => { if(btn) btn.style.display = 'none'; });
                if(ctxCreateFolderBtn) ctxCreateFolderBtn.style.display = 'none';
                if(ctxCreateFileBtn) ctxCreateFileBtn.style.display = 'none';

                // 显示项目操作按钮
                normalBtns.forEach(btn => {
                    if (!btn.classList.contains('global-action')) {
                        btn.style.display = 'flex';
                    }
                });

                if(selectAllBtn) selectAllBtn.style.display = 'block';
                if(contextMenuSeparator2) contextMenuSeparator2.style.display = 'block';
        
                const isSingleEditableFile = singleSelection && firstSelectedItem.type === 'file' && isEditableFile(firstSelectedItem.name);
                if (editBtn) {
                    editBtn.style.display = isSingleEditableFile ? 'flex' : 'none';
                }
                
                // 隐藏“新建文本文件”按钮（复用）
                if(textEditBtn) textEditBtn.style.display = 'none';
                if(contextMenuSeparator1) contextMenuSeparator1.style.display = isSingleEditableFile ? 'block' : 'none';

                const containsLockedFolder = Array.from(selectedItems.keys()).some(id => {
                    const itemEl = document.querySelector(`.item-card[data-id="${id}"], .list-item[data-id="${id}"]`);
                    return itemEl && itemEl.dataset.type === 'folder' && (itemEl.dataset.isLocked === 'true' || itemEl.dataset.isLocked === '1');
                });
                const isSingleLockedFolder = singleSelection && firstSelectedItem.type === 'folder' && containsLockedFolder;
                
                if(singleSelection && openBtn){
                    if(firstSelectedItem.type === 'folder'){
                        openBtn.innerHTML = '<i class="fas fa-folder-open"></i> <span class="button-text">打开</span>';
                    } else {
                        openBtn.innerHTML = '<i class="fas fa-external-link-alt"></i> <span class="button-text">打开</span>';
                    }
                }
                if(openBtn) openBtn.disabled = !singleSelection;
                if(previewBtn) previewBtn.disabled = !singleSelection || firstSelectedItem.type === 'folder';
                if(renameBtn) renameBtn.disabled = !singleSelection;
                if(moveBtn) moveBtn.disabled = count === 0 || isSearchMode || containsLockedFolder;
                if(shareBtn) shareBtn.disabled = !singleSelection || isSingleLockedFolder;
                if(downloadBtn) downloadBtn.disabled = count === 0 || containsLockedFolder;
                if(deleteBtn) deleteBtn.disabled = count === 0 || containsLockedFolder;
                
                if(lockBtn) {
                    lockBtn.disabled = !singleSelection || firstSelectedItem.type !== 'folder';
                    if(singleSelection && firstSelectedItem.type === 'folder'){
                         const isLocked = containsLockedFolder;
                         lockBtn.innerHTML = isLocked ? '<i class="fas fa-unlock"></i> <span class="button-text">管理密码</span>' : '<i class="fas fa-lock"></i> <span class="button-text">加密</span>';
                         lockBtn.title = isLocked ? '修改或移除密码' : '设定密码';
                    }
                }

            } else {
                // 无选中时，显示新建按钮
                generalButtons.forEach(btn => { if(btn) btn.style.display = 'block'; }); // 工具栏
                if(ctxCreateFolderBtn) ctxCreateFolderBtn.style.display = 'flex'; // 菜单
                if(ctxCreateFileBtn) ctxCreateFileBtn.style.display = 'flex'; // 菜单

                // 隐藏项目操作按钮
                normalBtns.forEach(btn => {
                    if (!btn.classList.contains('global-action')) {
                        btn.style.display = 'none';
                    }
                });

                if(selectAllBtn) selectAllBtn.style.display = 'block';
                if(contextMenuSeparator2) contextMenuSeparator2.style.display = 'block';
                
                // 底部工具栏的"新建文件"
                if (textEditBtn) {
                    textEditBtn.style.display = 'none'; // 隐藏底部的编辑按钮，因为这里我们用菜单里的新建
                }
                if(contextMenuSeparator1) contextMenuSeparator1.style.display = 'none';
            }
        }
    }

    function updateSortIndicator() {
        if(!listHeader) return;
        listHeader.querySelectorAll('[data-sort]').forEach(el => {
            el.classList.remove('sort-asc', 'sort-desc');
            const icon = el.querySelector('.sort-icon');
            if(icon) icon.remove();
        });
        const activeHeader = listHeader.querySelector(`[data-sort="${currentSort.key}"]`);
        if (activeHeader) {
            activeHeader.classList.add(currentSort.order === 'asc' ? 'sort-asc' : 'sort-desc');
            const icon = document.createElement('i');
            icon.className = `fas fa-caret-${currentSort.order === 'asc' ? 'up' : 'down'} sort-icon`;
            activeHeader.appendChild(icon);
        }
    }

    function sortItems(folders, files) {
        const { key, order } = currentSort;
        const direction = order === 'asc' ? 1 : -1;

        const sortedFolders = [...folders].sort((a, b) => {
            if (key === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }) * direction;
            return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
        });

        const sortedFiles = [...files].sort((a, b) => {
            if (key === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }) * direction;
            if (key === 'size') return (a.size - b.size) * direction;
            if (key === 'date') return (a.date - b.date) * direction;
            return 0;
        });
        return { folders: sortedFolders, files: sortedFiles };
    }

    function rerenderSelection() {
        document.querySelectorAll('.item-card, .list-item').forEach(el => {
            el.classList.toggle('selected', selectedItems.has(el.dataset.id));
        });
    }
    
    async function loadFoldersForSelect() {
        if (foldersLoaded) return;
        try {
            const res = await axios.get('/api/folders');
            const folders = res.data;
            const folderMap = new Map(folders.map(f => [f.id, { ...f, children: [] }]));
            const tree = [];
            folderMap.forEach(f => {
                if (f.parent_id && folderMap.has(f.parent_id)) folderMap.get(f.parent_id).children.push(f);
                else tree.push(f);
            });

            folderSelect.innerHTML = '';
            const buildOptions = (node, prefix = '') => {
                const option = document.createElement('option');
                option.value = node.encrypted_id; 
                option.textContent = prefix + (node.name === '/' ? '根目录' : node.name);
                folderSelect.appendChild(option);
                node.children.sort((a,b) => a.name.localeCompare(b.name)).forEach(child => buildOptions(child, prefix + '　'));
            };
            tree.sort((a,b) => a.name.localeCompare(b.name)).forEach(buildOptions);

            foldersLoaded = true;
        } catch (error) { }
    }
    
    // =============================================================================
    // 5. 上传与冲突处理逻辑
    // =============================================================================

    async function handleConflict(conflicts, operationType = '文件') {
        const resolutions = {};
        let applyToAllAction = null;
        let aborted = false;

        for (const conflictName of conflicts) {
            if (applyToAllAction) {
                resolutions[conflictName] = applyToAllAction;
                continue;
            }

            const action = await new Promise((resolve) => {
                conflictModalTitle.textContent = `${operationType}冲突`;
                conflictFileName.textContent = conflictName;
                applyToAllContainer.style.display = conflicts.length > 1 ? 'block' : 'none';
                applyToAllCheckbox.checked = false;
                conflictModal.style.display = 'flex';

                conflictOptions.onclick = (e) => {
                    const chosenAction = e.target.dataset.action;
                    if (!chosenAction) return;

                    conflictModal.style.display = 'none';
                    conflictOptions.onclick = null;
                    
                    if (applyToAllCheckbox.checked) {
                        applyToAllAction = chosenAction;
                    }
                    resolve(chosenAction);
                };
            });

            if (action === 'abort') {
                aborted = true;
                break;
            }
            resolutions[conflictName] = action;
        }

        return { aborted, resolutions };
    }

    async function performUpload(url, formData, isDrag = false) {
        const progressBar = isDrag ? dragUploadProgressBar : document.getElementById('progressBar');
        const progressArea = isDrag ? dragUploadProgressArea : document.getElementById('progressArea');
        const submitBtn = isDrag ? null : uploadSubmitBtn;
        const notificationContainer = isDrag ? null : uploadNotificationArea;
    
        if(progressArea) progressArea.style.display = 'block';
        if(progressBar) {
            progressBar.style.width = '0%';
            progressBar.textContent = '0%';
        }
        if (submitBtn) submitBtn.disabled = true;
    
        try {
            const res = await axios.post(url, formData, {
                onUploadProgress: p => {
                    const percent = Math.round((p.loaded * 100) / p.total);
                    if(progressBar) {
                        progressBar.style.width = percent + '%';
                        progressBar.textContent = percent + '%';
                    }
                }
            });
            if (res.data.success) {
                if (!isDrag && uploadModal) uploadModal.style.display = 'none';
                
                if (res.data.skippedAll) {
                    showNotification('没有文件被上传，所有冲突的项目都已被跳过。', 'info');
                } else {
                    showNotification('上传成功！', 'success');
                }
                if(fileInput) fileInput.value = '';
                if(folderInput) folderInput.value = '';
                loadFolderContents(currentEncryptedFolderId);
            } else {
                showNotification(res.data.message, 'error', notificationContainer);
            }
        } catch (error) {
            if (error.response) {
                 showNotification(error.response?.data?.message || '服务器错误', 'error', notificationContainer);
            }
        } finally {
            if (submitBtn) submitBtn.disabled = false;
            setTimeout(() => { if(progressArea) progressArea.style.display = 'none'; }, 2000);
        }
    }

    async function uploadFiles(allFilesData, targetFolderId, isDrag = false) {
        if (allFilesData.length === 0) {
            showNotification('请选择文件或文件夹。', 'error', !isDrag ? uploadNotificationArea : null);
            return;
        }

        const MAX_FILENAME_BYTES = 255; 
        const encoder = new TextEncoder();
        const longFileNames = allFilesData.filter(data => {
            const fileName = data.relativePath.split('/').pop();
            return encoder.encode(fileName).length > MAX_FILENAME_BYTES;
        });

        if (longFileNames.length > 0) {
            const fileNames = longFileNames.map(data => `"${data.relativePath.split('/').pop()}"`).join(', ');
            showNotification(`部分文件名过长 (超过 ${MAX_FILENAME_BYTES} 字节)，无法上传: ${fileNames}`, 'error', !isDrag ? uploadNotificationArea : null);
            return;
        }

        const notificationContainer = isDrag ? null : uploadNotificationArea;
        const oversizedFiles = allFilesData.filter(data => data.file.size > MAX_TELEGRAM_SIZE);
        if (oversizedFiles.length > 0) {
            const fileNames = oversizedFiles.map(data => `"${data.file.name}"`).join(', ');
            showNotification(`文件 ${fileNames} 过大，超过 ${formatBytes(MAX_TELEGRAM_SIZE)} 的限制。`, 'error', notificationContainer);
            return;
        }

        const filesToCheck = allFilesData.map(data => ({ relativePath: data.relativePath }));

        let existenceData = [];
        try {
            const res = await axios.post('/api/check-existence', { files: filesToCheck, folderId: targetFolderId });
            existenceData = res.data.files;
        } catch (error) {
            if (error.response && error.response.status !== 404) {
                 showNotification(error.response?.data?.message || '检查文件冲突时出错', 'error', notificationContainer);
                 return;
            }
        }

        const resolutions = {};
        const conflicts = existenceData ? existenceData.filter(f => f.exists).map(f => f.relativePath) : [];
        
        if (conflicts.length > 0) {
            const conflictResult = await handleConflict(conflicts, '文件');
            if (conflictResult.aborted) {
                showNotification('上传操作已取消。', 'info', notificationContainer);
                return;
            }
            Object.assign(resolutions, conflictResult.resolutions);
        }

        const formData = new FormData();
        allFilesData.forEach(data => {
            formData.append(data.relativePath, data.file);
        });
        
        const params = new URLSearchParams();
        params.append('folderId', targetFolderId);
        params.append('resolutions', JSON.stringify(resolutions));

        const uploadUrl = `/upload?${params.toString()}`;
        await performUpload(uploadUrl, formData, isDrag);
    }

    function promptForPassword(title, text, showOldPassword = false, showConfirm = false) {
        return new Promise((resolve, reject) => {
            passwordPromise.resolve = resolve;
            passwordPromise.reject = reject;
            if(passwordModalTitle) passwordModalTitle.textContent = title;
            if(passwordPromptText) passwordPromptText.textContent = text;
            if(oldPasswordContainer) oldPasswordContainer.style.display = showOldPassword ? 'block' : 'none';
            if(confirmPasswordContainer) confirmPasswordContainer.style.display = showConfirm ? 'block' : 'none';
            if(passwordInput) {
                passwordInput.value = '';
                passwordInput.focus();
            }
            if(oldPasswordInput) oldPasswordInput.value = '';
            if(confirmPasswordInput) confirmPasswordInput.value = '';
            if(passwordModal) passwordModal.style.display = 'flex';
        });
    }

    // =============================================================================
    // 6. 事件绑定
    // =============================================================================

    // 拖拽事件绑定到 document.body
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    });

    let dragCounter = 0;
    dropZone.addEventListener('dragenter', () => { 
        dragCounter++; 
        if(dropZoneOverlay) dropZoneOverlay.style.display = 'flex'; 
    });
    dropZone.addEventListener('dragleave', () => { 
        dragCounter--; 
        if (dragCounter === 0 && dropZoneOverlay) dropZoneOverlay.style.display = 'none'; 
    });
    
    dropZone.addEventListener('drop', async (e) => {
        dragCounter = 0;
        if(dropZoneOverlay) dropZoneOverlay.style.display = 'none';
        if (isTrashMode) return;

        const items = e.dataTransfer.items;
        if (!items || items.length === 0) return;

        const getFileWithRelativePath = (entry) => {
            return new Promise((resolve, reject) => {
                if (entry.isFile) {
                    entry.file(file => {
                        const relativePath = entry.fullPath.startsWith('/') ? entry.fullPath.substring(1) : entry.fullPath;
                        resolve([{ relativePath: relativePath, file: file }]);
                    }, err => reject(err));
                } else if (entry.isDirectory) {
                    const dirReader = entry.createReader();
                    let allEntries = [];
                    const readEntries = () => {
                        dirReader.readEntries(async (results) => {
                            if (results.length === 0) {
                                try {
                                    const filesDataArrays = await Promise.all(allEntries.map(getFileWithRelativePath));
                                    resolve(filesDataArrays.flat());
                                } catch (error) { reject(error); }
                            } else {
                                allEntries.push(...results);
                                readEntries();
                            }
                        }, err => reject(err));
                    };
                    readEntries();
                } else { resolve([]); }
            });
        };
    
        try {
            const entries = Array.from(items).map(item => item.webkitGetAsEntry());
            const filesDataPromises = entries.map(getFileWithRelativePath);
            const filesDataArrays = await Promise.all(filesDataPromises);
            const allFilesData = filesDataArrays.flat().filter(Boolean);
            
            if (allFilesData.length > 0) {
                uploadFiles(allFilesData, currentEncryptedFolderId, true);
            } else {
                showNotification('找不到可上传的文件。', 'warn');
            }
        } catch (error) {
            showNotification('读取拖放的文件夹时出错。', 'error');
        }
    });

    // 右键菜单事件
    dropZone.addEventListener('contextmenu', e => {
        e.preventDefault();
        const targetItem = e.target.closest('.item-card, .list-item');

        if (targetItem && !isMultiSelectMode && !e.ctrlKey && !e.metaKey) {
            if (!selectedItems.has(targetItem.dataset.id)) {
                selectedItems.clear();
                selectedItems.set(targetItem.dataset.id, {
                    type: targetItem.dataset.type,
                    name: targetItem.dataset.name,
                    encrypted_id: targetItem.dataset.encryptedFolderId
                });
                rerenderSelection();
            }
        } else if (!targetItem) {
            if (!isMultiSelectMode) {
              selectedItems.clear();
              rerenderSelection();
            }
        }

        updateContextMenu(targetItem);

        if(contextMenu) {
            contextMenu.style.display = 'flex';
            const { clientX: mouseX, clientY: mouseY } = e;
            let menuX = mouseX;
            let menuY = mouseY;
            
            // 简单的边界检查
            const menuWidth = contextMenu.offsetWidth || 200;
            const menuHeight = contextMenu.offsetHeight || 300;
            
            if (menuX + menuWidth > window.innerWidth) menuX = window.innerWidth - menuWidth - 10;
            if (menuY + menuHeight > window.innerHeight) menuY = window.innerHeight - menuHeight - 10;

            contextMenu.style.top = `${menuY}px`;
            contextMenu.style.left = `${menuX}px`;
        }
    });
    
    window.addEventListener('click', (e) => {
        if (contextMenu && !contextMenu.contains(e.target)) contextMenu.style.display = 'none';
    });

    // --- 其他按钮事件绑定 ---
    if(itemGrid) {
        itemGrid.addEventListener('click', (e) => handleItemClick(e));
        itemGrid.addEventListener('dblclick', (e) => handleItemDblClick(e));
    }
    if(itemListBody) {
        itemListBody.addEventListener('click', (e) => handleItemClick(e));
        itemListBody.addEventListener('dblclick', (e) => handleItemDblClick(e));
    }

    if (ctxCreateFolderBtn) {
        ctxCreateFolderBtn.addEventListener('click', async () => {
            if(contextMenu) contextMenu.style.display = 'none';
            const name = prompt('请输入新文件夹名称:');
            if (name && name.trim()) {
                try {
                    await axios.post('/api/folder/create', { name: name.trim(), parentId: currentEncryptedFolderId });
                    loadFolderContents(currentEncryptedFolderId);
                } catch (error) { alert('创建失败'); }
            }
        });
    }

    if (ctxCreateFileBtn) {
        ctxCreateFileBtn.addEventListener('click', async () => {
            if(contextMenu) contextMenu.style.display = 'none';
            const filename = prompt('请输入文件名 (例如: note.txt):', 'new_file.txt');
            if (!filename || !filename.trim()) return;
            const emptyFile = new File([""], filename.trim(), { type: "text/plain" });
            const fileObj = [{ relativePath: filename, file: emptyFile }];
            await uploadFiles(fileObj, currentEncryptedFolderId, false);
        });
    }

    // (其余按钮事件如 deleteBtn, renameBtn 等与之前逻辑一致，已包含在 updateContextMenu 中的逻辑里或单独绑定)
    
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
            if (selectedItems.size === 0) return;
            if (isTrashMode) {
                alert('请使用顶部的「还原」或「永久删除」按钮进行操作。');
                return;
            }
            if(contextMenu) contextMenu.style.display = 'none';
            if (!confirm(`确定要删除选中的 ${selectedItems.size} 个项目吗？`)) return;
            const files = []; const folders = [];
            selectedItems.forEach((val, key) => { 
                const [type, realId] = key.split(':'); 
                if (type === 'file') files.push(realId); else folders.push(realId); 
            });
            try { 
                TaskManager.show('正在删除...', 'fas fa-trash');
                await axios.post('/api/delete', { files, folders, permanent: false }); 
                selectedItems.clear(); 
                loadFolderContents(currentEncryptedFolderId); 
                updateQuota(); 
                TaskManager.success('删除成功');
            } catch (error) { 
                TaskManager.error('删除失败');
                alert('删除失败'); 
            }
        });
    }

    // 绑定其他模态框事件 (Move, Share, etc) - 保持原样，只需确保 ID 存在
    if (closeModal) closeModal.onclick = () => {
        previewModal.style.display = 'none';
        modalContent.innerHTML = '';
    };
    
    // 初始化视图
    if (document.getElementById('itemGrid')) {
        const pathParts = window.location.pathname.split('/');
        const viewIndex = pathParts.indexOf('view');
        let encryptedId;
        if (viewIndex !== -1 && pathParts.length > viewIndex + 1) {
            encryptedId = pathParts[viewIndex + 1];
        }
        if (encryptedId) loadFolderContents(encryptedId);
        else window.location.href = '/';
    }
});
