# Hermes Desktop Remote-Only Builder

這是一個開源的 Hermes Desktop 建置工具，適合已經有遠端 Hermes Server、不希望每台使用者電腦都另外安裝完整 Hermes Agent 的個人與組織。

建置者可以產生 Windows、macOS 與 Linux 安裝檔。使用者只需要下載、安裝、連線，不需要在自己的電腦安裝 Python、Git、Node.js 或完整的 Hermes Agent。真正執行 Agent 的地方是由你或你的組織管理的遠端 Hermes Server。

## 給一般使用者

### 我要下載哪個檔案？

如果這個 repo 的維護者有發布公開安裝檔，請到 GitHub 的 **Releases** 頁面依照電腦系統下載。組織也可以 fork 本 repo，再從自己的 Releases 提供安裝檔：

- Windows：`.exe`
- macOS：`.dmg`
- Linux：`.AppImage`、`.deb` 或 `.rpm`

版本名稱會長得像 `v2026.8.18-remote.1`：

- `2026.8.18` 是使用的 Hermes Agent 官方版本。
- `remote.1` 是這個 remote-only overlay 的第 1 版。

### 安裝後會發生什麼事？

1. 開啟 Hermes Desktop。
2. 到 **Settings → Gateway → Remote gateway** 輸入 Server 管理者提供的網址。
3. 如果系統要求登入，請使用 Server 管理者提供的登入方式。
4. 對話與 Agent 工作會在遠端 Server 執行，不會偷偷在你的電腦安裝另一套 Hermes Agent。

公開安裝檔不會內建任何公司或私人 Server 網址；每位使用者都要自行設定連線。

### 這個安裝檔不會做什麼？

- 不會自動安裝本機 Hermes Agent runtime。
- 不會把 Server URL、token 或自訂 headers 放進安裝檔。
- 不會在 CI secrets 中要求或讀取 Gateway URL。

### 遇到問題怎麼辦？

請把以下資料提供給該安裝檔的維護者：

- 作業系統與版本。
- 安裝檔名稱，例如 `Hermes-0.17.0-remote.1-win-x64.exe`。
- 畫面上的錯誤訊息或截圖。
- 問題發生時間。

不要把密碼、token 或私人 Server 網址貼到公開的 GitHub issue。

## 這個 repo 怎麼運作？

可以把它想成「官方原版 + 一小包 remote-only 設定」：

```text
指定的 Hermes Agent 官方 tag
              +
Remote-only Desktop overlay
              ↓
Windows / macOS / Linux remote-only 安裝檔
```

每次建置時，GitHub Actions 會：

1. 讀取 `upstream.json`，取得指定的官方 tag 與 commit。
2. 從 Nous Research 下載乾淨的 Hermes Agent 原始碼。
3. 驗證 commit SHA，防止同名 tag 指到不同內容。
4. 套用本 repo 的 Desktop overlay。
5. 分別打包 Windows、macOS 與 Linux 安裝檔。
6. 用 `v<官方版本>-remote.<補丁版本>` 建立可追蹤的 release。

這個 repo 不會把整份 Hermes Agent 原始碼複製一份長期維護，因此比傳統 fork 更容易跟上官方版本。

## Desktop 補丁與 Server 補丁是兩件事

這裡的 Desktop 補丁只控制使用者電腦上的 App，目前只負責避免自動安裝本機 runtime。Server URL 由使用者在 App 裡設定。

如果漏洞位於 Hermes Server API，例如跨 profile 讀取 session、寫入別人的 `SOUL.md`，只更新 Desktop **不會**修好。遠端 Server 本身也必須升級或 backport 官方修正。Server 候選 PR、作者歸屬、驗證與離線 Container 工具集中在獨立的 [Yomisana/hermes-agent-patches](https://github.com/Yomisana/hermes-agent-patches) 維護。

## 給維護者：版本與檔案

- `upstream.json`：官方 repo、tag、tag object SHA、commit SHA、Desktop package version 及 overlay version。
- `patches/manifest.json`：只記錄會套入 Desktop client 的補丁。
- `scripts/apply-patch.py`：修改官方 `main.ts`；找不到唯一 anchor 時立即停止。
- `scripts/version-info.py`：產生安裝檔版本及 release tag。
- `.github/workflows/sync-and-build.yml`：驗證、建置、打包及建立 draft release。

這個公開建置流程不接受 `HERMES_GATEWAY_URL`，也不會把 Gateway URL 寫進安裝檔。使用者第一次開啟時需要自行設定連線，避免公開 repo 或公開 artifacts 意外帶入內部環境資訊。

## 升級官方 Hermes Agent

1. 選擇正式的官方 release tag，不直接追蹤每天變動的 `main`。
2. 更新 `upstream.json` 裡的 tag、完整 commit SHA 與 Desktop package version。
3. 在該 tag 上套用補丁並完成測試。
4. 若 overlay 內容改變，增加 `overlayVersion`。
5. 若官方版本已包含相同行為，先驗證後再移除對應 overlay。

「有人開了 PR」不代表已經可以移除補丁。必須等 PR 合併，而且修正已包含在目前鎖定的官方 tag。

## 要貢獻回官方時

- 一個根因使用一個獨立 PR，並附上可重現測試。
- 先搜尋官方 issue 與 open PR，避免重複別人的工作。
- 已有 PR 時，可以協助 review、測試或提供補充 commit；不要把別人的修正重新包裝成自己的 PR。
- 私人 Server URL、組織名稱、token 或內部部署資訊不能 commit 到 public repo，也不能放進官方 PR。
- 本 repo 可供不同組織建立自己的發行版；只有通用、可設定且符合官方產品設計的部分才適合 upstream。
