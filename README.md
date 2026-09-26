# dev-stage-bar

Claude Code mod：在 prompt 上方畫出「這個任務走到哪一步」，並即時顯示正在跑什麼、是否疑似卡住。步驟表依**任務類型**（新功能／修 bug／非程式工作）切換，所有專案都啟用。

A Claude Code mod (function hooks plugin) that draws the current task's step progress above the prompt — the step list depends on the task type (feature / bugfix / non-code work) — plus live activity and stuck detection. Works in every project.

```
修bug ●━━━━━━━━━━━━━━●━━━━━━━━━━━━━━◉┄┄┄┄┄┄┄┄┄┄┄┄┄┄○┄┄┄┄┄┄┄┄┄┄┄┄┄┄○┄┄┄┄┄┄┄┄┄┄┄┄┄┄○┄┄┄┄┄┄┄┄┄┄┄┄┄┄○   M48
                                   紅測試 · 12m
🔄 T3 impl: xcodebuild test 8m · T2 review 3m   [debug]
```

- 第 1 行：最左是任務名，接著每個步驟一個點，點距隨終端寬度伸縮；右側是 milestone。沒有「現在」的任務時不畫點線，只畫一行 dim：
  - `問答中`：還沒有任何動作，或上一個 turn 只有讀取類工具／沒用工具。
  - `判斷任務中…`：進行中的 turn 已經改檔、跑非唯讀指令、派 subagent 或呼叫會改東西的 MCP 工具，但任務還沒判定。turn 結束後就不再顯示，只剩「上次：…」（沒有舊任務時「問答中」）。
  - 有舊任務時接 `上次：新功能 · TF · 17 小時前`（沒有步驟時省略步驟段）。
- 第 2 行：只在目前那個點正下方寫「步驟 · 進度 · 本步驟耗時」。
- 第 3 行：進行中的 subagent／最久的指令，以及狀態：🔄 執行中、⏸ 等你（提問、授權、驗收、排審）、⚠ 可能卡住。有現在的任務、上一個 turn 是問答、且沒有工具在跑時寫 dim 的「討論中」（badge 照舊接在後面）。
- 窄於 40 欄時退回單行：`修bug ●●◉○○○○ 紅測試 · 12m`。
- 純觀察：所有 hook 都原樣放行工具呼叫，不擋、不改；出錯只影響顯示。

## 任務類型與步驟

| task | 顯示 | 步驟（stage id） |
|---|---|---|
| `feature` | 新功能 | 需求 `intent` · 規格 `spec` · 拆解 `plan` · 實作 `impl` · 驗證 `verify` · 審查 `review` · 出貨 `ship` · 驗收 `accept` · 送審 `submit`（僅 iOS） |
| `bugfix` | 修bug | 重現 `reproduce` · 診斷 `diagnose` · 紅測試 `red` · 修正 `fix` · 驗證 `verify` · 審查 `review` · 出貨 `ship` |
| `work` | 非程式 | 釐清 `clarify` · 研究 `research` · 產出 `produce` · 審查 `review` · 交付 `deliver` |

## 專案類型

只分兩種，只影響少數標籤（`src/stages.ts` 的 `PROJECT_OVERRIDES`）：

- **ios**（cwd 有 `*.xcodeproj`、`*.xcworkspace` 或 `.asc/`）：`ship` 標「TF」、`accept` 標「真機」，feature 有「送審」（9 點）。
- **default**（其他所有目錄）：`ship` 標「部署」、`accept` 標「驗收」，feature 沒有送審（8 點）。

## 需求

- Claude Code 2.1.280 以上，並開啟 function hooks（early access，API 可能變動）：

  ```bash
  export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
  ```

  或寫進 `~/.claude/settings.json` 的 `env`。

## 安裝

在 Claude Code 裡：

```
/plugin marketplace add Raiy-TW/dev-stage-bar
/plugin install dev-stage-bar@dev-stage-bar
```

開發中直接載入本機目錄（存檔會自動 reload）：

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir /path/to/dev-stage-bar
```

首次在某個目錄使用時需要接受 workspace trust，hooks 才會載入。

## 模型怎麼宣告：SetStage

mod 在每個專案都註冊工具 `mcp__dev-stage-bar__SetStage({ task?, stage, detail?, milestone? })`，工具說明本身就寫了使用規則，並在 system prompt 的 `env_info_simple` 段尾加兩句提醒（只在 SetStage 註冊成功時加、用實際註冊到的工具名），不需要改你的 `CLAUDE.md`：

- 開始實際工作（寫程式、修 bug、做研究／規劃／文件產出）時先呼叫一次並帶 `task`；之後每進入一個步驟再呼叫；換任務就帶新的 `task`（整條重來、計時與 badge 重設）。
- 純問答、釐清問題時不呼叫。
- 不帶 `task` 時沿用目前任務；目前沒有任務時，若 `stage` 只屬於一種任務就用它，否則回錯誤請它帶 `task`。
- `stage` 不屬於該任務（例如 default 專案的 feature 沒有 `submit`）→ 回錯誤並列出合法值，狀態不變。

## 沒宣告時怎麼推斷

**任務類型**（只在本 session 還沒用 SetStage 宣告 task 時；推斷出的任務名以 dim 加「推測」顯示）：

- bugfix：skill `ios-diagnose`、`superpowers:systematic-debugging`，或主迴圈 Bash 含 `gh issue`。
- feature：skill `superpowers:brainstorming`，或寫入路徑含 `/specs/`。
- 寫了程式檔（非 `.md`）而沒有現在的任務 → feature，並推測步驟為實作（`impl`）。已有現在的任務（例如 prompt 推測的 bugfix）時不改。
- 使用者的 prompt（見下節）可推測 bugfix／feature／work 與第一步。
- 讀再多檔也不會推成 work。

**使用者的 prompt**（純本地關鍵字比對，不呼叫模型、不花 token）：

只看你自己送出的 prompt（Enter 或 Remote Control），通知、其他 session、SDK、排程送來的不算；turn 進行中打的 prompt 等它自己的 turn 開始才算。只有在**沒有現在的任務**時才會設定任務（以「推測」顯示、不鎖步驟）；已經在做的任務不會被下一句話的關鍵字換掉，本 session 用 SetStage 宣告的任務即使過期也不會。

只看第一行（先拿掉 ``` code block）的前 120 字，依序判斷，先中先贏：

| 順序 | 條件 | 結果 |
|---|---|---|
| 0 | 第一個詞是 slash command（`/save`、`/codex:rescue`；路徑 `/Users/…` 不算）、整句是接續語（繼續、好、ok、push、commit、存檔、save…）、或去掉標點後不超過 2 字 | 不判斷 |
| 1 | 症狀詞：閃退、crash、報錯、不會動、卡住、壞掉、壞了、當掉、當機、exception | 修bug · 重現（問句裡也算） |
| 2 | 問句：以 ?／？ 結尾，或含 嗎、呢、為什麼、什麼、怎麼、如何、是不是、會不會、有沒有、能不能、差別、解釋、哪、why、what、how、which | 問答：送出當下就顯示「問答中」／「討論中」 |
| 3 | 功能詞（新增、加上、加一個、做一個、實作、優化、改成、implement、add）＋祈使 | 新功能 · 需求 |
| 4 | 通用 bug 詞：錯誤、失敗、修好、修掉、修復、幫我修、error、fail、fix、bug、debug | 修bug · 重現 |
| 5 | 工作詞（研究、調查、規劃、整理、文件、報告、比較一下、做比較、對照、research、plan、docs）＋祈使 | 非程式 · 釐清 |

- 祈使：含 幫我、幫忙、請、把、給我、麻煩、我要、我想要、please、let's、can you、could you、i want、i need，或句首就是功能／工作詞（「新增一個…」「整理…」「adding a toggle…」）。
- 所以：「這段是怎麼實作的？」「錯誤處理要怎麼設計？」是問答；「為什麼會閃退？」是修bug；「幫我新增錯誤處理」「加上 error log」是新功能；「上傳一直失敗」是修bug；「首頁如果改成兩欄會比較好」「幫我 build 一下看看」不判斷。
- 單獨的「修」不算：「修一下文案」「修訂 README」不判斷；要「修好／修掉／修復／幫我修」。比對前先把「修改」換成「改」、「修訂」換成「訂」、「修飾」換成「飾」。
- 中文關鍵字以子字串比對；英文以單字邊界、不分大小寫，容許 s／es／ed／ing 字尾（crashes、failing、bugs；address 不是 add、planet 不是 plan、debugger 不是 debug）。
- 例：「幫我優化 dev-stage-bar 他會莫名卡在某個階段」→ 新功能（「卡在」不是症狀詞）；「用 haiku 讀 prompt 判斷任務 這個會很消耗token嗎？」→ 問答。
- 要改關鍵字、祈使詞、接續語、字數上限，只改 `src/stages.ts` 的 `PROMPT_INTENT`；判斷順序寫在同一處的註解與 `src/intent.ts`。

**步驟**（依目前任務查表，查不到就不改）：

1. **權威轉換**：`ios-review` → review、`ios-sim-verify` → verify、`ios-to-tf` → ship、`ios-submit` → submit、`ios-diagnose` → diagnose（未宣告任務時一併設為 bugfix）。例如 work 任務遇到 `ios-to-tf` 不會改步驟。
2. **推測**（本 session 沒有 SetStage／權威轉換時才改步驟）：寫入 `/specs/` → spec；派 `T3 …` 類 subagent → impl；主迴圈 `xcodebuild test`／`simctl`／lint → verify；`asc builds upload`／`asc publish testflight` → ship；`asc review`／`asc submit` → submit。subagent 內的指令只算該 subagent 的細節。

步驟可以往回跳。

## 新鮮度：「現在」還是「上次」

狀態以 cwd 為 key 存在 plugin store，跨 session 保留。會把它標成「現在」的事件：SetStage、權威轉換、推測步驟（推測到目前這一步也算）、任務推斷切換，以及本 session 主迴圈的任何動作（改檔、非唯讀指令、派 subagent…，只刷新時間、不改步驟）。badge、`/load`／`/save`、讀取類工具都不算。

- **fresh**＝最後一次設定是本 session，且距今不到 `THRESHOLDS.staleAfterMin`（預設 120 分鐘）。只有 fresh 的任務才畫點線。
- 不 fresh 的任務只畫一行 dim 的「上次：…」，不會因為新 session 跑了別的指令就看起來像現在的階段。
- 別的 session 的任務、或本 session 推斷但已過期的任務，在推斷裡強度為 0：本 session 任何任務訊號都能取代它（同一種任務也重新開始）。本 session 宣告的任務即使過期也不被推斷取代。本 session 的步驟訊號若屬於舊任務的步驟表，就延續舊任務並變回 fresh（步驟計時重來，舊的 detail 不帶過來；延續的是別的 session 宣告的任務時標「推測」）。
- 0.2 以前存的狀態沒有新鮮度欄位，一律視為「上次」；0.1 版存的 `tf`／`device` 會讀成 feature 的 `ship`／`accept`。

## 問答偵測

主迴圈一個 turn 裡只有讀取類工具（Read／Grep／Glob／WebFetch／WebSearch／ToolSearch、唯讀 Bash）、中性工具（AskUserQuestion、TodoWrite、沒有訊號的 Skill…）、名稱看起來唯讀的 MCP 工具，或完全沒用工具，就是「對話 turn」：不改任務／步驟、不刷新新鮮度，只改顯示（第 1 行「問答中」或第 3 行「討論中」）。改檔（含 `.md`）、非唯讀指令、派 subagent、其他 MCP 工具、SetStage，或任何改了任務／步驟的呼叫，都讓這個 turn 算「有動作」。

## 自訂

**要改任務與步驟、專案標籤、prompt 關鍵字、badge、卡住與新鮮度門檻、配色、點線字元，只改 `src/stages.ts`**，邏輯不用動。

卡住門檻可用環境變數暫時覆寫（分鐘）：

| 變數 | 預設 | 意義 |
|---|---|---|
| `DEV_STAGE_BAR_STUCK_MIN` | 20 | 單一工具呼叫跑超過多久且沒有新事件，算可能卡住 |
| `DEV_STAGE_BAR_IDLE_MIN` | 10 | 模型在工作但多久沒有任何工具事件，算可能卡住 |

## 開發

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .      # 單元與 plugin 測試
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate .  # 檢查 hook 與 $ 呼叫清單
```

結構：`hooks/index.ts`（接事件）、`src/rules.ts`（分類規則）、`src/state.ts`（任務／步驟狀態）、`src/tasks.ts`（依任務與專案查步驟表）、`src/format.ts`（狀態判定與排版）、`src/width.ts`（CJK 顯示寬度）、`src/stages.ts`（資料）。

## 已知限制

- 按下授權後、指令真正開始前的幾秒仍顯示「⏸ 等你」；非 Bash 工具授權後會一路顯示到結束。
- 右側的 `[-]` 是 Claude Code 自己加的收合鈕。
- `mcp__*` 工具預設算動作，名稱最後一段以 get／list／read／search／query／find／describe／view／fetch／screenshot／ui_describe／ui_view 開頭的算讀取（`src/rules.ts` 的 `MCP_READ_ONLY`）。名稱猜錯時會誤判問答。
- prompt 意圖只是關鍵字：「修」「add」這類字出現在別的語意裡會誤判（只影響沒有現在任務時的「推測」，模型一呼叫 SetStage 就以宣告為準）。
- 問答偵測以 turn 為單位：turn 還沒結束前不知道它是不是對話。背景 subagent 完成後引擎自己開的接續 turn（沒有使用者文字）不改變上一個 turn 的判定。
- 提醒段附加在 system prompt 的 `env_info_simple` 段；若之後版本改名或省略該段，提醒就不會出現（SetStage 的工具說明仍在）。
- 只討論、不動手超過 120 分鐘，任務會變成「上次」；再有任何步驟訊號、SetStage 或本 session 的動作就回來。
- Function hooks 仍是 early access，Claude Code 更新可能需要跟著調整。

## License

MIT
