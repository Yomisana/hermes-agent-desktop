# Hermes Server 安全補丁與官方 PR 分工

更新日期：2026-08-24

## 先確認修正要裝在哪裡

目前列出的 profile isolation 問題都發生在 Hermes Server API。攻擊或誤用請求是由 Desktop 發出，但真正允許跨 profile 存取的是 Server。

```text
Hermes Desktop ──API request──> Hermes Server ──讀寫──> profile/session files
                                      ↑
                               必須在這裡修權限
```

因此正式環境需要兩條發布流程：

- Desktop release：由本 repo 建置，提供給所屬使用者安裝。
- Server release：由 Server 管理者的部署流程建置，套用經審查的 server backport，部署到遠端主機。

不要把 server patch 只放進 Electron installer；remote-only Desktop 不包含、也不啟動那個遠端 Server 程式碼。

## 目前 issue／PR 對照

| 問題 | 真正範圍 | 目前已有工作 | 本 repo 的處理 |
|---|---|---|---|
| [#76932](https://github.com/NousResearch/hermes-agent/issues/76932)：isolated server 洩漏其他 profiles/session | Server profile/session endpoints | [PR #77125](https://github.com/NousResearch/hermes-agent/pull/77125)；另外 [#78423](https://github.com/NousResearch/hermes-agent/pull/78423)、[#71037](https://github.com/NousResearch/hermes-agent/pull/71037)、[#48652](https://github.com/NousResearch/hermes-agent/pull/48652) 有高度重疊 | 追蹤，暫不重新提交 |
| [#88897](https://github.com/NousResearch/hermes-agent/issues/88897)：Desktop 連 isolated server 時 session 寫到 default DB | Server/TUI gateway profile resolution | [PR #89173](https://github.com/NousResearch/hermes-agent/pull/89173) | 追蹤或保留原作者 backport |
| [#89173](https://github.com/NousResearch/hermes-agent/pull/89173) | 上一列的官方 PR，不是另一個 issue 修正 | Open PR | 不重複 PR |
| [#91330](https://github.com/NousResearch/hermes-agent/issues/91330)：可跨 profile 修改 `SOUL.md` | Server profile mutation endpoints | [PR #91345](https://github.com/NousResearch/hermes-agent/pull/91345)、[#91381](https://github.com/NousResearch/hermes-agent/pull/91381)；也與 [#78423](https://github.com/NousResearch/hermes-agent/pull/78423)、[#71037](https://github.com/NousResearch/hermes-agent/pull/71037) 重疊 | 追蹤；較完整方向是 [#91381](https://github.com/NousResearch/hermes-agent/pull/91381) |
| [#91345](https://github.com/NousResearch/hermes-agent/pull/91345) | [#91330](https://github.com/NousResearch/hermes-agent/issues/91330) 的較窄 PR | Open PR | 不重複 PR |
| [#91381](https://github.com/NousResearch/hermes-agent/pull/91381) | [#91330](https://github.com/NousResearch/hermes-agent/issues/91330) 的較廣 PR | Open PR | 不重複 PR；注意它明列 aggregate endpoints 尚未涵蓋 |

以上狀態已於 2026-08-24 透過 GitHub API 重新確認。`#91330`、`#91345` 與 `#91381` 仍為 open，並沒有合併；「PR 內已寫好修正」不等於「已進入官方 main 或 release」。官方最新 release `v2026.8.19` 也不能視為已包含這些仍未合併的 PR。

官方狀態會變動；部署或準備 PR 前必須重新查詢，不能只依賴這份日期快照。

## 自行管理的 Server 要怎麼 backport？

安全的做法不是「把所有 open PR 一次混在一起」，而是每個根因建立一個獨立 backport branch：

1. 從目前部署的官方 tag 建立 branch。
2. 選定一個官方 PR，記錄 PR 編號、head commit SHA 與作者。
3. 先閱讀完整 diff；open PR 仍可能改寫、衝突或被官方拒絕。
4. 使用 `git cherry-pick -x <commit>` 保留原作者及來源。若 PR 有多個 commit，維持原順序。
5. 解衝突後執行該 PR 列出的測試，再加入部署方自己的跨 profile E2E 測試。
6. 產生 Server image/package，部署到測試環境。
7. 使用兩個真實隔離 profiles 驗證讀取、寫入、session DB 與 aggregate endpoints 都無法越界。
8. 通過安全 review 後才部署 production。

不建議 CI 每次從 `refs/pull/<number>/head` 直接建 production。PR head 可以變動；部署方的 backport manifest 應鎖定完整 commit SHA。

本 repo 提供 `server-backports.example.json` 與 `scripts/apply-server-backports.py`。先複製範本、填入經過 review 的完整 commit SHA、reviewer 與日期，再對乾淨的 Hermes Agent checkout 執行：

```bash
python scripts/apply-server-backports.py /path/to/hermes-agent server-backports.json
```

工具會拒絕 dirty checkout、錯誤的官方基底 SHA、未填 review 資訊、縮寫 SHA、已經移動的 PR head，以及沒有啟用 patch 的 manifest。它使用 `cherry-pick -x`，讓 backport commit 保留原作者與來源。若發生衝突會停止，必須人工檢查，不能在 production CI 自動猜解法。

## 最低驗收情境

假設有 `alice` 與 `bob`，Server 以 `alice --isolated` 啟動：

- Alice 可以讀寫自己的 `SOUL.md`、config、sessions 與 projects。
- 對 Bob 的讀取、寫入、export、rename、delete、import 等要求回傳 403。
- `profile=all` 只能得到 Alice 的資料，不能聚合 Bob。
- `/api/profiles`、`/api/status` 與 sidebar 只揭露 Alice。
- Server 不應開啟 Bob 的 `state.db`。
- Alice 新建的 Desktop session 必須寫入 Alice 的 `state.db`，不能寫入 machine/default DB。
- 非 isolated 的管理 dashboard 保留原本跨 profile 管理能力。
- isolated 的 default profile 也必須受保護，不能只用「profile 名稱不是 default」來猜 isolation。

## 準備官方貢獻

PR 去重分析會快速過期，因此不放在 public 文件中。本機維護者可以在被 Git 忽略的 `.local/` 目錄保存當次調查結果。每次準備官方 PR 前，都必須重新搜尋最新 issue、open PR 與 `main`，不能把舊的調查結果當成目前事實。
