# dev-stage-bar

Claude Code mod：在 prompt 上方畫出「這個任務走到哪一步」，並即時顯示正在跑什麼、是否疑似卡住。步驟表依**任務類型**（新功能／修 bug／非程式工作）切換，所有專案都啟用。

A Claude Code mod (function hooks plugin) that draws the current task's step progress above the prompt — the step list depends on the task type (feature / bugfix / non-code work) — plus live activity and stuck detection. Works in every project.

```
修bug ●━━━━━━━━━━━━━━●━━━━━━━━━━━━━━◉┄┄┄┄┄┄┄┄┄┄┄┄┄┄○┄┄┄┄┄┄┄┄┄┄┄┄┄┄○┄┄┄┄┄┄┄┄┄┄┄┄┄┄○┄┄┄┄┄┄┄┄┄┄┄┄┄┄○   M48
                                   紅測試 · 12m
🔄 T3 impl: xcodebuild test 8m · T2 review 3m   [debug]
```

- 第 1 行：最左是任務名，接著每個步驟一個點，點距隨終端寬度伸縮；右側是 milestone。任務還沒判定時只畫一行 dim 的「判斷任務中…」。
- 第 2 行：只在目前那個點正下方寫「步驟 · 進度 · 本步驟耗時」。
- 第 3 行：進行中的 subagent／最久的指令，以及狀態：🔄 執行中、⏸ 等你（提問、授權、驗收、排審）、⚠ 可能卡住。
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

mod 在每個專案都註冊工具 `mcp__dev-stage-bar__SetStage({ task?, stage, detail?, milestone? })`，工具說明本身就寫了使用規則，不需要改你的 `CLAUDE.md`：

- 接到新任務先呼叫一次並帶 `task`；之後每進入一個步驟再呼叫；換任務就帶新的 `task`（整條重來、計時與 badge 重設）。
- 不帶 `task` 時沿用目前任務；目前沒有任務時，若 `stage` 只屬於一種任務就用它，否則回錯誤請它帶 `task`。
- `stage` 不屬於該任務（例如 default 專案的 feature 沒有 `submit`）→ 回錯誤並列出合法值，狀態不變。

## 沒宣告時怎麼推斷

**任務類型**（只在本 session 還沒用 SetStage 宣告 task 時；推斷出的任務名以 dim 加「推測」顯示）：

- bugfix：skill `ios-diagnose`、`superpowers:systematic-debugging`，或主迴圈 Bash 含 `gh issue`。
- feature：skill `superpowers:brainstorming`，或寫入路徑含 `/specs/`。
- work：主迴圈至少 8 次讀取類呼叫（Read／Grep／Glob／WebFetch／WebSearch／ToolSearch、唯讀 Bash、只寫 `.md`），且沒有其他動作（非唯讀 Bash、寫程式檔、派 subagent…）。只在還沒有任何任務時判定。
- 寫了程式檔（非 `.md`）而任務仍未判定 → feature。

**步驟**（依目前任務查表，查不到就不改）：

1. **權威轉換**：`ios-review` → review、`ios-sim-verify` → verify、`ios-to-tf` → ship、`ios-submit` → submit、`ios-diagnose` → diagnose（未宣告任務時一併設為 bugfix）。例如 work 任務遇到 `ios-to-tf` 不會改步驟。
2. **推測**（本 session 沒有 SetStage／權威轉換時才改步驟）：寫入 `/specs/` → spec；派 `T3 …` 類 subagent → impl；主迴圈 `xcodebuild test`／`simctl`／lint → verify；`asc builds upload`／`asc publish testflight` → ship；`asc review`／`asc submit` → submit。subagent 內的指令只算該 subagent 的細節。

步驟可以往回跳。狀態以 cwd 為 key 存在 plugin store，新 session 會先顯示上次的任務與步驟並標「上次更新 X 前」。0.1 版存的 `tf`／`device` 會自動讀成 feature 的 `ship`／`accept`。

## 自訂

**要改任務與步驟、專案標籤、work 推斷門檻、badge、卡住門檻、配色、點線字元，只改 `src/stages.ts`**，邏輯不用動。

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
- Function hooks 仍是 early access，Claude Code 更新可能需要跟著調整。

## License

MIT
