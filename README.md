# Desktop Remote-Only Build（Patch 層）

目的：讓 Desktop app 預設避免在本機觸發執行環境（runtime / 依賴管理工具）的自動安裝，改為連線到預先設定的遠端服務。

## 目錄結構

```text
.
├── apps/desktop/electron/
│   ├── remote-bootstrap-policy.ts   # 判斷是否跳過本機自動安裝
│   └── remote-seed-connection.ts    # 預寫遠端連線設定
├── patches/
│   └── 0001-skip-bootstrap.patch   # main.ts 的最小改動
├── .github/workflows/
│   └── sync-and-build.yml           # 每日自動 rebase upstream + 打包
└── scripts/
    └── setup-fork.sh                # 一次性 fork 建置腳本
```

## 運作原理

1. `remote-bootstrap-policy.ts` 提供 `shouldSkipAutoBootstrap()`，讀取 `HERMES_DESKTOP_REMOTE_ONLY=true`（CI 打包時設定），為 true 時 `ensureRuntime()` 遇到 `backend.kind === 'bootstrap-needed'` 會直接丟出可讀錯誤，不會呼叫本機安裝流程。
2. `remote-seed-connection.ts` 在 App 啟動最早期、讀取連線設定檔之前執行 `seedRemoteConnectionIfMissing()`：
   - 若使用者已有連線設定 → 完全不動（不會覆蓋使用者手動設定）
   - 若沒有 → 從打包時塞入的 seed 檔讀取遠端服務網址，直接寫入，使用者開啟 App 即自動連線。
3. 改動點集中在單一 import + main.ts 裡各一小段呼叫，目的是讓 `git rebase upstream/main` 的衝突面降到最低。

## 首次設置（人工，一次性）

```bash
# 1. 到 Git 託管平台 fork 上游專案到你的帳號/組織
# 2. 執行（把 <your-fork-url> 換成你的 fork 網址）
./scripts/setup-fork.sh <your-fork-url>
# 3. 依照腳本輸出的指示，手動把 main.ts 的改動加上去（見 patches/ 內容）
# 4. 把 .github/workflows/sync-and-build.yml 複製進 fork 的 .github/workflows/
# 5. 在 fork repo 的 Settings → Secrets 設定：
#      PUSH_TOKEN           # 有 repo push 權限的存取權杖（PAT）
#      HERMES_GATEWAY_URL    # 遠端服務網址，例如 https://gateway.example.com
```

## 之後的日常維護

- CI 每天自動 `git fetch upstream && git rebase upstream/main`，成功就自動 force-push 到工作分支並打包各平台安裝檔。
- Rebase 衝突時 CI 會 `git rebase --abort` 並跳過 build job，你本機解掉衝突後 `git push --force-with-lease`，下一輪 CI 自動綠燈續跑。
- 上游一旦合併你的功能訴求後，把 workflow 裡的 rebase 步驟關掉即可退場，不需要刪除任何東西。

## 產出物

CI 完成後在 Actions 的 Artifacts 分頁會有各平台的安裝檔（如 `.exe` / `.dmg` / `.AppImage`）。

使用者下載對應平台安裝檔，安裝並開啟即直接連上遠端服務，不會安裝任何本機執行環境。
