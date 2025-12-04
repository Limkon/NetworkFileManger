// public/scan.js

document.addEventListener('DOMContentLoaded', () => {
    const userSelect = document.getElementById('user-select');
    const scanWebdavBtn = document.getElementById('scan-webdav-btn');
    const scanLocalBtn = document.getElementById('scan-local-btn');
    const scanLog = document.getElementById('scan-log');

    // Cloudflare Workers 不支持扫描服务器本地文件系统
    // 因此禁用或隐藏本地扫描按钮，或者将其重用于其他用途（如 S3 扫描）
    if (scanLocalBtn) {
        scanLocalBtn.innerHTML = '<i class="fas fa-cloud"></i> 扫描 S3/R2';
        scanLocalBtn.onclick = () => startScan('s3');
    }
    
    scanWebdavBtn.onclick = () => startScan('webdav');

    // 加载用户列表
    loadUsers();

    async function loadUsers() {
        try {
            const res = await axios.get('/api/admin/users');
            userSelect.innerHTML = '<option value="">-- 请选择用户 --</option>';
            res.data.forEach(user => {
                const option = document.createElement('option');
                option.value = user.id;
                option.textContent = user.username;
                userSelect.appendChild(option);
            });
        } catch (error) {
            log('加载用户列表失败: ' + error.message, 'error');
        }
    }

    async function startScan(storageType) {
        const userId = userSelect.value;
        if (!userId) {
            alert('请先选择一个用户！');
            return;
        }

        if (!confirm(`确定要扫描 ${storageType.toUpperCase()} 存储并导入文件到选中用户吗？\n这可能需要一些时间。`)) return;

        log(`开始扫描 ${storageType.toUpperCase()} ...`, 'info');
        disableControls(true);

        try {
            // 注意：需要在 worker.js 中补充 POST /api/admin/scan 路由
            // 这是一个长连接请求，Workers 可能会超时，建议在后端使用 stream 或者 Durable Objects 处理
            const response = await fetch('/api/admin/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, storageType })
            });

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                const chunk = decoder.decode(value, { stream: true });
                // 假设后端以行流的形式返回日志
                const lines = chunk.split('\n');
                lines.forEach(line => {
                    if (line.trim()) {
                        // 简单解析日志类型
                        if (line.includes('Error') || line.includes('失败')) log(line, 'error');
                        else if (line.includes('Found') || line.includes('导入')) log(line, 'success');
                        else log(line, 'info');
                    }
                });
            }
            
            log('扫描完成。', 'success');

        } catch (error) {
            log('请求发生错误: ' + error.message, 'error');
        } finally {
            disableControls(false);
        }
    }

    function log(message, type = 'info') {
        const div = document.createElement('div');
        div.className = `log-${type}`;
        div.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        scanLog.appendChild(div);
        scanLog.scrollTop = scanLog.scrollHeight;
    }

    function disableControls(disabled) {
        userSelect.disabled = disabled;
        scanWebdavBtn.disabled = disabled;
        if (scanLocalBtn) scanLocalBtn.disabled = disabled;
    }
});
