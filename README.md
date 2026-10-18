# 🌱 日常小記 (My Little Journal)

這是一個專為 GitHub Pages 設計的無伺服器（Serverless）個人圖文日誌網頁，透過 GitHub REST API 直接將照片與日誌儲存在這個儲存庫中，支援跨裝置同步與實體照片連帶刪除。

## 📁 檔案結構
- `index.html`: 網頁主結構
- `style.css`: 奶油手帳風樣式表
- `script.js`: 前端邏輯與 GitHub API 同步機制
- `data/entries.json`: 日誌資料庫（預設為空陣列 `[]`）
- `images/`: 透過網頁上傳的壓縮照片會自動存放在此資料夾
