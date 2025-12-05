{
type: uploaded file
fileName: limkon/cfilemanger/CFileManger-628f1ebbb4936b82ef613f3eb2f30b8e37290086/public/manager.js
fullContent:
// public/manager.js

document.addEventListener('DOMContentLoaded', () => {
    // 1. 状态变量与配置
    let currentFolderId = null; 
    let currentPath = [];       
    let items = [];             
    let selectedItems = new Set(); 
    let isMultiSelectMode = false; 
    let viewMode = localStorage.getItem('viewMode') || 'grid'; 
    let isTrashMode = false;

    // 2. DOM 元素引用
    const itemGrid = document.getElementById('itemGrid');
    const itemListView = document.getElementById('itemListView');
    const itemListBody = document.getElementById('itemListBody');
    const breadcrumb = document.getElementById('breadcrumb');
    const searchInput = document.getElementById('searchInput');
    const searchForm = document.getElementById('searchForm');
    
    // 状态栏引用
    const taskStatusBar = document.getElementById('taskStatusBar');
    const taskIcon = document.getElementById('taskIcon');
    const taskText = document.getElementById('taskText');
    const taskProgress = document.getElementById('taskProgress');

    // 上传相关
    const uploadModal = document.getElementById('uploadModal');
    const uploadForm = document.getElementById('uploadForm');
    const folderSelect = document.getElementById('folderSelect');
    const progressBar = document.getElementById('progressBar');
    const progressArea = document.getElementById('progressArea');
    const fileInput = document.getElementById('fileInput');
    const folderInput = document.getElementById('folderInput');
    
    // 配额显示
    const quotaUsedEl = document.getElementById('quotaUsed');
    const quotaMaxEl = document.getElementById('quotaMax');
    const quotaBar = document.getElementById('quotaBar');
    
    // 菜单与交互
    const contextMenu = document.getElementById('contextMenu');
    const ctxCreateFolderBtn = document.getElementById('ctxCreateFolderBtn');
    const ctxCreateFileBtn = document.getElementById('ctxCreateFileBtn');
    const editBtn = document.getElementById('editBtn');

    const viewSwitchBtn = document.getElementById('view-switch-btn');
    const trashBtn = document.getElementById('trashBtn'); 
    const trashBanner = document.getElementById('trashBanner'); 
    const emptyTrashBtn = document.getElementById('emptyTrashBtn'); 
    const restoreBtn = document.getElementById('restoreBtn'); 
    const deleteForeverBtn = document.getElementById('deleteForeverBtn'); 
    const dropZoneOverlay = document.getElementById('dropZoneOverlay');

    // Move Modal
    const moveModal = document.getElementById('moveModal');
    const moveBtn = document.getElementById('moveBtn'); // 获取移动按钮
    const folderTree = document.getElementById('folderTree');
    const confirmMoveBtn = document.getElementById('confirmMoveBtn');
    const cancelMoveBtn = document.getElementById('cancelMoveBtn');
    let selectedMoveTargetId = null;

    // Share Modal
    const shareModal = document.getElementById('shareModal');
    const shareBtn = document.getElementById('shareBtn'); // 获取分享按钮
    const confirmShareBtn = document.getElementById('confirmShareBtn');
    const cancelShareBtn = document.getElementById('cancelShareBtn');
    const closeShareModalBtn = document.getElementById('closeShareModalBtn');
    const expiresInSelect = document.getElementById('expiresInSelect');
    const customExpiresInput = document.getElementById('customExpiresInput');
    const sharePasswordInput = document.getElementById('sharePasswordInput');
    const shareResult = document.getElementById('shareResult');
    const shareOptions = document.getElementById('shareOptions'); // 分享选项区域
    const shareLinkContainer = document.getElementById('shareLinkContainer');
    const copyLinkBtn = document.getElementById('copyLinkBtn');

    // Preview Modal
    const previewModal = document.getElementById('previewModal');
    const modalContent = document.getElementById('modalContent');
    const closePreviewBtn = document.querySelector('#previewModal .close-button');

    // =================================================================================
    // 状态栏管理器
    // =================================================================================
    const TaskManager = {
        timer: null,
        show: (text, iconClass = 'fas fa-spinner') => {
            if (TaskManager.timer) clearTimeout(TaskManager.timer);
            taskStatusBar.classList.add('active');
            taskText.textContent = text;
            taskIcon.className = `task-icon spinning ${iconClass}`;
            taskIcon.classList.add('spinning');
            taskProgress.style.width = '0%';
        },
        update: (percent, text) => {
            taskProgress.style.width = percent + '%';
            if(text) taskText.textContent = text;
        },
        success: (text = '完成') => {
            taskText.textContent = text;
            taskIcon.className = 'task-icon fas fa-check-circle'; // 停止旋转，显示打钩
            taskIcon.style.color = '#28a745';
            taskProgress.style.width = '100%';
            TaskManager.hide(2000);
        },
        error: (text = '失败') => {
            taskText.textContent = text;
            taskIcon.className = 'task-icon fas fa-times-circle';
            taskIcon.style.color = '#dc3545';
            TaskManager.hide(3000);
        },
        hide: (delay = 0) => {
            TaskManager.timer = setTimeout(() => {
                taskStatusBar.classList.remove('active');
                // 重置状态以便下次使用
                setTimeout(() => {
                    taskIcon.style.color = '';
                    taskIcon.classList.remove('spinning');
                }, 300);
            }, delay);
        }
    };

    // 3. 初始化逻辑
    const pathParts = window.location.pathname.split('/');
    if (pathParts[1] === 'view' && pathParts[2] && pathParts[2] !== 'null') {
        currentFolderId = pathParts[2];
    }

    updateViewModeUI();
    loadFolder(currentFolderId);
    updateQuota();

    // 4. 核心数据加载与渲染
    async function loadFolder(encryptedId) {
        if (!encryptedId && !isTrashMode) return;
        
        isTrashMode = false;
        trashBanner.style.display = 'none';
        selectedItems.clear();
        updateContextMenuState(false);
        
        try {
            const res = await axios.get(`/api/folder/${encryptedId}`);
            const data = res.data;
            items = [...data.contents.folders, ...data.contents.files];
            currentPath = data.path;
            
            renderBreadcrumb();
            renderItems(items);
            updateFolderSelectForUpload(data.contents.folders);
            
            const newUrl = `/view/${encryptedId}`;
            if (window.location.pathname !== newUrl) {
                window.history.pushState({ id: encryptedId }, '', newUrl);
            }
            currentFolderId = encryptedId;
            if (searchInput.value) searchInput.value = '';
        } catch (error) {
            console.error(error);
            const msg = error.response?.data?.message || error.message;
            if (error.response && error.response.status === 400 && msg.includes('无效 ID')) {
                 window.location.href = '/'; 
                 return;
            }
            itemGrid.innerHTML = `<div class="error-msg" style="text-align:center; padding:20px; color:#dc3545;">加载失败: ${msg}</div>`;
            itemListBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#dc3545;">加载失败: ${msg}</td></tr>`;
        }
    }

    async function loadTrash() {
        isTrashMode = true;
        currentFolderId = null;
        selectedItems.clear();
        updateContextMenuState(false);
        trashBanner.style.display = 'flex';
        
        breadcrumb.innerHTML = `
            <span><i class="fas fa-trash-restore"></i> 回收站</span>
            <a href="#" id="exitTrashLink" style="margin-left:15px; font-size:0.9rem; color:#007bff; text-decoration:none; cursor:pointer;">
                <i class="fas fa-sign-out-alt"></i> 退出回收站
            </a>
        `;
        
        setTimeout(() => {
            const exitLink = document.getElementById('exitTrashLink');
            if(exitLink) {
                exitLink.onclick = (e) => {
                    e.preventDefault();
                    window.location.reload(); 
                };
            }
        }, 0);
        
        try {
            const res = await axios.get('/api/trash');
            items = [...res.data.folders, ...res.data.files];
            renderItems(items);
        } catch (e) {
            alert('加载回收站失败: ' + (e.response?.data?.message || e.message));
        }
    }
    
    trashBtn.addEventListener('click', loadTrash);

    emptyTrashBtn.addEventListener('click', async () => {
        if(confirm('确定要清空回收站吗？此操作无法撤销。')) {
            try {
                TaskManager.show('正在清空回收站...');
                await axios.post('/api/trash/empty');
                TaskManager.success('回收站已清空');
                loadTrash();
                updateQuota();
            } catch(e) { 
                TaskManager.error('清空失败');
                alert('操作失败'); 
            }
        }
    });

    async function updateQuota() {
        try {
            const res = await axios.get('/api/user/quota');
            const { used, max } = res.data;
            quotaUsedEl.textContent = formatSize(used);
            const maxVal = parseInt(max);
            const isUnlimited = maxVal === 0;
            quotaMaxEl.textContent = isUnlimited ? '无限' : formatSize(maxVal);
            if (!isUnlimited && maxVal > 0) {
                const percent = Math.min(100, Math.round((used / maxVal) * 100));
                quotaBar.style.width = `${percent}%`;
                if (percent > 90) quotaBar.style.backgroundColor = '#dc3545';
                else if (percent > 70) quotaBar.style.backgroundColor = '#ffc107';
                else quotaBar.style.backgroundColor = '#28a745';
            } else {
                quotaBar.style.width = '0%';
            }
        } catch (error) {}
    }

    function renderBreadcrumb() {
        if(isTrashMode) return; 
        breadcrumb.innerHTML = '';
        const rootLi = document.createElement('a');
        rootLi.href = '#';
        rootLi.innerHTML = '<i class="fas fa-home"></i> 首页';
        rootLi.onclick = (e) => { e.preventDefault(); if(currentPath.length > 0) loadFolder(currentPath[0].encrypted_id); };
        breadcrumb.appendChild(rootLi);
        currentPath.forEach((folder, index) => {
            const sep = document.createElement('span');
            sep.className = 'separator'; sep.textContent = '/';
            breadcrumb.appendChild(sep);
            const a = document.createElement('a');
            a.textContent = folder.name;
            if (index === currentPath.length - 1) { a.classList.add('active'); } 
            else { a.href = '#'; a.onclick = (e) => { e.preventDefault(); loadFolder(folder.encrypted_id); }; }
            breadcrumb.appendChild(a);
        });
    }

    function renderItems(itemsToRender) {
        itemGrid.innerHTML = '';
        itemListBody.innerHTML = '';
        if (itemsToRender.length === 0) {
            itemGrid.innerHTML = '<div class="empty-folder" style="text-align:center; padding:50px; color:#999;"><i class="fas fa-folder-open" style="font-size:48px; margin-bottom:10px;"></i><p>此位置为空</p></div>';
            itemListBody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:20px; color:#999;">为空</td></tr>`;
            return;
        }
        itemsToRender.forEach(item => {
            itemGrid.appendChild(createGridItem(item));
            itemListBody.appendChild(createListItem(item));
        });
    }

    function createGridItem(item) {
        const div = document.createElement('div');
        div.className = 'grid-item item-card';
        if(isTrashMode) div.classList.add('deleted');
        div.dataset.id = getItemId(item);
        div.onclick = (e) => handleItemClick(e, item, div);
        div.oncontextmenu = (e) => handleContextMenu(e, item);
        div.ondblclick = () => handleItemDblClick(item);

        const iconClass = getIconClass(item);
        const iconColor = item.type === 'folder' ? '#fbc02d' : '#007bff';

        div.innerHTML = `
            <div class="item-icon"><i class="${iconClass}" style="color: ${iconColor};"></i>${item.is_locked ? '<i class="fas fa-lock lock-badge"></i>' : ''}</div>
            <div class="item-info"><h5 title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h5></div>
            ${isMultiSelectMode ? '<div class="select-checkbox"><i class="fas fa-check"></i></div>' : ''}
        `;
        if (selectedItems.has(getItemId(item))) div.classList.add('selected');
        return div;
    }

    function createListItem(item) {
        const div = document.createElement('div');
        div.className = 'list-row list-item';
        if(isTrashMode) div.classList.add('deleted');
        div.dataset.id = getItemId(item);
        div.onclick = (e) => handleItemClick(e, item, div);
        div.oncontextmenu = (e) => handleContextMenu(e, item);
        div.ondblclick = () => handleItemDblClick(item);

        const iconClass = getIconClass(item);
        const dateStr = item.date ? new Date(item.date).toLocaleString() : (item.deleted_at ? new Date(item.deleted_at).toLocaleString() : '-');
        const sizeStr = item.size !== undefined ? formatSize(item.size) : '-';

        div.innerHTML = `
            <div class="list-icon"><i class="${iconClass}" style="color: ${item.type === 'folder' ? '#fbc02d' : '#555'}"></i></div>
            <div class="list-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
            <div class="list-size">${sizeStr}</div>
            <div class="list-date">${dateStr}</div>
        `;
        if (selectedItems.has(getItemId(item))) div.classList.add('selected');
        return div;
    }

    function getIconClass(item) {
        if (item.type === 'folder') return 'fas fa-folder';
        const ext = item.name.split('.').pop().toLowerCase();
        if (['jpg','jpeg','png','gif','bmp','webp'].includes(ext)) return 'fas fa-file-image';
        if (['mp4','mov','avi','mkv','webm'].includes(ext)) return 'fas fa-file-video';
        if (['mp3','wav','ogg','flac'].includes(ext)) return 'fas fa-file-audio';
        if (['pdf'].includes(ext)) return 'fas fa-file-pdf';
        if (['zip','rar','7z','tar','gz'].includes(ext)) return 'fas fa-file-archive';
        if (['txt','md','js','html','css','json','py','java'].includes(ext)) return 'fas fa-file-alt';
        return 'fas fa-file';
    }

    // 5. 交互事件处理
    function handleItemClick(e, item, el) {
        const id = getItemId(item);
        if (e.ctrlKey || isMultiSelectMode) {
            if (selectedItems.has(id)) { selectedItems.delete(id); el.classList.remove('selected'); } 
            else { selectedItems.add(id); el.classList.add('selected'); }
        } else {
            document.querySelectorAll('.selected').forEach(x => x.classList.remove('selected'));
            selectedItems.clear(); selectedItems.add(id); el.classList.add('selected');
        }
        updateContextMenuState(true);
    }

    function handleItemDblClick(item) {
        if(isTrashMode) return;
        if (item.type === 'folder') { loadFolder(item.encrypted_id); } 
        else { 
            // 简单的下载反馈
            TaskManager.show('正在请求下载...', 'fas fa-download');
            setTimeout(() => TaskManager.success('下载已开始'), 2000);
            
            const ext = item.name.split('.').pop().toLowerCase();
            if (['txt', 'md', 'js', 'html', 'css', 'json', 'xml', 'py', 'java', 'c', 'cpp', 'log', 'ini', 'conf'].includes(ext)) {
                 window.open(`/editor.html?id=${item.message_id}&name=${encodeURIComponent(item.name)}`, '_blank');
            } else { window.open(`/download/proxy/${item.message_id}`, '_blank'); }
        }
    }

    document.querySelector('.main-content').addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const targetItem = e.target.closest('.item-card, .list-item');
        if (targetItem) {
            const id = targetItem.dataset.id;
            if (!selectedItems.has(id)) {
                document.querySelectorAll('.selected').forEach(x => x.classList.remove('selected'));
                selectedItems.clear();
                selectedItems.add(id);
                targetItem.classList.add('selected');
            }
            updateContextMenuState(true);
        } else {
            if (!isMultiSelectMode) {
                selectedItems.clear();
                document.querySelectorAll('.selected').forEach(x => x.classList.remove('selected'));
            }
            updateContextMenuState(false);
        }
        showContextMenu(e.clientX, e.clientY);
    });

    function handleContextMenu(e, item) { }

    function showContextMenu(x, y) {
        const menuWidth = 200; 
        const menuHeight = isTrashMode ? 50 : 350;
        if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 10;
        if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 10;
        contextMenu.style.top = `${y}px`;
        contextMenu.style.left = `${x}px`;
        contextMenu.style.display = 'flex';
        document.addEventListener('click', () => contextMenu.style.display = 'none', { once: true });
    }

    function updateContextMenuState(hasSelection) {
        const count = selectedItems.size;
        const isSingle = count === 1;
        let firstType = null;
        if (isSingle) {
            const idStr = Array.from(selectedItems)[0];
            [firstType] = parseItemId(idStr);
        }

        const globalActions = document.querySelectorAll('.global-action');
        const itemActions = document.querySelectorAll('.item-action');

        if (isTrashMode) {
            globalActions.forEach(el => el.style.display = 'none');
            itemActions.forEach(el => {
                if (el.id === 'deleteBtn') {
                    el.style.display = hasSelection ? 'flex' : 'none';
                    el.innerHTML = '<i class="fas fa-trash-restore"></i> 还原 / 删除';
                } else {
                    el.style.display = 'none';
                }
            });
            return;
        }

        if (hasSelection) {
            globalActions.forEach(el => el.style.display = 'none');
            itemActions.forEach(el => el.style.display = 'flex');
            const setDisplay = (id, show) => {
                const btn = document.getElementById(id);
                if (btn) btn.style.display = show ? 'flex' : 'none';
            };
            setDisplay('openBtn', isSingle && firstType === 'folder');
            setDisplay('previewBtn', isSingle && firstType === 'file');
            setDisplay('editBtn', isSingle && firstType === 'file'); 
            setDisplay('downloadBtn', isSingle && firstType === 'file');
            setDisplay('renameBtn', isSingle);
            setDisplay('shareBtn', isSingle);
            setDisplay('moveBtn', true); // 移动功能对单选或多选都有效
            setDisplay('lockBtn', isSingle && firstType === 'folder');
            const delBtn = document.getElementById('deleteBtn');
            if(delBtn) delBtn.innerHTML = '<i class="fas fa-trash-alt"></i> 删除';
        } else {
            globalActions.forEach(el => el.style.display = 'flex');
            itemActions.forEach(el => el.style.display = 'none');
        }
        
        const infoEl = document.getElementById('selectionInfo');
        if (count > 0) {
            infoEl.style.display = 'block';
            infoEl.textContent = `已选中 ${count} 个项目`;
        } else {
            infoEl.style.display = 'none';
        }
    }

    // 6. 按钮逻辑
    ctxCreateFolderBtn.addEventListener('click', async () => {
        const name = prompt('请输入新文件夹名称:');
        if (name && name.trim()) {
            try {
                await axios.post('/api/folder/create', { name: name.trim(), parentId: currentFolderId });
                loadFolder(currentFolderId);
            } catch (error) { alert('创建失败'); }
        }
    });

    ctxCreateFileBtn.addEventListener('click', async () => {
        const filename = prompt('请输入文件名 (例如: note.txt):', 'new_file.txt');
        if (!filename || !filename.trim()) return;
        const emptyFile = new File([""], filename.trim(), { type: "text/plain" });
        const fileObj = { file: emptyFile, path: '' };
        await executeUpload([fileObj], currentFolderId);
    });

    editBtn.addEventListener('click', () => {
        if (selectedItems.size !== 1) return;
        const idStr = Array.from(selectedItems)[0];
        const [type, id] = parseItemId(idStr);
        if (type !== 'file') return;
        const item = items.find(i => getItemId(i) === idStr);
        const ext = item.name.split('.').pop().toLowerCase();
        const editableExts = ['txt', 'md', 'js', 'json', 'css', 'html', 'xml', 'py', 'java', 'c', 'cpp', 'h', 'log', 'ini', 'conf', 'yml', 'yaml', 'sh', 'bat'];
        if (editableExts.includes(ext) || confirm('此文件类型可能不支持文本编辑，确定要尝试打开吗？')) {
            window.open(`/editor.html?id=${id}&name=${encodeURIComponent(item.name)}`, '_blank');
        }
    });

    document.getElementById('deleteBtn').addEventListener('click', async () => {
        if (selectedItems.size === 0) return;
        if (isTrashMode) {
            alert('请使用顶部的「还原」或「永久删除」按钮进行操作。');
            return;
        }
        if (!confirm(`确定要删除选中的 ${selectedItems.size} 个项目吗？`)) return;
        const files = []; const folders = [];
        selectedItems.forEach(id => { const [type, realId] = parseItemId(id); if (type === 'file') files.push(realId); else folders.push(realId); });
        try { 
            TaskManager.show('正在删除...', 'fas fa-trash');
            await axios.post('/api/delete', { files, folders, permanent: false }); 
            selectedItems.clear(); 
            loadFolder(currentFolderId); 
            updateQuota(); 
            TaskManager.success('删除成功');
        } catch (error) { 
            TaskManager.error('删除失败');
            alert('删除失败'); 
        }
    });

    restoreBtn.addEventListener('click', async () => {
        if (selectedItems.size === 0) return alert('请先选择要还原的项目');
        const files = []; const folders = [];
        selectedItems.forEach(id => { const [type, realId] = parseItemId(id); if (type === 'file') files.push(realId); else folders.push(realId); });
        try { 
            TaskManager.show('正在还原...', 'fas fa-trash-restore');
            await axios.post('/api/trash/restore', { files, folders }); 
            selectedItems.clear(); 
            loadTrash(); 
            updateQuota(); 
            TaskManager.success('还原成功');
        } catch (error) { 
            TaskManager.error('还原失败');
            alert('还原失败'); 
        }
    });

    deleteForeverBtn.addEventListener('click', async () => {
        if (selectedItems.size === 0) return alert('请先选择要删除的项目');
        if (!confirm('确定要永久删除吗？此操作无法撤销！')) return;
        const files = []; const folders = [];
        selectedItems.forEach(id => { const [type, realId] = parseItemId(id); if (type === 'file') files.push(realId); else folders.push(realId); });
        try { 
            TaskManager.show('正在永久删除...', 'fas fa-times');
            await axios.post('/api/delete', { files, folders, permanent: true }); 
            selectedItems.clear(); 
            loadTrash(); 
            updateQuota(); 
            TaskManager.success('已永久删除');
        } catch (error) { 
            TaskManager.error('操作失败');
            alert('永久删除失败'); 
        }
    });

    document.getElementById('renameBtn').addEventListener('click', async () => {
        if (selectedItems.size !== 1) return;
        const idStr = Array.from(selectedItems)[0]; const [type, id] = parseItemId(idStr); const item = items.find(i => getItemId(i) === idStr);
        if (!item) return;
        const newName = prompt('重命名:', item.name);
        if (newName && newName !== item.name) {
            try { await axios.post('/api/rename', { type, id, name: newName }); loadFolder(currentFolderId); } catch (error) { alert('重命名失败'); }
        }
    });

    // =================================================================================
    // 修复：移动功能逻辑 (Move)
    // =================================================================================
    if (moveBtn) {
        moveBtn.addEventListener('click', () => {
            if (selectedItems.size === 0) return;
            selectedMoveTargetId = null;
            confirmMoveBtn.disabled = true;
            moveModal.style.display = 'block';
            loadFolderTree();
        });
    }
    
    cancelMoveBtn.addEventListener('click', () => moveModal.style.display = 'none');

    async function loadFolderTree() {
        folderTree.innerHTML = '<div style="padding:10px;color:#666;">加载中...</div>';
        try {
            const res = await axios.get('/api/folders');
            const allFolders = res.data; // [{id, name, parent_id, encrypted_id}]
            renderFolderTree(allFolders);
        } catch (e) {
            folderTree.innerHTML = `<div style="color:red;padding:10px;">加载失败: ${e.message}</div>`;
        }
    }

    function renderFolderTree(folders) {
        // 1. 找出要移动的文件夹ID (为了避免移动到自己或子文件夹)
        const movingFolderIds = new Set();
        selectedItems.forEach(itemStr => {
            const [type, id] = parseItemId(itemStr);
            if (type === 'folder') {
                // 这里的 id 是加密 ID，但 API 返回的 parent_id 是明文 int。
                // 我们需要找到对应的明文 ID，或者 API 返回时 parent_id 也是加密的?
                // 根据 src/data.js getAllFolders, id 是明文int, encrypted_id 是加密的.
                // parseItemId 返回的是 encrypted_id (因为 grid item dataset.id 用的是 getItemId -> file:message_id / folder:id)
                // 等等，grid item dataset.id: getItemId(item)
                // item.id 是明文 (getFolderContents returned id).
                // wait... data.js: getFolderContents returns folders.map(f => ({ ...f, encrypted_id: encrypt(f.id) }))
                // getItemId uses `item.id` which is likely the raw ID if sent by getFolderContents?
                // let's check data.js getFolderContents again.
                // SELECT id... -> raw ID.
                // So item.id is raw ID. getItemId uses raw ID.
                // But loadFolder uses encryptedId.
                // Let's fix getAllFolders: it returns {id, name, parent_id, encrypted_id}.
                const matched = folders.find(f => f.encrypted_id === id || f.id == id);
                if(matched) movingFolderIds.add(matched.id);
            }
        });

        // 2. 构建树结构
        const map = {};
        let root = null;
        folders.forEach(f => {
            f.children = [];
            map[f.id] = f;
        });
        
        folders.forEach(f => {
            if (f.parent_id && map[f.parent_id]) {
                map[f.parent_id].children.push(f);
            } else {
                // 假设 parent_id 为 null 或者是找不到父节点的孤儿节点（当作根处理）
                if(!root) root = f; 
                // 注意：如果允许多个根目录( rare but possible with bugs), array logic needed.
                // 但这里我们主要找 parent_id IS NULL 的那个
            }
        });
        
        // 如果没找到 root (bad data?)
        if (!root && folders.length > 0) root = folders[0]; 

        // 3. 渲染
        folderTree.innerHTML = '';
        if (root) {
            folderTree.appendChild(createFolderNode(root, movingFolderIds));
        } else {
            folderTree.innerHTML = '<div style="padding:10px;">没有文件夹</div>';
        }
    }

    function createFolderNode(folder, movingIds) {
        const container = document.createElement('div');
        
        const itemDiv = document.createElement('div');
        itemDiv.className = 'folder-item';
        
        // 检查是否是正在移动的文件夹自己
        const isSelf = movingIds.has(folder.id);
        // 注意：这里不做复杂的子节点禁用检查，只禁用自己。如果是移动到子节点，后端或逻辑应阻止，或简单处理。
        // 完善的逻辑应该递归禁用子节点。

        if (isSelf) {
            itemDiv.style.color = '#999';
            itemDiv.style.cursor = 'not-allowed';
            itemDiv.innerHTML = `<i class="fas fa-folder" style="margin-right:5px;"></i> ${escapeHtml(folder.name)} (当前)`;
        } else {
            itemDiv.innerHTML = `<i class="fas fa-folder" style="margin-right:5px;"></i> ${escapeHtml(folder.name)}`;
            itemDiv.onclick = () => {
                document.querySelectorAll('.folder-item').forEach(el => el.classList.remove('selected'));
                itemDiv.classList.add('selected');
                selectedMoveTargetId = folder.encrypted_id;
                confirmMoveBtn.disabled = false;
            };
        }
        container.appendChild(itemDiv);

        if (folder.children && folder.children.length > 0) {
            const childrenContainer = document.createElement('div');
            childrenContainer.style.paddingLeft = '20px';
            folder.children.forEach(child => {
                // 递归传递 movingIds，如果父节点是正在移动的，子节点也不应可选（防止循环）
                // 这里的 movingIds 只是当前选中的。我们需要判断 child 是否是 movingIds 的后代。
                // 简单起见，如果 isSelf 为 true，子节点也视为不可选。
                const childNode = createFolderNode(child, movingIds);
                if(isSelf) {
                    // 禁用子节点交互
                    const childItemDiv = childNode.querySelector('.folder-item');
                    if(childItemDiv) {
                        childItemDiv.style.color = '#999';
                        childItemDiv.style.cursor = 'not-allowed';
                        childItemDiv.onclick = null;
                    }
                }
                childrenContainer.appendChild(childNode);
            });
            container.appendChild(childrenContainer);
        }

        return container;
    }

    confirmMoveBtn.addEventListener('click', async () => {
        if (!selectedMoveTargetId) return;
        const files = []; const folders = [];
        selectedItems.forEach(id => { 
            const [type, realId] = parseItemId(id); 
            // 这里的 realId 是 items 里的 ID。
            // items 是 getFolderContents 来的。
            // getFolderContents: files use message_id (string), folders use id (int).
            if (type === 'file') files.push(realId); 
            else folders.push(realId); 
        });
        
        try {
            confirmMoveBtn.textContent = '移动中...';
            confirmMoveBtn.disabled = true;
            TaskManager.show('正在移动...', 'fas fa-arrows-alt'); 
            
            await axios.post('/api/move', { files, folders, targetFolderId: selectedMoveTargetId });
            
            TaskManager.success('移动完成');
            moveModal.style.display = 'none';
            selectedItems.clear();
            loadFolder(currentFolderId);
        } catch (e) {
            alert('移动失败: ' + (e.response?.data?.message || e.message));
            TaskManager.error('移动失败');
        } finally {
            confirmMoveBtn.textContent = '确定移动';
            confirmMoveBtn.disabled = false;
        }
    });

    // =================================================================================
    // 修复：分享功能逻辑 (Share)
    // =================================================================================
    if (shareBtn) {
        shareBtn.addEventListener('click', () => {
            if (selectedItems.size !== 1) return alert('一次只能分享一个项目');
            
            // 重置模态框状态
            shareModal.style.display = 'block';
            shareOptions.style.display = 'block';
            shareResult.style.display = 'none';
            sharePasswordInput.value = '';
            expiresInSelect.value = '24h';
            customExpiresInput.style.display = 'none';
        });
    }

    closeShareModalBtn.addEventListener('click', () => shareModal.style.display = 'none');
    cancelShareBtn.addEventListener('click', () => shareModal.style.display = 'none');

    expiresInSelect.addEventListener('change', (e) => {
        customExpiresInput.style.display = e.target.value === 'custom' ? 'block' : 'none';
    });

    confirmShareBtn.addEventListener('click', async () => {
        const itemStr = Array.from(selectedItems)[0];
        const [type, id] = parseItemId(itemStr); // id is raw ID
        const password = sharePasswordInput.value;
        const expiresIn = expiresInSelect.value;
        
        let customExpiresAt = null;
        if (expiresIn === 'custom') {
            const val = customExpiresInput.value;
            if (!val) return alert('请选择过期时间');
            customExpiresAt = new Date(val).getTime();
        }

        try {
            confirmShareBtn.disabled = true;
            confirmShareBtn.textContent = '生成中...';
            
            const res = await axios.post('/api/share/create', {
                itemId: id,
                itemType: type,
                expiresIn,
                password,
                customExpiresAt
            });

            if (res.data.success) {
                shareOptions.style.display = 'none';
                shareResult.style.display = 'block';
                const fullLink = window.location.origin + res.data.link;
                shareLinkContainer.textContent = fullLink;
                copyLinkBtn.dataset.link = fullLink;
            } else {
                alert('生成失败: ' + res.data.message);
            }
        } catch (e) {
            alert('请求失败: ' + e.message);
        } finally {
            confirmShareBtn.disabled = false;
            confirmShareBtn.textContent = '生成链接';
        }
    });

    copyLinkBtn.addEventListener('click', () => {
        const link = copyLinkBtn.dataset.link;
        navigator.clipboard.writeText(link).then(() => {
            const originalText = copyLinkBtn.textContent;
            copyLinkBtn.textContent = '已复制!';
            copyLinkBtn.classList.add('success-btn');
            setTimeout(() => {
                copyLinkBtn.textContent = originalText;
                copyLinkBtn.classList.remove('success-btn');
            }, 2000);
        });
    });

    document.getElementById('downloadBtn').addEventListener('click', () => {
        if (selectedItems.size !== 1) return;
        const idStr = Array.from(selectedItems)[0]; const [type, id] = parseItemId(idStr);
        if (type !== 'file') return alert('只能下载文件');
        
        TaskManager.show('正在请求下载...', 'fas fa-download');
        setTimeout(() => TaskManager.success('下载已开始'), 1500);
        window.open(`/download/proxy/${id}`, '_blank');
    });
    
    document.getElementById('openBtn').addEventListener('click', () => {
         if (selectedItems.size !== 1) return;
         const idStr = Array.from(selectedItems)[0]; const [type, id] = parseItemId(idStr);
         if (type === 'folder') {
             const item = items.find(i => getItemId(i) === idStr);
             if(item) loadFolder(item.encrypted_id);
         }
    });
    
    document.getElementById('previewBtn').addEventListener('click', async () => {
        if (selectedItems.size !== 1) return;
        const idStr = Array.from(selectedItems)[0]; const [type, id] = parseItemId(idStr); const item = items.find(i => getItemId(i) === idStr);
        if (!item || type !== 'file') return;
        const ext = item.name.split('.').pop().toLowerCase();
        const downloadUrl = `/download/proxy/${id}`;
        
        TaskManager.show('正在加载预览...', 'fas fa-eye');
        
        let content = '';
        if (['jpg','jpeg','png','gif','webp','svg'].includes(ext)) content = `<img src="${downloadUrl}" style="max-width:100%; max-height:80vh;">`;
        else if (['mp4','webm'].includes(ext)) content = `<video src="${downloadUrl}" controls style="max-width:100%; max-height:80vh;"></video>`;
        else if (['mp3','wav','ogg'].includes(ext)) content = `<audio src="${downloadUrl}" controls></audio>`;
        else if (['txt','md','json','js','css','html','xml','log'].includes(ext)) {
             try {
                 modalContent.innerHTML = '<p>正在加载...</p>'; previewModal.style.display = 'flex';
                 const res = await axios.get(downloadUrl, { responseType: 'text' });
                 content = `<pre>${escapeHtml(res.data)}</pre>`;
             } catch(e) { content = `<p style="color:red">无法预览: ${e.message}</p>`; }
        } else content = `<div class="no-preview"><i class="fas fa-file" style="font-size:48px;margin-bottom:20px;"></i><p>不支持预览</p><a href="${downloadUrl}" class="upload-link-btn">下载文件</a></div>`;
        
        TaskManager.success('预览就绪');
        modalContent.innerHTML = content; previewModal.style.display = 'flex';
    });
    closePreviewBtn.onclick = () => previewModal.style.display = 'none';
    
    document.getElementById('lockBtn').addEventListener('click', async () => {
        if (selectedItems.size !== 1) return;
        const idStr = Array.from(selectedItems)[0]; const [type, id] = parseItemId(idStr);
        if (type !== 'folder') return;
        const password = prompt('设置文件夹密码 (留空则不设置):');
        if (password === null) return;
        try { 
            const item = items.find(i => getItemId(i) === idStr);
            await axios.post('/api/folder/lock', { folderId: item.encrypted_id, password: password }); 
            alert('设置成功'); loadFolder(currentFolderId); 
        } catch (e) { alert('操作失败'); }
    });

    viewSwitchBtn.addEventListener('click', () => {
        viewMode = viewMode === 'grid' ? 'list' : 'grid';
        localStorage.setItem('viewMode', viewMode);
        updateViewModeUI();
        renderItems(items);
    });

    function updateViewModeUI() {
        if (viewMode === 'grid') {
            itemGrid.style.display = 'grid';
            itemListView.style.display = 'none';
            viewSwitchBtn.innerHTML = '<i class="fas fa-list"></i>';
            viewSwitchBtn.title = "切换到列表视图";
        } else {
            itemGrid.style.display = 'none';
            itemListView.style.display = 'block';
            viewSwitchBtn.innerHTML = '<i class="fas fa-th-large"></i>';
            viewSwitchBtn.title = "切换到网格视图";
        }
    }
    
    searchForm.addEventListener('submit', async (e) => {
        e.preventDefault(); const q = searchInput.value.trim(); if(!q) return loadFolder(currentFolderId);
        try {
            const res = await axios.get(`/api/search?q=${encodeURIComponent(q)}`);
            items = [...res.data.folders, ...res.data.files];
            renderItems(items);
            breadcrumb.innerHTML = '<span><i class="fas fa-search"></i> 搜索结果</span><a href="#" onclick="location.reload()" style="margin-left:10px;">退出搜索</a>';
        } catch(e) { alert('搜索失败'); }
    });
    
    // =================================================================================
    // 9. 上传功能 (增强版：支持递归目录创建 + 状态栏)
    // =================================================================================

    async function getFolderContents(encryptedId) {
        try {
            const res = await axios.get(`/api/folder/${encryptedId}`);
            return res.data.contents;
        } catch (e) {
            console.error('获取目录失败:', encryptedId, e);
            return { folders: [], files: [] };
        }
    }

    async function ensureRemotePath(pathStr, rootId) {
        if (!pathStr || pathStr === '' || pathStr === '.') return rootId;
        
        const parts = pathStr.split('/').filter(p => p.trim() !== '');
        let currentId = rootId;

        for (const part of parts) {
            const contents = await getFolderContents(currentId);
            const existingFolder = contents.folders.find(f => f.name === part);
            
            if (existingFolder) {
                currentId = existingFolder.encrypted_id;
                TaskManager.show(`进入目录: ${part}`, 'fas fa-folder-open');
            } else {
                TaskManager.show(`创建目录: ${part}`, 'fas fa-folder-plus');
                try {
                    await axios.post('/api/folder/create', { name: part, parentId: currentId });
                    const updatedContents = await getFolderContents(currentId);
                    const newFolder = updatedContents.folders.find(f => f.name === part);
                    if (newFolder) currentId = newFolder.encrypted_id;
                    else throw new Error(`无法获取新创建目录 ID: ${part}`);
                } catch (e) {
                    console.error('递归创建失败', e);
                    throw e;
                }
            }
        }
        return currentId;
    }

    async function scanEntry(entry, path = '') {
        if (entry.isFile) {
            return new Promise((resolve) => {
                entry.file((file) => {
                    resolve([{ file: file, path: path }]);
                });
            });
        } else if (entry.isDirectory) {
            const dirReader = entry.createReader();
            const currentPath = path ? `${path}/${entry.name}` : entry.name;
            let entries = [];
            
            const readAllEntries = async () => {
                return new Promise((resolve, reject) => {
                    dirReader.readEntries(async (results) => {
                        if (results.length === 0) {
                            resolve(entries);
                        } else {
                            entries = entries.concat(results);
                            await readAllEntries();
                            resolve(entries);
                        }
                    }, reject);
                });
            };

            await readAllEntries();
            let files = [];
            for (const subEntry of entries) {
                const subFiles = await scanEntry(subEntry, currentPath);
                files = files.concat(subFiles);
            }
            return files;
        }
        return [];
    }

    async function scanDataTransferItems(items) {
        let files = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === 'file') {
                const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : (item.getAsEntry ? item.getAsEntry() : null);
                if (entry) {
                    const entryFiles = await scanEntry(entry, '');
                    files = files.concat(entryFiles);
                } else {
                    const file = item.getAsFile();
                    if(file) files.push({ file: file, path: '' });
                }
            }
        }
        return files;
    }

    async function executeUpload(inputItems, targetEncryptedId) {
        if (!inputItems || inputItems.length === 0) return alert('请选择至少一个文件');
        
        const rootId = targetEncryptedId || currentFolderId;
        let queue = [];
        
        if (inputItems instanceof FileList) {
            for(let i=0; i<inputItems.length; i++) queue.push({ file: inputItems[i], path: '' });
        } else if (Array.isArray(inputItems) && inputItems.length > 0 && inputItems[0] instanceof File) {
             inputItems.forEach(f => {
                 const rel = f.webkitRelativePath || '';
                 const pathPart = rel.substring(0, rel.lastIndexOf('/'));
                 queue.push({ file: f, path: pathPart });
             });
        } else if (Array.isArray(inputItems)) {
            queue = inputItems;
        }

        if (queue.length === 0) return;

        // 初始化 UI (显示模态框)
        if(uploadModal.style.display === 'none') {
            uploadModal.style.display = 'block';
            document.getElementById('uploadForm').style.display = 'none';
        }
        progressArea.style.display = 'block';
        const progressBar = document.getElementById('progressBar');
        let statusText = document.getElementById('uploadStatusText');
        if (!statusText) {
            statusText = document.createElement('div');
            statusText.style.textAlign = 'center';
            statusText.style.marginTop = '5px';
            statusText.style.fontSize = '12px';
            statusText.id = 'uploadStatusText';
            progressArea.appendChild(statusText);
        }
        
        // 激活底部状态栏
        TaskManager.show('准备上传...', 'fas fa-cloud-upload-alt');

        const totalBytes = queue.reduce((acc, item) => acc + item.file.size, 0);
        let loadedBytesGlobal = 0;
        let successCount = 0;
        let failCount = 0;
        const errors = [];
        const pathCache = {}; 
        pathCache[''] = rootId;

        for (let i = 0; i < queue.length; i++) {
            const item = queue[i];
            const file = item.file;
            const relPath = item.path || '';
            
            let targetFolderId = rootId;
            
            // 状态栏更新：当前文件
            const statusMsg = `[${i + 1}/${queue.length}] 上传: ${file.name}`;
            statusText.textContent = statusMsg;
            TaskManager.show(statusMsg, 'fas fa-file-upload');

            try {
                if (pathCache[relPath]) {
                    targetFolderId = pathCache[relPath];
                } else {
                    targetFolderId = await ensureRemotePath(relPath, rootId);
                    pathCache[relPath] = targetFolderId;
                }
            } catch (e) {
                console.error(`无法创建目录: ${relPath}`, e);
                failCount++;
                errors.push(`目录创建失败: ${relPath}`);
                continue;
            }

            const formData = new FormData();
            formData.append('files', file, file.name);

            try {
                let currentFileLoaded = 0;
                await axios.post(`/upload?folderId=${targetFolderId || ''}`, formData, {
                    headers: { 'Content-Type': 'multipart/form-data' },
                    onUploadProgress: (p) => {
                        const diff = p.loaded - currentFileLoaded;
                        currentFileLoaded = p.loaded;
                        loadedBytesGlobal += diff;
                        if (totalBytes > 0) {
                            const percent = Math.min(100, Math.round((loadedBytesGlobal * 100) / totalBytes));
                            progressBar.style.width = percent + '%';
                            progressBar.textContent = percent + '%';
                            TaskManager.update(percent, statusMsg); // 同步更新底部状态栏
                        }
                    }
                });
                successCount++;
            } catch (error) {
                console.error(`上传失败: ${file.name}`, error);
                failCount++;
                errors.push(`${file.name}: ${error.response?.data?.message || error.message}`);
            }
        }

        // 结果处理
        let resultMsg = `上传结束。\n成功: ${successCount}\n失败: ${failCount}`;
        if (failCount > 0) {
            resultMsg += '\n\n错误详情:\n' + errors.join('\n').slice(0, 200) + '...';
            alert(resultMsg);
            TaskManager.error('部分上传失败');
        } else {
            console.log(resultMsg);
            TaskManager.success('所有文件上传完成');
        }

        setTimeout(() => {
            uploadModal.style.display = 'none';
            document.getElementById('uploadForm').style.display = 'block';
            uploadForm.reset();
            progressArea.style.display = 'none';
            if (statusText) statusText.textContent = '';
            
            loadFolder(currentFolderId);
            updateQuota();
        }, 1000);
    }

    document.getElementById('showUploadModalBtn').addEventListener('click', () => {
        uploadModal.style.display = 'block';
        document.getElementById('uploadForm').style.display = 'block';
        progressArea.style.display = 'none';
        updateFolderSelectForUpload([]);
    });
    
    document.getElementById('closeUploadModalBtn').addEventListener('click', () => {
        uploadModal.style.display = 'none';
    });
    
    uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        let allItems = [];
        if (fileInput.files.length > 0) {
            allItems = allItems.concat(Array.from(fileInput.files).map(f => ({ file: f, path: '' })));
        }
        if (folderInput.files.length > 0) {
            allItems = allItems.concat(Array.from(folderInput.files));
        }
        
        const targetId = folderSelect.value || currentFolderId;
        await executeUpload(allItems, targetId);
    });

    // 拖拽逻辑
    let dragCounter = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; dropZoneOverlay.style.display = 'flex'; });
    window.addEventListener('dragleave', (e) => { e.preventDefault(); dragCounter--; if (dragCounter === 0) dropZoneOverlay.style.display = 'none'; });
    window.addEventListener('dragover', (e) => { e.preventDefault(); });
    window.addEventListener('drop', async (e) => {
        e.preventDefault();
        dragCounter = 0;
        dropZoneOverlay.style.display = 'none';
        
        const items = e.dataTransfer.items;
        if (items && items.length > 0) {
            const files = await scanDataTransferItems(items);
            if (files.length > 0) await executeUpload(files, currentFolderId);
        } else if (e.dataTransfer.files.length > 0) {
            const list = Array.from(e.dataTransfer.files).map(f => ({ file: f, path: '' }));
            await executeUpload(list, currentFolderId);
        }
    });

    function updateFolderSelectForUpload(folders) {
        folderSelect.innerHTML = `<option value="${currentFolderId}">当前文件夹</option>`;
        items.forEach(item => {
            if(item.type === 'folder') {
                const op = document.createElement('option');
                op.value = item.encrypted_id;
                op.textContent = item.name;
                folderSelect.appendChild(op);
            }
        });
    }

    document.getElementById('logoutBtn').addEventListener('click', () => window.location.href = '/logout');
    document.getElementById('multiSelectToggleBtn').addEventListener('click', () => {
        isMultiSelectMode = !isMultiSelectMode;
        document.body.classList.toggle('selection-mode-active', isMultiSelectMode);
        document.getElementById('multiSelectToggleBtn').classList.toggle('active', isMultiSelectMode);
        renderItems(items); contextMenu.style.display = 'none';
    });
    document.getElementById('selectAllBtn').addEventListener('click', () => {
        if (selectedItems.size === items.length) { selectedItems.clear(); document.querySelectorAll('.selected').forEach(el => el.classList.remove('selected')); } 
        else { items.forEach(item => selectedItems.add(getItemId(item))); document.querySelectorAll('.item-card, .list-item').forEach(el => el.classList.add('selected')); }
        updateContextMenuState(true); contextMenu.style.display = 'none';
    });

    function getItemId(item) { return item.type === 'file' ? `file:${item.message_id}` : `folder:${item.id}`; }
    function parseItemId(str) { const p = str.split(':'); return [p[0], p[1]]; }
    function escapeHtml(text) { if (!text) return ''; return text.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]); }
    function formatSize(bytes) { if (bytes === 0) return '0 B'; const k = 1024; const sizes = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.floor(Math.log(bytes) / Math.log(k)); return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]; }
});
