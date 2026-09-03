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
- 安裝檔名稱，例如 `Hermes-0.21.0-remote.4-win-x64.exe`。
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

1. 讀取 `upstream.json`，並向官方 repo 查詢是否有更新的 release tag：
   - 有新 tag：改用新 tag（含 commit SHA、官方版本號），`overlayVersion` 重設為 `0`（`-remote.0` 就是「新官方 tag 的原樣重build」，之後每次 overlay 改動才往上加）。
   - 沒有新 tag，但本 repo 在上次版本更新之後還有新 commit：`overlayVersion` 自動 +1。
   - 若算出來的 release tag 已經是「已發佈」狀態，會繼續往後找到還沒被用掉的號碼，不會覆蓋既有安裝檔、也不會讓 CI 失敗。
   - 結果會由 CI 自動 commit 回 `upstream.json` 與 `patches/manifest.json`（訊息帶 `[skip ci]`）。
2. 從 Nous Research 下載乾淨的 Hermes Agent 原始碼。
3. 驗證 commit SHA，防止同名 tag 指到不同內容。
4. 套用本 repo 的 Desktop overlay。
5. 分別打包 Windows、macOS 與 Linux 安裝檔。
6. 用 `v<官方版本>-remote.<補丁版本>` 建立可追蹤的 release。

這個 repo 不會把整份 Hermes Agent 原始碼複製一份長期維護，因此比傳統 fork 更容易跟上官方版本。

## Local Workspace Bridge（把本機資料夾授權給遠端 Agent）

### 為什麼需要這個

Hermes Desktop 連到 remote gateway 時，**所有**檔案操作都會送到 Server 那一端（見官方 `apps/desktop/src/lib/desktop-fs.ts`：`isDesktopFsRemoteMode()` 會把 readDir / read-text / write-text / git-root / default-cwd 以及資料夾選擇器全部導到 `/api/fs/*` 與 `/api/files*`），Agent loop 也跑在那裡。所以 Agent 的 pwd 是 **Server 的家目錄**（例如 `/home/username`），你電腦上的 `C:\...` 或 `\\wsl.localhost\...` 專案資料夾對 Agent 來說根本不存在。

官方把這個缺口記在 [#18715 Support remote Hermes agent with local tool execution](https://github.com/NousResearch/hermes-agent/issues/18715)。`/v1/capabilities` 至今仍回報 `runtime.split_runtime: false`，候選 PR（[#63966](https://github.com/NousResearch/hermes-agent/pull/63966)、[#62518](https://github.com/NousResearch/hermes-agent/pull/62518)、[#21791](https://github.com/NousResearch/hermes-agent/pull/21791)）都還沒合併。

### 這個 overlay 做什麼

把一個**你明確授權**的本機資料夾，雙向鏡像到 gateway 主機上的某個路徑，只用 stock Hermes Server 已經提供的 API，**不需要對 Server 打任何補丁**：

| 用途 | Endpoint |
| --- | --- |
| 列出遠端目錄 | `GET /api/files?path=` |
| 讀遠端檔案 | `GET /api/files/read` |
| 寫遠端檔案 | `POST /api/files/upload` |
| 建遠端目錄 | `POST /api/files/mkdir` |
| 刪遠端檔案 | `DELETE /api/files` |

Agent 之後就在那個遠端路徑上工作，跟一般專案沒兩樣——跨 Agent 共通記憶庫要的就是這個。

**這是鏡像，不是掛載。** Agent 讀到的是副本，最多落後一個輪詢週期。真正的掛載需要 Server 把 tool call 轉回 client 執行，那是 Desktop-only overlay 做不到的事。

### 設定方式

第一次啟動會在 userData 目錄自動產生 `local-workspace-bridge.json` 範本：

- Windows：`%APPDATA%\Hermes\local-workspace-bridge.json`
- macOS：`~/Library/Application Support/Hermes/local-workspace-bridge.json`
- Linux：`~/.config/Hermes/local-workspace-bridge.json`

```json
{
  "enabled": true,
  "intervalSeconds": 10,
  "maxFileBytes": 2097152,
  "maxFiles": 5000,
  "ignore": ["*.log"],
  "mounts": [
    {
      "id": "shared-memory",
      "localPath": "\\\\wsl.localhost\\Ubuntu\\home\\me\\code-project\\shared-memory",
      "remotePath": "~/bridge/shared-memory",
      "mode": "two-way"
    }
  ]
}
```

- `localPath`：本機路徑。Windows（`C:\src\app`）、UNC（`\\wsl.localhost\Ubuntu\home\me\app`）或 POSIX（`/home/me/app`、`/mnt/c/src/app`）都可以；POSIX 路徑在 Windows 上會自動轉成 UNC / 磁碟機形式，所以 **WSL 專案資料夾可以直接授權**。
- `remotePath`：gateway 主機上的路徑。**不要寫死 `/home/<某個帳號>`** —— 用 `~/...`、`$HOME/...` 或 `${HOME}/...`，同步時會向 gateway 問出「目前這個帳號自己的家目錄」再展開（先打 `GET /api/files?path=~`，失敗才退回 `GET /api/fs/default-cwd`），所以同一份設定檔換人用也不必改。寫絕對路徑也還是可以，而且完全不會多打任何 API。展開結果會顯示在 `status()` 的 `remotePath` 欄位。
- `mode`：`two-way`（預設）、`push`（只上傳）、`pull`（只下載）。
- `profile`（選填）：指定要同步到哪個 Desktop 連線 profile。

改完設定重開 App，或在 DevTools console 執行 `window.hermesDesktop.localWorkspaceBridge.reload()`。另外還有 `status()` 與 `syncNow()` 可用。

### 安全與限制

- **預設關閉。** 沒有設定檔、或 `enabled` 不是 `true` 時，行為跟官方版本完全一樣。
- **`.env`、`.envrc`、`auth.json`、`credentials.json` 永遠不同步**，兩個方向都是。這不只是安全考量：Server 的 managed-files API 會把這些檔案從 list/read 隱藏（`_is_sensitive_path`），一旦上傳，下一輪就會被判定成「遠端已刪除」而把你本機的原檔刪掉。
- `.git`、`node_modules`、`.venv`、`__pycache__`、`dist`、`build`、`target` 等預設排除。
- Symlink 一律不跟隨，避免鏡像範圍逃出授權目錄。
- 單檔上限預設 2 MiB（硬上限 16 MiB）、單一 mount 檔案數上限預設 5000，超過就中止並回報，不會半套。
- 目錄只建立、不刪除。多留一個空目錄無害，誤判成遞迴刪除則不然。
- 兩邊同時改到同一個檔案時採「較新的贏」，較舊的那份會存成同目錄下的 `<檔名>.conflict-<時間戳>`，**不會靜默丟資料**。
- 本機資料夾讀不到時（WSL distro 名稱錯、磁碟未掛載）該 mount 直接報錯並跳過，不會因為掃到空目錄就把遠端整份刪掉。

### 測試

```bash
npx vitest run --project electron electron/local-workspace-bridge.test.ts
```

31 個測試涵蓋路徑轉換、ignore 規則、設定驗證、reconcile 決策，以及對一個模擬 gateway 的完整同步流程（首次上傳、Agent 端新增檔案、穩態零傳輸、雙向刪除、衝突保留、憑證檔不外流）。CI 在打包前會跑這個測試。

## Desktop 補丁與 Server 補丁是兩件事

這裡的 Desktop 補丁只控制使用者電腦上的 App，目前只負責避免自動安裝本機 runtime。Server URL 由使用者在 App 裡設定。

**判斷條件是「這是不是打包過的安裝檔」，不是環境變數。** 早期版本靠 `HERMES_DESKTOP_REMOTE_ONLY=true` 判斷，但 CI 只在 build 當下設了那個變數，環境變數不會跟著進到安裝好的 App，所以使用者電腦上這個判斷永遠是 false、官方的本機安裝流程照跑。現在改成 `shouldSkipAutoBootstrap(process.env, IS_PACKAGED)`：

| 情境 | 是否會自動安裝本機 runtime |
| --- | --- |
| 本 repo 的安裝檔 | 否（預設） |
| 官方原始碼 `npm run dev` | 是（跟官方一樣） |
| `HERMES_DESKTOP_SKIP_BOOTSTRAP=true` / `HERMES_DESKTOP_REMOTE_ONLY=true` | 否 |
| `HERMES_DESKTOP_ALLOW_LOCAL_BOOTSTRAP=true`（安裝檔） | 是（逃生門） |


如果漏洞位於 Hermes Server API，例如跨 profile 讀取 session、寫入別人的 `SOUL.md`，只更新 Desktop **不會**修好。遠端 Server 本身也必須升級或 backport 官方修正。Server 候選 PR、作者歸屬、驗證與離線 Container 工具集中在獨立的 [Yomisana/hermes-agent-patches](https://github.com/Yomisana/hermes-agent-patches) 維護。

## 給維護者：版本與檔案

- `upstream.json`：官方 repo、tag、tag object SHA、commit SHA、官方版本號（`upstreamVersion`，取自官方 `hermes_cli/__init__.py` 的 `__version__`；`apps/desktop/package.json` 長期停在 0.17.0 不能用）及 overlay version。
- `patches/manifest.json`：只記錄會套入 Desktop client 的補丁。
- `scripts/apply-patch.py`：修改官方 `main.ts`；找不到唯一 anchor 時立即停止。
- `scripts/apply-local-workspace-bridge.py`：接上 Local Workspace Bridge（`main.ts` + `preload.ts`）；同樣是字串錨點、找不到唯一 anchor 就停。
- `scripts/apply-release-update-source.py`：把 Desktop 的更新檢查指向本 repo 的 GitHub releases；必須在 remote-only patch 之後執行（它錨定在那個 patch 插入的 import）。
- `apps/desktop/electron/release-update-source.ts`：更新檢查的全部邏輯。只回報、不下載也不替換任何檔案。
- `apps/desktop/electron/remote-bootstrap-policy.ts`：判斷這個 build 是否允許自動安裝本機 runtime。
- `apps/desktop/electron/local-workspace-bridge.ts`：Bridge 全部的行為都在這一個獨立檔案，官方檔案只被改約 25 行，rebase 衝突面極小。
- `scripts/resolve-version.py`：決定要建置的官方 tag 與 `overlayVersion`，並產生安裝檔版本及 release tag。不加參數時只讀 `upstream.json`（離線），CI 才會帶 `--refresh-upstream --count-local-commits --probe-releases --write`。
- `.github/workflows/sync-and-build.yml`：驗證、建置、打包及建立 draft release。

這個公開建置流程不接受 `HERMES_GATEWAY_URL`，也不會把 Gateway URL 寫進安裝檔。使用者第一次開啟時需要自行設定連線，避免公開 repo 或公開 artifacts 意外帶入內部環境資訊。

## 更新檢查（Updates）

官方的 Desktop 自我更新是 git 流程：`checkUpdates()` 會去 git-pull 後端的 hermes root，所以只要那個目錄不是 git checkout 就直接回報

```
<path> isn't a git checkout — desktop self-update only runs against a source install.
```

用安裝檔裝的 remote-only build 永遠是這個狀態（機器上根本沒有官方原始碼），所以更新頁面看到的是錯誤而不是狀態。

本 repo 的 overlay 改成去查**本 repo 自己的 GitHub releases**：

- 目標預設 `Yomisana/hermes-agent-desktop`，可用環境變數 `HERMES_DESKTOP_UPDATE_REPO=<owner>/<repo>` 覆蓋。
- 比對用的是安裝檔版本（`0.21.0-remote.3`），不是 release tag（`v2026.8.31-remote.3`）——版本號從 asset 檔名 `Hermes-<version>-*` 讀出來，兩種編號永遠不會互比。
- 因為每個 build 都是 pre-release，用的是 `/releases` 列表而不是 `/releases/latest`（後者會跳過 pre-release）。
- **只回報，不自動更新**：有新版就顯示版本與下載連結，沒有就顯示 up to date，查不到就說查不到。實際安裝仍然是使用者自己下載安裝檔。

`resources/app-update.yml` 也一併指到本 repo：electron-builder 會從官方 `package.json` 的 `repository` 欄位推出 `NousResearch/hermes-agent`，CI 用 `--config.publish.owner/repo` 蓋掉它，並在打包後檢查產生出來的 `app-update.yml` 確實寫著本 repo，寫錯就讓 build 失敗。（官方 Desktop 目前沒有相依 `electron-updater`，這個檔案還沒有程式會讀，但將來官方接上時就不會抓錯來源。）

## 升級官方 Hermes Agent

1. 選擇正式的官方 release tag，不直接追蹤每天變動的 `main`。
2. 更新 `upstream.json` 裡的 tag、完整 commit SHA 與 `upstreamVersion`（平常由 CI 自動處理；要手動先跑一次可用 `python3 scripts/resolve-version.py --refresh-upstream --write`）。
3. 在該 tag 上套用補丁並完成測試。
4. `overlayVersion` 由 CI 自動維護：官方換新 tag 時歸 `0`，只有本 repo 改動時 +1；手動調整時記得同步 `patches/manifest.json` 的 `desktop-remote-only`。
5. 若官方版本已包含相同行為，先驗證後再移除對應 overlay。

「有人開了 PR」不代表已經可以移除補丁。必須等 PR 合併，而且修正已包含在目前鎖定的官方 tag。

## 要貢獻回官方時

- 一個根因使用一個獨立 PR，並附上可重現測試。
- 先搜尋官方 issue 與 open PR，避免重複別人的工作。
- 已有 PR 時，可以協助 review、測試或提供補充 commit；不要把別人的修正重新包裝成自己的 PR。
- 私人 Server URL、組織名稱、token 或內部部署資訊不能 commit 到 public repo，也不能放進官方 PR。
- 本 repo 可供不同組織建立自己的發行版；只有通用、可設定且符合官方產品設計的部分才適合 upstream。
