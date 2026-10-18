document.addEventListener('DOMContentLoaded', () => {
  // DOM 元素
  const form = document.getElementById('journal-form');
  const dateInput = document.getElementById('entry-date');
  const moodInput = document.getElementById('entry-mood');
  const imageInput = document.getElementById('entry-image');
  const contentInput = document.getElementById('entry-content');
  const previewContainer = document.getElementById('image-preview-container');
  const previewImage = document.getElementById('image-preview');
  const removeImageBtn = document.getElementById('remove-image-btn');
  const uploadText = document.getElementById('upload-text');
  const submitBtn = document.getElementById('submit-btn');
  const entriesList = document.getElementById('entries-list');
  const entryCount = document.getElementById('entry-count');
  const refreshBtn = document.getElementById('refresh-btn');

  // 設定視窗 DOM 元素
  const openSettingsBtn = document.getElementById('open-settings-btn');
  const closeSettingsBtn = document.getElementById('close-settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const settingsForm = document.getElementById('settings-form');
  const clearSettingsBtn = document.getElementById('clear-settings-btn');
  const syncStatusDot = document.getElementById('sync-status-dot');
  const ghOwnerInput = document.getElementById('gh-owner');
  const ghRepoInput = document.getElementById('gh-repo');
  const ghBranchInput = document.getElementById('gh-branch');
  const ghTokenInput = document.getElementById('gh-token');

  const CONFIG_STORAGE_KEY = 'cute_journal_gh_config_v2';
  const DATA_FILE_PATH = 'data/entries.json';

  let entries = [];
  let entriesFileSha = null; // 紀錄 entries.json 在 GitHub 上的 SHA 值
  let currentImageDataUrl = null; // 預覽與壓縮後的 Data URL
  let localImagePreviewCache = {}; // 剛上傳照片的本地快取，消除 CDN 延遲

  // 預設填入今日日期
  dateInput.valueAsDate = new Date();

  // 初始化設定並載入雲端日誌
  let ghConfig = loadConfig();
  updateStatusIndicator();
  fetchEntriesFromGitHub();

  // ==========================================
  // 1. 設定管理與自動偵測 GitHub Pages 網址
  // ==========================================
  function loadConfig() {
    const saved = localStorage.getItem(CONFIG_STORAGE_KEY);
    let config = saved ? JSON.parse(saved) : { owner: '', repo: '', branch: 'main', token: '' };

    // 若部署於 username.github.io/repo-name，自動推斷 owner 與 repo
    if (!config.owner || !config.repo) {
      const host = window.location.hostname;
      const pathParts = window.location.pathname.split('/').filter(Boolean);
      if (host.endsWith('.github.io')) {
        config.owner = host.replace('.github.io', '');
        config.repo = pathParts.length > 0 ? pathParts[0] : `${config.owner}.github.io`;
      }
    }
    return config;
  }

  function updateStatusIndicator() {
    syncStatusDot.className = 'status-dot';
    if (ghConfig.owner && ghConfig.repo && ghConfig.token) {
      syncStatusDot.classList.add('online');
      openSettingsBtn.title = `已連線至 ${ghConfig.owner}/${ghConfig.repo} (可讀寫)`;
    } else if (ghConfig.owner && ghConfig.repo) {
      syncStatusDot.classList.add('readonly');
      openSettingsBtn.title = `唯讀模式：${ghConfig.owner}/${ghConfig.repo} (設定 Token 即可新增/刪除)`;
    } else {
      syncStatusDot.classList.add('offline');
      openSettingsBtn.title = '尚未設定 GitHub 雲端儲存庫';
    }
  }

  openSettingsBtn.addEventListener('click', () => {
    ghOwnerInput.value = ghConfig.owner || '';
    ghRepoInput.value = ghConfig.repo || '';
    ghBranchInput.value = ghConfig.branch || 'main';
    ghTokenInput.value = ghConfig.token || '';
    settingsModal.classList.remove('modal-hidden');
  });

  closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.add('modal-hidden');
  });

  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    ghConfig = {
      owner: ghOwnerInput.value.trim(),
      repo: ghRepoInput.value.trim(),
      branch: ghBranchInput.value.trim() || 'main',
      token: ghTokenInput.value.trim()
    };
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(ghConfig));
    updateStatusIndicator();
    settingsModal.classList.add('modal-hidden');
    await fetchEntriesFromGitHub();
  });

  clearSettingsBtn.addEventListener('click', () => {
    if (confirm('確定要清除這台裝置上的 GitHub 設定與 Token 嗎？')) {
      localStorage.removeItem(CONFIG_STORAGE_KEY);
      ghConfig = loadConfig();
      updateStatusIndicator();
      settingsModal.classList.add('modal-hidden');
    }
  });

  refreshBtn.addEventListener('click', () => {
    fetchEntriesFromGitHub();
  });

  // ==========================================
  // 2. GitHub REST API 核心封裝函式
  // ==========================================
  function getApiHeaders() {
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    };
    if (ghConfig.token) {
      headers['Authorization'] = `Bearer ${ghConfig.token}`;
    }
    return headers;
  }

  // UTF-8 字串與 Base64 安全互轉（支援中文與 Emoji）
  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    return btoa(binary);
  }

  function base64ToUtf8(base64) {
    const cleanBase64 = base64.replace(/\s/g, '');
    const binary = atob(cleanBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }

  // 從 GitHub 讀取 data/entries.json
  async function fetchEntriesFromGitHub() {
    if (!ghConfig.owner || !ghConfig.repo) {
      entries = [];
      renderEntries('請先點擊右上角「⚙️ 雲端設定」填入你的 GitHub 帳號與儲存庫名稱 🌱');
      return;
    }

    entryCount.textContent = '☁️ 同步中...';
    const url = `https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/contents/${DATA_FILE_PATH}?ref=${ghConfig.branch}&t=${Date.now()}`;

    try {
      const res = await fetch(url, { headers: getApiHeaders(), cache: 'no-store' });

      if (res.status === 404) {
        // 儲存庫內尚無 entries.json（全新狀態）
        entries = [];
        entriesFileSha = null;
        renderEntries();
        return;
      }

      if (!res.ok) {
        throw new Error(`GitHub API 回應錯誤 (${res.status})`);
      }

      const data = await res.json();
      entriesFileSha = data.sha;
      const decodedJson = base64ToUtf8(data.content);
      entries = JSON.parse(decodedJson);
      renderEntries();
    } catch (err) {
      console.error('讀取 GitHub 日誌失敗:', err);
      renderEntries('無法讀取雲端日誌，請檢查「⚙️ 雲端設定」中的儲存庫名稱或權限是否正確。');
    }
  }

  // 將更新後的 entries 陣列寫回 GitHub data/entries.json
  async function saveEntriesToGitHub(updatedEntries, commitMessage) {
    const url = `https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/contents/${DATA_FILE_PATH}`;
    const jsonString = JSON.stringify(updatedEntries, null, 2);

    // 若不知道最新 sha，先查詢一次避免 409 Conflict
    if (!entriesFileSha) {
      const checkRes = await fetch(`${url}?ref=${ghConfig.branch}&t=${Date.now()}`, {
        headers: getApiHeaders(),
        cache: 'no-store'
      });
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        entriesFileSha = checkData.sha;
      }
    }

    const body = {
      message: commitMessage,
      content: utf8ToBase64(jsonString),
      branch: ghConfig.branch
    };
    if (entriesFileSha) {
      body.sha = entriesFileSha;
    }

    const res = await fetch(url, {
      method: 'PUT',
      headers: getApiHeaders(),
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.message || `寫入 entries.json 失敗 (${res.status})`);
    }

    const result = await res.json();
    entriesFileSha = result.content.sha; // 更新最新 SHA
    return result;
  }

  // 上傳壓縮後的圖片至 GitHub images/ 目錄
  async function uploadImageToGitHub(entryId, dataUrl) {
    const imagePath = `images/${entryId}.jpg`;
    const url = `https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/contents/${imagePath}`;
    const base64Content = dataUrl.split(',')[1]; // 移除 data:image/jpeg;base64, 前綴

    const res = await fetch(url, {
      method: 'PUT',
      headers: getApiHeaders(),
      body: JSON.stringify({
        message: `Upload journal image ${entryId}.jpg`,
        content: base64Content,
        branch: ghConfig.branch
      })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.message || `上傳圖片失敗 (${res.status})`);
    }

    const result = await res.json();
    return {
      path: imagePath,
      sha: result.content.sha
    };
  }

  // 從 GitHub Repo 刪除實體圖片檔
  async function deleteImageFromGitHub(imagePath, knownSha) {
    const url = `https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/contents/${imagePath}`;
    let shaToDelete = knownSha;

    // 若舊資料沒有紀錄 imageSha，先向 GitHub 查詢該圖片目前的 sha
    if (!shaToDelete) {
      const getRes = await fetch(`${url}?ref=${ghConfig.branch}&t=${Date.now()}`, {
        headers: getApiHeaders(),
        cache: 'no-store'
      });
      if (getRes.status === 404) return; // 圖片已不存在，直接略過
      if (getRes.ok) {
        const fileData = await getRes.json();
        shaToDelete = fileData.sha;
      }
    }

    if (!shaToDelete) return;

    const delRes = await fetch(url, {
      method: 'DELETE',
      headers: getApiHeaders(),
      body: JSON.stringify({
        message: `Delete journal image ${imagePath}`,
        sha: shaToDelete,
        branch: ghConfig.branch
      })
    });

    // 404 代表檔案已經不在 Repo 內，視為成功清理
    if (!delRes.ok && delRes.status !== 404) {
      const errData = await delRes.json().catch(() => ({}));
      throw new Error(errData.message || `刪除圖片失敗 (${delRes.status})`);
    }
  }

  // ==========================================
  // 3. 圖片選擇、預覽與 Canvas 壓縮
  // ==========================================
  imageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    uploadText.textContent = '⏳ 照片壓縮處理中...';

    compressImage(file, 1000, 0.8, (compressedDataUrl) => {
      currentImageDataUrl = compressedDataUrl;
      previewImage.src = currentImageDataUrl;
      previewContainer.classList.remove('preview-hidden');
      uploadText.textContent = '📷 更換照片';
    });
  });

  removeImageBtn.addEventListener('click', () => {
    clearImageSelection();
  });

  function clearImageSelection() {
    currentImageDataUrl = null;
    imageInput.value = '';
    previewImage.src = '';
    previewContainer.classList.add('preview-hidden');
    uploadText.textContent = '📷 點擊上傳今日照片（選填）';
  }

  function compressImage(file, maxWidth, quality, callback) {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        callback(canvas.toDataURL('image/jpeg', quality));
      };
    };
  }

  // ==========================================
  // 4. 新增與刪除日誌事件處理
  // ==========================================
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!ghConfig.owner || !ghConfig.repo || !ghConfig.token) {
      alert('請先點擊右上角「⚙️ 雲端設定」填入 GitHub Token，才能將日誌與圖片上傳至儲存庫喔！');
      openSettingsBtn.click();
      return;
    }

    const entryId = Date.now().toString();
    const originalBtnText = submitBtn.textContent;
    submitBtn.disabled = true;

    try {
      let imagePath = null;
      let imageSha = null;

      // 步驟 A：若有選取圖片，先上傳至 Repo 的 images/ 資料夾
      if (currentImageDataUrl) {
        submitBtn.textContent = '☁️ 正在上傳照片至 GitHub...';
        const uploadResult = await uploadImageToGitHub(entryId, currentImageDataUrl);
        imagePath = uploadResult.path;
        imageSha = uploadResult.sha;
        // 存入本地預覽快取，避免 GitHub Raw CDN 剛上傳完延遲數秒
        localImagePreviewCache[imagePath] = currentImageDataUrl;
      }

      // 步驟 B：建立日誌物件並更新 data/entries.json
      submitBtn.textContent = '☁️ 正在同步日誌內容...';
      const newEntry = {
        id: entryId,
        date: dateInput.value,
        mood: moodInput.value,
        content: contentInput.value.trim(),
        image: imagePath,
        imageSha: imageSha,
        createdAt: Number(entryId)
      };

      const updatedEntries = [newEntry, ...entries];
      updatedEntries.sort((a, b) => new Date(b.date) - new Date(a.date) || b.createdAt - a.createdAt);

      await saveEntriesToGitHub(updatedEntries, `Add journal entry ${entryId}`);

      entries = updatedEntries;
      renderEntries();

      // 重設表單
      contentInput.value = '';
      clearImageSelection();
    } catch (err) {
      console.error('新增日誌失敗:', err);
      alert(`同步至 GitHub 失敗：${err.message}\n請確認你的 Token 是否具備 Contents (Read & Write) 權限。`);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalBtnText;
    }
  });

  // 處理單篇日誌與實體圖片連帶刪除
  async function handleDeleteEntry(entry, deleteButtonEl) {
    if (!ghConfig.owner || !ghConfig.repo || !ghConfig.token) {
      alert('請先點擊右上角「⚙️ 雲端設定」填入 GitHub Token 才能執行刪除！');
      openSettingsBtn.click();
      return;
    }

    const confirmMsg = entry.image
      ? '確定要刪除這篇日誌嗎？\n（同時也會將 GitHub 儲存庫內的實體照片一併刪除）'
      : '確定要刪除這篇日誌嗎？';

    if (!confirm(confirmMsg)) return;

    deleteButtonEl.disabled = true;
    deleteButtonEl.textContent = '⏳ 刪除中...';

    try {
      // 步驟 A：若該篇日誌含有圖片，先從 GitHub Repo 刪除實體照片檔
      if (entry.image) {
        await deleteImageFromGitHub(entry.image, entry.imageSha);
      }

      // 步驟 B：從陣列移除該篇日誌並更新 data/entries.json
      const updatedEntries = entries.filter((item) => item.id !== entry.id);
      await saveEntriesToGitHub(updatedEntries, `Delete journal entry ${entry.id}`);

      entries = updatedEntries;
      renderEntries();
    } catch (err) {
      console.error('刪除失敗:', err);
      alert(`刪除失敗：${err.message}`);
      deleteButtonEl.disabled = false;
      deleteButtonEl.textContent = '🗑️';
    }
  }

  // ==========================================
  // 5. 畫面渲染邏輯
  // ==========================================
  function resolveImageUrl(imagePath) {
    if (!imagePath) return '';
    // 若剛在當前頁面完成上傳，優先使用本地 Base64 快取確保零延遲顯示
    if (localImagePreviewCache[imagePath]) {
      return localImagePreviewCache[imagePath];
    }
    if (imagePath.startsWith('data:') || imagePath.startsWith('http')) {
      return imagePath;
    }
    // 透過 raw.githubusercontent.com 跨裝置直接讀取 Repo 內的圖片
    return `https://raw.githubusercontent.com/${ghConfig.owner}/${ghConfig.repo}/${ghConfig.branch}/${imagePath}`;
  }

  function renderEntries(customEmptyMessage) {
    entriesList.innerHTML = '';
    entryCount.textContent = `共 ${entries.length} 篇紀錄`;

    if (entries.length === 0) {
      const msg = customEmptyMessage || '目前還沒有日誌喔 🌱<br>在上方寫下你的第一篇日常紀錄吧！';
      entriesList.innerHTML = `<div class="empty-state"><p>${msg}</p></div>`;
      return;
    }

    entries.forEach((entry) => {
      const card = document.createElement('article');
      card.className = 'entry-card';

      const imgSrc = resolveImageUrl(entry.image);
      const imageHtml = imgSrc
        ? `<img src="${imgSrc}" alt="日誌照片" class="entry-image" loading="lazy">`
        : '';

      card.innerHTML = `
        <div class="entry-meta">
          <div class="entry-badges">
            <span class="date-badge">🗓️ ${escapeHtml(entry.date)}</span>
            <span class="mood-badge">${escapeHtml(entry.mood)}</span>
          </div>
          <button type="button" class="delete-btn" title="刪除這篇日誌與雲端照片">🗑️</button>
        </div>
        ${imageHtml}
        <div class="entry-text">${escapeHtml(entry.content)}</div>
      `;

      const deleteBtn = card.querySelector('.delete-btn');
      deleteBtn.addEventListener('click', () => handleDeleteEntry(entry, deleteBtn));

      entriesList.appendChild(card);
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>'"]/g, (tag) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag]));
  }
});
