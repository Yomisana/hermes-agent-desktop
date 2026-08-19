# Hermes Desktop - Only Desktop app

目的：這個分支會讓 Hermes Desktop 預設避免直接在本機觸發 Python / Git / uv venv 的自動安裝。

## 目錄結構

```text
hermes-remote-patch/
├── apps/desktop/electron/
│   ├── remote-bootstrap-policy.ts   # 判斷是否跳過本機自動安裝
│   └── remote-seed-connection.ts    # 預寫遠端連線設定
├── patches/
│   └── 0001-skip-bootstrap.patch   # main.ts 的最小改動（約 8 行）
├── .github/workflows/
│   └── sync-and-build.yml           # 每日自動 rebase upstream + 打包
└── scripts/
    └── setup-fork.sh                # 一次性 fork 建置腳本
```

## 運作原理

1. `remote-bootstrap-policy.ts` 提供 `shouldSkipAutoBootstrap()`，讀取 `HERMES_DESKTOP_REMOTE_ONLY=true`（CI 打包時設定），為 true 時 `ensureRuntime()` 遇到 `backend.kind === 'bootstrap-needed'` 會直接丟出可讀錯誤，不會呼叫 `runBootstrap()`。
2. `remote-seed-connection.ts` 在 App 啟動最早期、讀取 `connection.json` 之前執行 `seedRemoteConnectionIfMissing()`：
   - 若使用者已有 `connection.json` → 完全不動（不會覆蓋使用者手動設定）
   - 若沒有 → 從打包時塞入的 `connection.seed.json` 讀取 gateway 網址，直接寫入，使用者開啟 App 即自動連線。
3. 兩個改動點都集中在單一 import + main.ts 裡各一小段呼叫，目的是讓 `git rebase upstream/main` 的衝突面降到最低。

## 首次設置（人工，一次性）

```bash
# 1. 到 GitHub 網頁 fork NousResearch/hermes-agent 到你的組織
# 2. 執行
./scripts/setup-fork.sh git@github.com:your-org/hermes-agent.git
# 3. 依照腳本輸出的指示，手動把 main.ts 的 8 行改動加上去（見 patches/ 內容）
# 4. 把 .github/workflows/sync-and-build.yml 複製進 fork 的 .github/workflows/
# 5. 在 fork repo 的 Settings → Secrets 設定：
#      PUSH_TOKEN           # 有 repo push 權限的 GitHub PAT
#      SLACK_WEBHOOK        # 衝突通知用
#      HERMES_GATEWAY_URL   # 例如 https://hermes.example.com:9119
```

## 之後的日常維護

- CI 每天自動 `git fetch upstream && git rebase upstream/main`，成功就自動 force-push 到 `remote-only` 並打包三平台安裝檔。
- Rebase 衝突時 CI 會 `git rebase --abort` 並發 Slack 通知，你本機解掉那一個 commit 的衝突（通常只有 main.ts 那 8 行左右）後 `git push --force-with-lease`，下一輪 CI 自動綠燈續跑。
- 官方一旦合併你的功能訴求後，把 workflow 裡的 rebase 步驟關掉即可退場，不需要刪除任何東西。

## 產出物

CI 完成後在 GitHub Actions 的 Artifacts 分頁會有：
- `hermes-desktop-windows-latest` (.exe)
- `hermes-desktop-macos-latest` (.dmg)
- `hermes-desktop-ubuntu-latest` (.AppImage)

使用者下載對應平台安裝檔，安裝並開啟即直接連上遠端 gateway，不會安裝任何本機 Hermes Agent 執行環境。
