// public/manager.js

document.addEventListener('DOMContentLoaded', () => {
    // =================================================================================
    // 1. 狀態變量與配置
    // =================================================================================
    let currentFolderId = null; // 當前資料夾的加密 ID
    let currentPath = [];       // 麵包屑導航數據
    let items = [];             // 當前資料夾內容緩存
    let selectedItems = new Set(); // 選中的項目 ID (格式: "file:123" 或 "folder:456")
    let isMultiSelectMode = false; // 多選模式標記
    let viewMode = localStorage.getItem('viewMode') || 'grid'; // 視圖模式: 'grid' | 'list'
    let isTrashMode = false; // 回收站模式標記

    // =================================================================================
    // 2. DOM 元素引用
    // =================================================================================
    const itemGrid = document.getElementById('itemGrid');
    const itemListView = document.getElementById('itemListView');
    const itemListBody = document.getElementById('itemListBody');
    const breadcrumb = document.getElementById('breadcrumb');
    const searchInput = document.getElementById('searchInput');
    const searchForm = document.getElementById('searchForm');
    
    // 上傳相關
    const uploadModal = document.getElementById('uploadModal');
    const uploadForm = document.getElementById('uploadForm');
    const folderSelect = document.getElementById('folderSelect');
    const progressBar = document.getElementById('progressBar');
    const progressArea = document.getElementById('progressArea');
    const fileInput = document.getElementById('fileInput');
    const folderInput = document.getElementById('folderInput');
    
    // 配額顯示
    const quotaUsedEl = document.getElementById('quotaUsed');
    const quotaMaxEl = document.getElementById('quotaMax');
    const quotaBar = document.getElementById('quotaBar');
    
    // 菜單與交互
    const contextMenu = document.getElementById('contextMenu');
    const viewSwitchBtn = document.getElementById('view-switch-btn');
    const trashBtn = document.getElementById('trashBtn'); // 回收站按鈕
    const trashBanner = document.getElementById('trashBanner'); // 回收站橫幅
    const emptyTrashBtn = document.getElementById('emptyTrashBtn'); // 清空回收站按鈕
    const restoreBtn = document.getElementById('restoreBtn'); // 還原按鈕
    const deleteForeverBtn = document.getElementById('deleteForeverBtn'); // 永久刪除按鈕
    const dropZone = document.getElementById('dropZone');
    const dropZoneOverlay = document.getElementById('dropZoneOverlay');

    // 移動相關
    const moveModal = document.getElementById('moveModal');
    const folderTree = document.getElementById('folderTree');
    const confirmMoveBtn = document.getElementById('confirmMoveBtn');
    const cancelMoveBtn = document.getElementById('cancelMoveBtn');
    let selectedMoveTargetId = null;

    // 分享相關
    const shareModal = document.getElementById('shareModal');
    const confirmShareBtn = document.getElementById('confirmShareBtn');
    const cancelShareBtn = document.getElementById('cancelShareBtn');
    const closeShareModalBtn = document.getElementById('closeShareModalBtn');
    const expiresInSelect = document.getElementById('expiresInSelect');
    const customExpiresInput = document.getElementById('customExpiresInput');
    const sharePasswordInput = document.getElementById('sharePasswordInput');
    const shareResult = document.getElementById('shareResult');
    const shareLinkContainer = document.getElementById('shareLinkContainer');
    const copyLinkBtn = document.getElementById('copyLinkBtn');

    // 預覽相關
    const previewModal = document.getElementById('previewModal');
    const modalContent = document.getElementById('modalContent');
    const closePreviewBtn = document.querySelector('#previewModal .close-button');

    // =================================================================================
    // 3. 初始化邏輯
    // =================================================================================
    
    // 解析 URL 獲取當前資料夾 ID (路徑格式: /view/:encryptedId)
    const pathParts = window.location.pathname.split('/');
    if (pathParts[1] === 'view' && pathParts[2] && pathParts[2] !== 'null') {
        currentFolderId = pathParts[2];
    }

    // 應用視圖設置並加載數據
    updateViewModeUI();
    loadFolder(currentFolderId);
    updateQuota();

    // =================================================================================
    // 4. 核心數據加載與渲染
    // =================================================================================

    /**
     * 加載資料夾內容
     * @param {string} encryptedId - 加密的資料夾 ID
     */
    async function loadFolder(encryptedId) {
        // 如果沒有 ID 且不是在回收站模式，通常意味著根目錄跳轉問題，暫不處理
        if (!encryptedId && !isTrashMode) return;
        
        isTrashMode = false; // 正常加載資料夾時退出回收站模式
        trashBanner.style.display = 'none';
        selectedItems.clear();
        updateContextMenuState();
        
        try {
            // 請求後端 API
            const res = await axios.get(`/api/folder/${encryptedId}`);
            const data = res.data;
            
            // 合併文件和資料夾
            items = [...data.contents.folders, ...data.contents.files];
            currentPath = data.path;
            
            // 渲染界面
            renderBreadcrumb();
            renderItems(items);
            updateFolderSelectForUpload(data.contents.folders);
            
            // 更新瀏覽器 URL (如果 ID 發生變化)
            const newUrl = `/view/${encryptedId}`;
            if (window.location.pathname !== newUrl) {
                window.history.pushState({ id: encryptedId }, '', newUrl);
            }
            currentFolderId = encryptedId;

            // 處理搜索框重置
            if (searchInput.value) {
                searchInput.value = '';
            }
            
        } catch (error) {
            console.error(error);
            const msg = error.response?.data?.message || error.message;
            // 如果是 404 或 ID 無效，可能需要重定向回首頁
            if (error.response && error.response.status === 400 && msg.includes('無效 ID')) {
                 window.location.href = '/'; 
                 return;
            }
            itemGrid.innerHTML = `<div class="error-msg" style="text-align:center; padding:20px; color:#dc3545;">加載失敗: ${msg}</div>`;
            itemListBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#dc3545;">加載失敗: ${msg}</td></tr>`;
        }
    }

    /**
     * 加載回收站內容
     */
    async function loadTrash() {
        isTrashMode = true;
        currentFolderId = null; // 回收站沒有目錄結構
        selectedItems.clear();
        updateContextMenuState();
        trashBanner.style.display = 'flex';
        
        // 設置麵包屑為回收站狀態，並添加退出按鈕
        breadcrumb.innerHTML = `
            <span><i class="fas fa-trash-restore"></i> 回收站</span>
            <a href="#" id="exitTrashLink" style="margin-left:15px; font-size:0.9rem; color:#007bff; text-decoration:none;">
                <i class="fas fa-sign-out-alt"></i> 退出回收站
            </a>
        `;
        
        // 綁定退出點擊事件
        document.getElementById('exitTrashLink').onclick = (e) => {
            e.preventDefault();
            window.location.reload(); 
        };
        
        try {
            const res = await axios.get('/api/trash');
            items = [...res.data.folders, ...res.data.files];
            renderItems(items);
        } catch (e) {
            alert('加載回收站失敗: ' + (e.response?.data?.message || e.message));
        }
    }
    
    // 綁定回收站按鈕
    trashBtn.addEventListener('click', loadTrash);

    // 清空回收站
    emptyTrashBtn.addEventListener('click', async () => {
        if(confirm('確定要清空回收站嗎？此操作無法撤銷。')) {
            try {
                await axios.post('/api/trash/empty');
                loadTrash(); // 刷新回收站
                updateQuota(); // 更新空間
            } catch(e) { alert('操作失敗'); }
        }
    });

    /**
     * 更新用戶配額顯示
     */
    async function updateQuota() {
        try {
            const res = await axios.get('/api/user/quota');
            const { used, max } = res.data;
            
            quotaUsedEl.textContent = formatSize(used);
            
            // 處理 max 為 0 或字符串的情況
            const maxVal = parseInt(max);
            const isUnlimited = maxVal === 0;
            
            quotaMaxEl.textContent = isUnlimited ? '無限' : formatSize(maxVal);
            
            if (!isUnlimited && maxVal > 0) {
                const percent = Math.min(100, Math.round((used / maxVal) * 100));
                quotaBar.style.width = `${percent}%`;
                
                // 根據使用比例變色
                if (percent > 90) quotaBar.style.backgroundColor = '#dc3545'; // 紅
                else if (percent > 70) quotaBar.style.backgroundColor = '#ffc107'; // 黃
                else quotaBar.style.backgroundColor = '#28a745'; // 綠
            } else {
                quotaBar.style.width = '0%'; // 無限容量時不顯示進度條
            }
        } catch (error) {
            console.warn('獲取配額失敗', error);
            quotaUsedEl.textContent = '-';
            quotaMaxEl.textContent = '-';
        }
    }

    /**
     * 渲染麵包屑導航
     */
    function renderBreadcrumb() {
        if(isTrashMode) return; 
        breadcrumb.innerHTML = '';
        
        // 首頁鏈接
        const rootLi = document.createElement('a');
        rootLi.href = '#';
        rootLi.innerHTML = '<i class="fas fa-home"></i> 首頁';
        rootLi.onclick = (e) => { 
            e.preventDefault(); 
            // 獲取路徑數組中的第一個元素（根目錄）的 ID
            if(currentPath.length > 0) loadFolder(currentPath[0].encrypted_id); 
        };
        breadcrumb.appendChild(rootLi);

        // 路徑節點
        currentPath.forEach((folder, index) => {
            const sep = document.createElement('span');
            sep.className = 'separator';
            sep.textContent = '/';
            breadcrumb.appendChild(sep);

            const a = document.createElement('a');
            a.textContent = folder.name;
            
            if (index === currentPath.length - 1) {
                a.classList.add('active'); // 當前目錄不可點擊
            } else {
                a.href = '#';
                a.onclick = (e) => { 
                    e.preventDefault(); 
                    loadFolder(folder.encrypted_id); 
                };
            }
            breadcrumb.appendChild(a);
        });
    }

    /**
     * 渲染文件列表 (同時處理網格和列表視圖)
     */
    function renderItems(itemsToRender) {
        itemGrid.innerHTML = '';
        itemListBody.innerHTML = '';
        
        if (itemsToRender.length === 0) {
            itemGrid.innerHTML = '<div class="empty-folder" style="text-align:center; padding:50px; color:#999;"><i class="fas fa-folder-open" style="font-size:48px; margin-bottom:10px;"></i><p>此位置為空</p></div>';
            itemListBody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:20px; color:#999;">為空</td></tr>`;
            return;
        }

        itemsToRender.forEach(item => {
            itemGrid.appendChild(createGridItem(item));
            itemListBody.appendChild(createListItem(item));
        });
    }

    // 創建網格視圖單元
    function createGridItem(item) {
        const div = document.createElement('div');
        div.className = 'grid-item item-card';
        if(isTrashMode) div.classList.add('deleted'); // 標記已刪除樣式
        
        div.dataset.id = getItemId(item);
        div.onclick = (e) => handleItemClick(e, item, div);
        div.oncontextmenu = (e) => handleContextMenu(e, item);
        div.ondblclick = () => handleItemDblClick(item);

        const iconClass = getIconClass(item);
        const iconColor = item.type === 'folder' ? '#fbc02d' : '#007bff';

        div.innerHTML = `
            <div class="item-icon">
                <i class="${iconClass}" style="color: ${iconColor};"></i>
                ${item.is_locked ? '<i class="fas fa-lock lock-badge"></i>' : ''}
            </div>
            <div class="item-info">
                <h5 title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h5>
            </div>
            ${isMultiSelectMode ? '<div class="select-checkbox"><i class="fas fa-check"></i></div>' : ''}
        `;
        
        if (selectedItems.has(getItemId(item))) div.classList.add('selected');
        return div;
    }

    // 創建列表視圖行
    function createListItem(item) {
        const div = document.createElement('div');
        div.className = 'list-row list-item';
        if(isTrashMode) div.classList.add('deleted'); // 標記已刪除樣式
        
        div.dataset.id = getItemId(item);
        div.onclick = (e) => handleItemClick(e, item, div);
        div.oncontextmenu = (e) => handleContextMenu(e, item);
        div.ondblclick = () => handleItemDblClick(item);

        const iconClass = getIconClass(item);
        // 如果是回收站，顯示刪除時間；否則顯示修改時間
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

    // 獲取文件圖標
    function getIconClass(item) {
        if (item.type === 'folder') return 'fas fa-folder';
        const ext = item.name.split('.').pop().toLowerCase();
        if (['jpg','jpeg','png','gif','bmp','webp'].includes(ext)) return 'fas fa-file-image';
        if (['mp4','mov','avi','mkv','webm'].includes(ext)) return 'fas fa-file-video';
        if (['mp3','wav','ogg','flac'].includes(ext)) return 'fas fa-file-audio';
        if (['pdf'].includes(ext)) return 'fas fa-file-pdf';
        if (['zip','rar','7z','tar','gz'].includes(ext)) return 'fas fa-file-archive';
        if (['txt','md','js','html','css','json','py','java'].includes(ext)) return 'fas fa-file-alt';
        if (['xls','xlsx','csv'].includes(ext)) return 'fas fa-file-excel';
        if (['doc','docx'].includes(ext)) return 'fas fa-file-word';
        if (['ppt','pptx'].includes(ext)) return 'fas fa-file-powerpoint';
        return 'fas fa-file';
    }

    // =================================================================================
    // 5. 交互事件處理
    // =================================================================================

    // 項目點擊（選擇邏輯）
    function handleItemClick(e, item, el) {
        const id = getItemId(item);
        
        // Ctrl 鍵或多選模式下進行切換選擇
        if (e.ctrlKey || isMultiSelectMode) {
            if (selectedItems.has(id)) {
                selectedItems.delete(id);
                el.classList.remove('selected');
            } else {
                selectedItems.add(id);
                el.classList.add('selected');
            }
        } else {
            // 單選模式：清除其他選擇
            document.querySelectorAll('.selected').forEach(x => x.classList.remove('selected'));
            selectedItems.clear();
            selectedItems.add(id);
            el.classList.add('selected');
        }
        updateContextMenuState();
    }

    // 項目雙擊（打開或下載）
    function handleItemDblClick(item) {
        if(isTrashMode) return; // 回收站項目不可直接打開
        
        if (item.type === 'folder') {
            loadFolder(item.encrypted_id);
        } else {
            // 檢查是否為文本文件，是則打開編輯器
            const ext = item.name.split('.').pop().toLowerCase();
            if (['txt', 'md', 'js', 'html', 'css', 'json', 'xml', 'py', 'java', 'c', 'cpp', 'log', 'ini', 'conf'].includes(ext)) {
                 window.open(`/editor.html?id=${item.message_id}&name=${encodeURIComponent(item.name)}`, '_blank');
            } else {
                // 下載文件 (新窗口打開下載代理)
                window.open(`/download/proxy/${item.message_id}`, '_blank');
            }
        }
    }

    // 右鍵菜單
    function handleContextMenu(e, item) {
        e.preventDefault();
        const id = getItemId(item);
        
        // 如果右鍵點擊的不是當前選中的項目，則切換選中狀態
        if (!selectedItems.has(id)) {
            document.querySelectorAll('.selected').forEach(x => x.classList.remove('selected'));
            selectedItems.clear();
            selectedItems.add(id);
            
            // 同步視覺狀態
            const selector = viewMode === 'grid' ? `.grid-item[data-id="${id}"]` : `.list-row[data-id="${id}"]`;
            const el = document.querySelector(selector);
            if(el) el.classList.add('selected');
        }
        updateContextMenuState();
        
        // 計算菜單位置（防止溢出屏幕）
        let x = e.clientX;
        let y = e.clientY;
        const menuWidth = 200; 
        const menuHeight = 350;
        
        if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 10;
        if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 10;

        contextMenu.style.top = `${y}px`;
        contextMenu.style.left = `${x}px`;
        contextMenu.style.display = 'flex'; // 使用 flex 布局
        
        // 點擊任意處關閉菜單
        document.addEventListener('click', () => contextMenu.style.display = 'none', { once: true });
    }

    // 更新右鍵菜單和工具欄按鈕狀態
    function updateContextMenuState() {
        const count = selectedItems.size;
        const isSingle = count === 1;
        let firstType = null;
        let firstId = null;
        
        if (isSingle) {
            const idStr = Array.from(selectedItems)[0];
            [firstType, firstId] = parseItemId(idStr);
        }

        // 判斷模式：回收站 vs 正常
        const normalBtns = document.querySelectorAll('.normal-mode-btn'); // 需要在 HTML 中給正常按鈕加這個 class
        // 這裡我們動態控制 context menu 的項目
        const contextMenuItems = contextMenu.querySelectorAll('.menu-item');

        if (isTrashMode) {
            // 回收站模式下禁用大部分操作
            contextMenuItems.forEach(el => {
                if(el.id === 'deleteBtn') {
                    el.style.display = 'flex'; // 保留刪除按鈕
                    el.innerHTML = '<i class="fas fa-trash-restore"></i> 還原 / 刪除';
                } else {
                    el.style.display = 'none';
                }
            });
            // 隱藏工具欄的正常按鈕
            normalBtns.forEach(b => b.style.display = 'none');
        } else {
            // 正常模式：恢復顯示
            contextMenuItems.forEach(el => el.style.display = 'flex');
            normalBtns.forEach(b => b.style.display = 'inline-flex'); // 假設是 flex 布局
            
            // 恢復刪除按鈕文本
            const delBtn = document.getElementById('deleteBtn');
            if(delBtn) delBtn.innerHTML = '<i class="fas fa-trash-alt"></i> 刪除';

            // 設置按鈕可用性
            const setDisabled = (id, disabled) => {
                const btn = document.getElementById(id);
                if (btn) btn.disabled = disabled;
            };

            setDisabled('openBtn', !(isSingle && firstType === 'folder'));
            setDisabled('downloadBtn', !(isSingle && firstType === 'file'));
            setDisabled('renameBtn', !isSingle);
            setDisabled('deleteBtn', count === 0);
            
            // 啟用功能
            setDisabled('previewBtn', !isSingle || firstType === 'folder'); 
            setDisabled('shareBtn', !isSingle);
            setDisabled('moveBtn', count === 0); 
            setDisabled('lockBtn', !(isSingle && firstType === 'folder')); 
        }
        
        // 更新多選信息
        const infoEl = document.getElementById('selectionInfo');
        if (count > 0) {
            infoEl.style.display = 'block';
            infoEl.textContent = `已選中 ${count} 個項目`;
        } else {
            infoEl.style.display = 'none';
        }
    }

    // =================================================================================
    // 6. 工具欄按鈕事件
    // =================================================================================

    // 新建資料夾
    document.getElementById('createFolderBtn').addEventListener('click', async () => {
        const name = prompt('請輸入資料夾名稱:');
        if (name && name.trim()) {
            try {
                await axios.post('/api/folder/create', { 
                    name: name.trim(), 
                    parentId: currentFolderId 
                });
                loadFolder(currentFolderId);
            } catch (error) {
                alert('創建失敗: ' + (error.response?.data?.message || error.message));
            }
        }
    });

    // 新建/編輯文件
    document.getElementById('textEditBtn').addEventListener('click', () => {
        // 如果選中了一個文件，則編輯它
        if (selectedItems.size === 1) {
             const idStr = Array.from(selectedItems)[0];
             const [type, id] = parseItemId(idStr);
             if (type === 'file') {
                 // 獲取文件名
                 const item = items.find(i => getItemId(i) === idStr);
                 window.open(`/editor.html?id=${id}&name=${encodeURIComponent(item.name)}`, '_blank');
                 return;
             }
        }
        // 否則提示
        alert('請先上傳一個文本文件，然後選中它進行編輯。');
    });

    // 刪除按鈕 (通用，區分模式)
    document.getElementById('deleteBtn').addEventListener('click', async () => {
        if (selectedItems.size === 0) return;
        
        if (isTrashMode) {
            // 回收站模式下的刪除按鈕行為 -> 這裡我們引導用戶使用頂部的還原/永久刪除按鈕
            alert('請使用頂部的「還原」或「永久刪除」按鈕進行操作。');
            return;
        }
        
        if (!confirm(`確定要刪除選中的 ${selectedItems.size} 個項目嗎？`)) return;
        
        const files = [];
        const folders = [];
        
        selectedItems.forEach(id => {
            const [type, realId] = parseItemId(id);
            if (type === 'file') files.push(realId);
            else folders.push(realId);
        });

        try {
            await axios.post('/api/delete', { files, folders, permanent: false });
            selectedItems.clear();
            loadFolder(currentFolderId);
            updateQuota();
        } catch (error) {
            alert('刪除失敗: ' + (error.response?.data?.message || error.message));
        }
    });

    // 還原按鈕 (Trash Banner)
    restoreBtn.addEventListener('click', async () => {
        if (selectedItems.size === 0) return alert('請先選擇要還原的項目');
        
        const files = [];
        const folders = [];
        selectedItems.forEach(id => {
            const [type, realId] = parseItemId(id);
            if (type === 'file') files.push(realId);
            else folders.push(realId);
        });

        try {
            await axios.post('/api/trash/restore', { files, folders });
            selectedItems.clear();
            loadTrash();
            updateQuota();
        } catch (error) {
            alert('還原失敗: ' + (error.response?.data?.message || error.message));
        }
    });

    // 永久刪除按鈕 (Trash Banner)
    deleteForeverBtn.addEventListener('click', async () => {
        if (selectedItems.size === 0) return alert('請先選擇要刪除的項目');
        if (!confirm('確定要永久刪除嗎？此操作無法撤銷！')) return;
        
        const files = [];
        const folders = [];
        selectedItems.forEach(id => {
            const [type, realId] = parseItemId(id);
            if (type === 'file') files.push(realId);
            else folders.push(realId);
        });

        try {
            await axios.post('/api/delete', { files, folders, permanent: true });
            selectedItems.clear();
            loadTrash();
            updateQuota();
        } catch (error) {
            alert('永久刪除失敗: ' + (error.response?.data?.message || error.message));
        }
    });

    // 重命名按鈕
    document.getElementById('renameBtn').addEventListener('click', async () => {
        if (selectedItems.size !== 1) return;
        
        const idStr = Array.from(selectedItems)[0];
        const [type, id] = parseItemId(idStr);
        const item = items.find(i => getItemId(i) === idStr);
        
        if (!item) return;

        const newName = prompt('重命名:', item.name);
        if (newName && newName !== item.name) {
            try {
                await axios.post('/api/rename', { type, id, name: newName });
                loadFolder(currentFolderId);
            } catch (error) {
                alert('重命名失敗: ' + (error.response?.data?.message || error.message));
            }
        }
    });

    // 下載按鈕 (工具欄和右鍵共用)
    document.getElementById('downloadBtn').addEventListener('click', () => {
        if (selectedItems.size !== 1) return;
        const idStr = Array.from(selectedItems)[0];
        const [type, id] = parseItemId(idStr);
        
        if (type !== 'file') return alert('只能下載文件');
        window.open(`/download/proxy/${id}`, '_blank');
    });
    
    // 打開按鈕
    document.getElementById('openBtn').addEventListener('click', () => {
         if (selectedItems.size !== 1) return;
         const idStr = Array.from(selectedItems)[0];
         const [type, id] = parseItemId(idStr);
         if (type === 'folder') {
             // 這裡 id 是原始 ID，需要加密 ID
             const item = items.find(i => getItemId(i) === idStr);
             if(item) loadFolder(item.encrypted_id);
         }
    });
    
    // 預覽按鈕
    document.getElementById('previewBtn').addEventListener('click', async () => {
        if (selectedItems.size !== 1) return;
        const idStr = Array.from(selectedItems)[0];
        const [type, id] = parseItemId(idStr);
        const item = items.find(i => getItemId(i) === idStr);
        
        if (!item || type !== 'file') return;
        
        const ext = item.name.split('.').pop().toLowerCase();
        const mime = item.mimetype || '';
        const downloadUrl = `/download/proxy/${id}`;
        
        let content = '';
        
        if (mime.startsWith('image/') || ['jpg','jpeg','png','gif','webp','svg'].includes(ext)) {
            content = `<img src="${downloadUrl}" alt="${escapeHtml(item.name)}" style="max-width:100%; max-height:80vh;">`;
        } else if (mime.startsWith('video/') || ['mp4','webm'].includes(ext)) {
             content = `<video src="${downloadUrl}" controls style="max-width:100%; max-height:80vh;"></video>`;
        } else if (mime.startsWith('audio/') || ['mp3','wav','ogg'].includes(ext)) {
             content = `<audio src="${downloadUrl}" controls></audio>`;
        } else if (mime.startsWith('text/') || ['txt','md','json','js','css','html','xml','log'].includes(ext)) {
             // 文本預覽，需請求內容
             try {
                 modalContent.innerHTML = '<p>正在加載...</p>';
                 previewModal.style.display = 'flex';
                 const res = await axios.get(downloadUrl, { responseType: 'text' });
                 content = `<pre>${escapeHtml(res.data)}</pre>`;
             } catch(e) {
                 content = `<p style="color:red">無法預覽: ${e.message}</p>`;
             }
        } else {
             content = `<div class="no-preview">
                <i class="fas fa-file" style="font-size:48px; margin-bottom:20px;"></i>
                <p>此文件類型不支持在線預覽</p>
                <a href="${downloadUrl}" class="upload-link-btn">下載文件</a>
             </div>`;
        }
        
        modalContent.innerHTML = content;
        previewModal.style.display = 'flex';
    });
    
    closePreviewBtn.onclick = () => previewModal.style.display = 'none';
    
    // 加密按鈕
    document.getElementById('lockBtn').addEventListener('click', async () => {
        if (selectedItems.size !== 1) return;
        const idStr = Array.from(selectedItems)[0];
        const [type, id] = parseItemId(idStr);
        if (type !== 'folder') return;
        
        const password = prompt('請為此資料夾設置密碼 (留空則不設置):');
        if (password === null) return; // 取消
        
        try {
            // 加密 ID 需要傳給後端
            const item = items.find(i => getItemId(i) === idStr);
            await axios.post('/api/folder/lock', { 
                folderId: item.encrypted_id, 
                password: password 
            });
            alert('設置成功');
            loadFolder(currentFolderId);
        } catch (e) {
             alert('操作失敗: ' + (e.response?.data?.message || e.message));
        }
    });

    // 視圖切換
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
            viewSwitchBtn.title = "切換到列表視圖";
        } else {
            itemGrid.style.display = 'none';
            itemListView.style.display = 'block';
            viewSwitchBtn.innerHTML = '<i class="fas fa-th-large"></i>';
            viewSwitchBtn.title = "切換到網格視圖";
        }
    }

    // 搜索
    searchForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const q = searchInput.value.trim();
        if(!q) return loadFolder(currentFolderId);
        
        try {
            const res = await axios.get(`/api/search?q=${encodeURIComponent(q)}`);
            // 搜索結果混合文件和資料夾
            items = [...res.data.folders, ...res.data.files];
            
            // 渲染搜索結果
            renderItems(items);
            
            // 更新麵包屑為搜索狀態
            breadcrumb.innerHTML = '<span><i class="fas fa-search"></i> 搜索結果</span>';
            const backBtn = document.createElement('a');
            backBtn.href = '#';
            backBtn.className = 'upload-link-btn';
            backBtn.style.marginLeft = '10px';
            backBtn.style.display = 'inline-block';
            backBtn.innerHTML = '<i class="fas fa-times"></i> 退出搜索';
            backBtn.onclick = (ev) => {
                ev.preventDefault();
                searchInput.value = '';
                loadFolder(currentFolderId);
            };
            breadcrumb.appendChild(backBtn);
            
        } catch(e) {
            alert('搜索失敗: ' + (e.response?.data?.message || e.message));
        }
    });
    
    // =================================================================================
    // 7. 移動功能
    // =================================================================================
    
    async function loadAllFolders() {
        try {
            const res = await axios.get('/api/folders');
            const folders = res.data;
            folderTree.innerHTML = '';
            
            const rootDiv = document.createElement('div');
            rootDiv.className = 'folder-item';
            rootDiv.textContent = '/ (根目錄)';
            // 簡單處理根目錄 ID：如果有路徑信息就用，否則嘗試從列表推斷
            const rootId = (currentPath.length > 0) ? currentPath[0].encrypted_id : (folders.find(f => !f.parent_id)?.encrypted_id || '');
            
            rootDiv.dataset.id = rootId;
            
            rootDiv.onclick = () => selectMoveTarget(rootDiv);
            folderTree.appendChild(rootDiv);
            
            folders.forEach(f => {
                // 簡單縮進顯示
                const div = document.createElement('div');
                div.className = 'folder-item';
                div.style.paddingLeft = '20px';
                div.innerHTML = `<i class="fas fa-folder" style="color:#fbc02d;margin-right:5px;"></i> ${escapeHtml(f.name)}`;
                div.dataset.id = f.encrypted_id;
                div.onclick = () => selectMoveTarget(div);
                folderTree.appendChild(div);
            });
        } catch (e) {
            folderTree.textContent = '加載失敗';
        }
    }
    
    function selectMoveTarget(el) {
        document.querySelectorAll('.folder-item.selected').forEach(e => e.classList.remove('selected'));
        el.classList.add('selected');
        selectedMoveTargetId = el.dataset.id;
        confirmMoveBtn.disabled = false;
    }
    
    document.getElementById('moveBtn').addEventListener('click', () => {
        if (selectedItems.size === 0) return;
        selectedMoveTargetId = null;
        confirmMoveBtn.disabled = true;
        moveModal.style.display = 'flex';
        loadAllFolders();
    });
    
    confirmMoveBtn.addEventListener('click', async () => {
        if (!selectedMoveTargetId) return;
        
        const files = [];
        const folders = [];
        selectedItems.forEach(id => {
            const [type, realId] = parseItemId(id);
            if (type === 'file') files.push(realId);
            else folders.push(realId);
        });
        
        try {
            confirmMoveBtn.textContent = '移動中...';
            await axios.post('/api/move', {
                files,
                folders,
                targetFolderId: selectedMoveTargetId
            });
            alert('移動成功');
            moveModal.style.display = 'none';
            selectedItems.clear();
            loadFolder(currentFolderId);
        } catch (e) {
            alert('移動失敗: ' + (e.response?.data?.message || e.message));
        } finally {
            confirmMoveBtn.textContent = '確定移動';
        }
    });
    
    cancelMoveBtn.onclick = () => moveModal.style.display = 'none';
    
    // =================================================================================
    // 8. 分享功能
    // =================================================================================
    
    document.getElementById('shareBtn').addEventListener('click', () => {
        if (selectedItems.size !== 1) return;
        shareModal.style.display = 'flex';
        document.getElementById('shareOptions').style.display = 'block';
        shareResult.style.display = 'none';
        sharePasswordInput.value = '';
        customExpiresInput.style.display = 'none';
        expiresInSelect.value = '24h';
    });
    
    expiresInSelect.addEventListener('change', () => {
        customExpiresInput.style.display = expiresInSelect.value === 'custom' ? 'block' : 'none';
    });
    
    confirmShareBtn.addEventListener('click', async () => {
        const idStr = Array.from(selectedItems)[0];
        const [type, id] = parseItemId(idStr);
        const expiresIn = expiresInSelect.value;
        const password = sharePasswordInput.value;
        
        let customTime = null;
        if (expiresIn === 'custom') {
            const date = new Date(customExpiresInput.value);
            if (isNaN(date.getTime())) return alert('請選擇有效的時間');
            customTime = date.getTime();
        }
        
        try {
            const res = await axios.post('/api/share/create', {
                itemId: id,
                itemType: type,
                expiresIn,
                customExpiresAt: customTime,
                password
            });
            
            if (res.data.success) {
                document.getElementById('shareOptions').style.display = 'none';
                shareResult.style.display = 'block';
                const link = `${window.location.origin}${res.data.link}`;
                shareLinkContainer.textContent = link;
                copyLinkBtn.dataset.link = link;
            }
        } catch (e) {
            alert('創建分享失敗: ' + (e.response?.data?.message || e.message));
        }
    });
    
    copyLinkBtn.addEventListener('click', () => {
        const link = copyLinkBtn.dataset.link;
        navigator.clipboard.writeText(link).then(() => {
            const originalText = copyLinkBtn.textContent;
            copyLinkBtn.textContent = '已複製';
            setTimeout(() => copyLinkBtn.textContent = originalText, 2000);
        });
    });
    
    closeShareModalBtn.onclick = () => shareModal.style.display = 'none';
    cancelShareBtn.onclick = () => shareModal.style.display = 'none';

    // =================================================================================
    // 9. 上傳功能
    // =================================================================================

    document.getElementById('showUploadModalBtn').addEventListener('click', () => {
        uploadModal.style.display = 'block';
    });
    
    document.getElementById('closeUploadModalBtn').addEventListener('click', () => {
        uploadModal.style.display = 'none';
    });
    
    uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        // 合併文件輸入和資料夾輸入的文件
        const allFiles = [...fileInput.files, ...folderInput.files];
        
        if (allFiles.length === 0) return alert('請選擇至少一個文件');
        
        // 獲取上傳目標（下拉框選擇的ID 或 當前目錄ID）
        const targetEncryptedId = folderSelect.value || currentFolderId;
        const formData = new FormData();
        
        allFiles.forEach(f => formData.append('files', f));

        // UI 狀態更新
        progressArea.style.display = 'block';
        progressBar.style.width = '0%';
        progressBar.textContent = '0%';
        
        try {
            // 通過 URL 參數傳遞目標文件夾 ID，確保 worker.js 能正確讀取
            await axios.post(`/upload?folderId=${targetEncryptedId}`, formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
                onUploadProgress: (p) => {
                    const percent = Math.round((p.loaded * 100) / p.total);
                    progressBar.style.width = percent + '%';
                    progressBar.textContent = percent + '%';
                }
            });
            
            alert('上傳成功');
            uploadModal.style.display = 'none';
            uploadForm.reset();
            progressArea.style.display = 'none';
            
            // 刷新視圖和配額
            loadFolder(currentFolderId);
            updateQuota();
            
        } catch (error) {
            alert('上傳失敗: ' + (error.response?.data?.message || error.message));
            progressArea.style.display = 'none';
        }
    });

    // 更新上傳彈窗中的目標文件夾下拉框
    function updateFolderSelectForUpload(folders) {
        folderSelect.innerHTML = `<option value="${currentFolderId}">當前資料夾</option>`;
        if (folders) {
            folders.forEach(f => {
                const op = document.createElement('option');
                op.value = f.encrypted_id;
                op.textContent = f.name;
                folderSelect.appendChild(op);
            });
        }
    }

    // =================================================================================
    // 10. 其他輔助功能
    // =================================================================================

    // 退出登錄
    document.getElementById('logoutBtn').addEventListener('click', () => {
        window.location.href = '/logout';
    });
    
    // 多選模式切換
    document.getElementById('multiSelectToggleBtn').addEventListener('click', () => {
        isMultiSelectMode = !isMultiSelectMode;
        document.body.classList.toggle('selection-mode-active', isMultiSelectMode);
        document.getElementById('multiSelectToggleBtn').classList.toggle('active', isMultiSelectMode);
        renderItems(items); // 重新渲染以顯示/隱藏復選框
        contextMenu.style.display = 'none';
    });
    
    // 全選
    document.getElementById('selectAllBtn').addEventListener('click', () => {
        if (selectedItems.size === items.length) {
            selectedItems.clear();
            document.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
        } else {
            items.forEach(item => selectedItems.add(getItemId(item)));
            document.querySelectorAll('.item-card, .list-item').forEach(el => el.classList.add('selected'));
        }
        updateContextMenuState();
        contextMenu.style.display = 'none';
    });

    // 拖拽上傳提示 (瀏覽器對拖拽直接讀取 File 對象有嚴格限制，這裡僅做引導)
    dropZone.addEventListener('dragover', (e) => { 
        e.preventDefault(); 
        dropZoneOverlay.style.display = 'flex'; 
    });
    
    dropZone.addEventListener('dragleave', (e) => { 
        e.preventDefault(); 
        dropZoneOverlay.style.display = 'none'; 
    });
    
    dropZone.addEventListener('drop', (e) => { 
        e.preventDefault(); 
        dropZoneOverlay.style.display = 'none'; 
        alert('請點擊工具欄的「上傳文件」按鈕進行上傳。'); 
    });

    // 生成唯一 ID
    function getItemId(item) { 
        return item.type === 'file' ? `file:${item.message_id}` : `folder:${item.id}`; 
    }

    // 解析 ID
    function parseItemId(str) { 
        const p = str.split(':'); 
        return [p[0], p[1]]; 
    }

    // HTML 轉義
    function escapeHtml(text) { 
        if (!text) return '';
        return text.replace(/[&<>"']/g, m => ({ 
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' 
        })[m]); 
    }

    // 格式化文件大小
    function formatSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
});
