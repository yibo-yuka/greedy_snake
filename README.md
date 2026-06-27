# 🐍 Greedy Snake PWA

> 多模式貪食蛇漸進式網頁遊戲 — 跨平台、可安裝、支援離線遊玩

[![Deploy Frontend](https://github.com/yibo-yuka/greedy_snake/actions/workflows/deploy-frontend.yml/badge.svg)](https://github.com/yibo-yuka/greedy_snake/actions/workflows/deploy-frontend.yml)

**🎮 立即遊玩**: https://yibo-yuka.github.io/greedy_snake/

---

## 🎮 遊戲模式

| 模式 | 狀態 | 說明 |
|------|------|------|
| ♾️ 無限模式 | ✅ 可遊玩 | 吃越多越好，速度越來越快，挑戰全球排行榜 |
| 🎯 關卡模式 | 🚧 Phase 3 | 吃滿 N 顆蘋果晉級，難度遞增 |
| 🏆 爬梯競速 | 🚧 Phase 4 | 2-4 人多人對戰，10 秒選起點，終點結算 |

## 📱 安裝為 App（PWA）

| 平台 | 安裝方式 |
|------|---------|
| Android Chrome | 網址列右側 「安裝」按鈕 |
| iOS Safari | 底部 「分享」→「加入主畫面」 |
| Desktop Chrome/Edge | 網址列右側 「安裝」圖示 |

## 🕹️ 操控方式

| 方式 | 操作 |
|------|------|
| 鍵盤 | `↑↓←→` 或 `WASD` |
| 手機觸控 | 在畫面上滑動 |
| 手機 D-pad | 畫面下方方向按鈕 |
| 暫停 | `Space` 或 `Esc` 或右上角按鈕 |

## 🏗️ 技術架構

```
greedy_snake/
├── .github/
│   └── workflows/
│       ├── deploy-frontend.yml   # 前端 → GitHub Pages (CI/CD)
│       └── deploy-backend.yml    # 後端 → GCP GCE [Phase 5]
│
├── frontend/                     # PWA 前端 (Phase 1)
│   ├── index.html                # 所有畫面 (Home/Nick/Game/GameOver)
│   ├── manifest.json             # PWA manifest
│   ├── service-worker.js         # 離線快取策略
│   ├── css/style.css             # 完整設計系統
│   ├── js/game.js                # 蛇引擎 + App 控制器
│   └── assets/icons/             # App 圖示
│
├── backend/                      # Django 後端 [Phase 2]
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── ...
│
└── README.md
```

## 🚀 本地開發

```bash
# 需要 HTTP server（不能直接用 file:// 開啟，Service Worker 需要 HTTP）
# 方法一：Python
python -m http.server 8080 --directory frontend/

# 方法二：Node.js
npx serve frontend/

# 方法三：VS Code Live Server 插件
# 開啟 frontend/index.html → 右鍵 → Open with Live Server
```

然後開啟 http://localhost:8080

## 📦 部署流程

### 前端（自動化）
```
git add .
git commit -m "feat: ..."
git push origin main
# → GitHub Actions 自動偵測 frontend/ 變更
# → 部署到 https://yibo-yuka.github.io/greedy_snake/
```

### 後端（Phase 2+）
```bash
# 本地開發
docker-compose up -d

# 生產部署 (GCP GCE)
# 詳見 backend/README.md
```

## 🎨 設計系統

- **主色**: Neon Green `#39ff14` (蛇)、Deep Red `#ff2244` (蘋果)
- **背景**: Deep Space `#050510`
- **字型**: [Orbitron](https://fonts.google.com/specimen/Orbitron) (標題) + [Inter](https://fonts.google.com/specimen/Inter) (內文)
- **特效**: Canvas glow、粒子系統、CSS 動畫

## 📋 開發進度

- [x] **Phase 1** — PWA 核心 + 無限模式 + GitHub Pages CI/CD
- [ ] **Phase 2** — Django 後端 + 全球排行榜 + Docker
- [ ] **Phase 3** — 關卡模式
- [ ] **Phase 4** — 多人爬梯競速（Django Channels + WebSocket）
- [ ] **Phase 5** — GCP GCE 部署 + DuckDNS + HTTPS

## 🔧 圖示生成（首次設定）

PWA 需要 PNG 格式圖示，請執行以下指令生成：

```bash
# 需要 Inkscape 或 ImageMagick
# Inkscape:
inkscape frontend/assets/icons/icon.svg --export-png=frontend/assets/icons/icon-192.png --export-width=192
inkscape frontend/assets/icons/icon.svg --export-png=frontend/assets/icons/icon-512.png --export-width=512
cp frontend/assets/icons/icon-512.png frontend/assets/icons/icon-maskable.png

# 或使用 ImageMagick:
convert frontend/assets/icons/icon.svg -resize 192x192 frontend/assets/icons/icon-192.png
convert frontend/assets/icons/icon.svg -resize 512x512 frontend/assets/icons/icon-512.png
```

或直接將自製的 `icon-192.png`、`icon-512.png` 放入 `frontend/assets/icons/` 目錄。

---

Made with ❤️ + 🐍
