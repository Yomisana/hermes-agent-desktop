# Hermes Desktop Remote-Only Builder

這是一個開源的 Hermes Desktop 建置工具，適合已經有遠端 Hermes Server、不希望每台使用者電腦都另外安裝完整 Hermes Agent 的個人與組織。

建置者可以產生 Windows、macOS 與 Linux 安裝檔。使用者只需要下載、安裝、連線，不需要在自己的電腦安裝 Python、Git、Node.js 或完整的 Hermes Agent。真正執行 Agent 的地方是由你或你的組織管理的遠端 Hermes Server。

## 給一般使用者

### 我要下載哪個檔案？

如果這個 repo 的維護者有發布公開安裝檔，請到 GitHub 的 **Releases** 頁面依照電腦系統下載。組織也可以 fork 本 repo，設定自己的 Server URL，再從自己的 Releases 提供安裝檔：

- Windows：`.exe`
- macOS：`.dmg`
- Linux：`.AppImage`、`.deb` 或 `.rpm`

版本名稱會長得像 `v2026.8.18-remote.1`：

- `2026.8.18` 是使用的 Hermes Agent 官方版本。
- `remote.1` 是這個 remote-only overlay 的第 1 版。

### 安裝後會發生什麼事？

1. 開啟 Hermes Desktop。
2. App 會自動帶入建置者設定的 Hermes Server 網址。
3. 如果系統要求登入，請使用 Server 管理者提供的登入方式。
4. 對話與 Agent 工作會在遠端 Server 執行，不會偷偷在你的電腦安裝另一套 Hermes Agent。

如果電腦上已經有自己的 Hermes 連線設定，安裝程式不會覆蓋它。

### 這個安裝檔不會做什麼？

- 不會自動安裝本機 Hermes Agent runtime。
- 不會把 Server token 或自訂 headers 明文放進預設連線檔。
- 不會因為重新安裝或更新就覆蓋使用者已存在的連線設定。

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
5. 把建置者設定的 Server URL 放進安裝包；不放 token。
6. 分別打包 Windows、macOS 與 Linux 安裝檔。
7. 用 `v<官方版本>-remote.<補丁版本>` 建立可追蹤的 release。

這個 repo 不會把整份 Hermes Agent 原始碼複製一份長期維護，因此比傳統 fork 更容易跟上官方版本。

## Desktop 補丁與 Server 補丁是兩件事

這裡的 Desktop 補丁只控制使用者電腦上的 App，例如避免自動安裝本機 runtime、預先設定遠端 Server URL。

如果漏洞位於 Hermes Server API，例如跨 profile 讀取 session、寫入別人的 `SOUL.md`，只更新 Desktop **不會**修好。遠端 Server 本身也必須升級或 backport 官方修正。詳細狀態與處理方式請看 [Server 安全補丁說明](docs/SECURITY-BACKPORTS.md)。

## 給維護者：版本與檔案

- `upstream.json`：官方 repo、tag、tag object SHA、commit SHA、Desktop package version 及 overlay version。
- `patches/manifest.json`：會套入 Desktop 的補丁，以及只供追蹤的 Server security issues/PRs。
- `scripts/apply-patch.py`：修改官方 `main.ts` 與 Electron 打包資源；找不到唯一 anchor 時立即停止。
- `scripts/version-info.py`：產生安裝檔版本及 release tag。
- `scripts/write-seed.py`：驗證並建立只包含 URL 的連線 seed。
- `server-backports.example.json`：Server backport manifest 範本；預設全部停用，不會盲目套 open PR。
- `scripts/apply-server-backports.py`：在乾淨且 SHA 相符的 Hermes Agent checkout 套用已審查、鎖定 commit 的 backport。
- `.github/workflows/sync-and-build.yml`：驗證、建置、打包及建立 draft release。

GitHub Actions secret 必須設定：

```text
HERMES_GATEWAY_URL=https://gateway.example.com
```

如果有設定，URL 只允許完整的 `http://` 或 `https://` 格式，而且不能包含帳號密碼。若未設定 secret，CI 仍會產生通用 remote-only 安裝檔，但不會預先指定 Server URL，使用者第一次開啟時需要自行設定連線。

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
