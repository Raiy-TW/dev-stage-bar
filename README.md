# ios-stage-bar

Claude Code mod：在 iOS 專案的 prompt 上方畫出「現在在開發流程的哪一步」，並即時顯示正在跑什麼、是否疑似卡住。

A Claude Code mod (function hooks plugin) that draws the current iOS dev-flow stage above the prompt, plus live activity and stuck detection.

```
●━━━━━━━━━━●━━━━━━━━━━●━━━━━━━━━━●━━━━━━━━━━◉┄┄┄┄┄┄┄┄┄┄○┄┄┄┄┄┄┄┄┄┄○┄┄┄┄┄┄┄┄┄┄○┄┄┄┄┄┄┄┄┄┄○   M48
                                      驗證 · T3/5 · 12m
🔄 T3 impl: xcodebuild test 8m · T2 review 3m   [debug]
```

- 第 1 行：9 個階段各是一個點（需求 → 規格 → 拆解 → 實作 → 驗證 → 審查 → TF → 真機 → 送審），點距隨終端寬度伸縮。
- 第 2 行：只在目前那個點正下方寫「階段 · 進度 · 本階段耗時」。
- 第 3 行：進行中的 subagent／最久的指令，以及狀態：🔄 執行中、⏸ 等你（提問、授權、真機驗收、排審）、⚠ 可能卡住。
- 窄於 40 欄時退回單行：`●●●●◉○○○○ 驗證 · T3/5 · 12m`。
- 只在 iOS 專案啟用（cwd 有 `*.xcodeproj`、`*.xcworkspace` 或 `.asc/`）；其他專案完全不畫、不註冊工具。
- 純觀察：所有 hook 都原樣放行工具呼叫，不擋、不改；出錯只影響顯示。

## 需求

- Claude Code 2.1.280 以上，並開啟 function hooks（early access，API 可能變動）：

  ```bash
  export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
  ```

  或寫進 `~/.claude/settings.json` 的 `env`。

## 安裝

在 Claude Code 裡：

```
/plugin marketplace add Raiy-TW/ios-stage-bar
/plugin install ios-stage-bar@ios-stage-bar
```

開發中直接載入本機目錄（存檔會自動 reload）：

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir /path/to/ios-stage-bar
```

首次在某個目錄使用時需要接受 workspace trust，hooks 才會載入。

## 階段怎麼判斷

優先序由高到低：

1. **權威轉換**：呼叫這些 skill／workflow 時直接切換——`ios-review` → 審查、`ios-sim-verify` → 驗證、`ios-to-tf` → TF、`ios-submit` → 送審。沒有這些 skill 也沒關係，只是少了這條訊號。
2. **模型宣告**：mod 註冊了一個工具 `mcp__ios-stage-bar__SetStage({ stage, detail?, milestone? })`。在你的 `CLAUDE.md` 或流程文件加一句「每進入一個階段先呼叫 SetStage」即可。`stage` 可用值：`intent` `spec` `plan` `impl` `verify` `review` `tf` `device` `submit`。
3. **推測**（本 session 還沒有宣告時才會改階段，否則只更新第 3 行）：寫入 `/specs/` → 規格；派 `T3 …` 類 subagent → 實作；主迴圈跑 `xcodebuild test`／`simctl`／lint → 驗證；`asc builds upload`／`asc publish testflight` → TF；`asc review` → 送審。subagent 內的測試只算該 subagent 的細節，不改主流程階段。

階段可以往回跳（驗證失敗回實作是常態）。狀態以 cwd 為 key 存在 plugin store，新 session 會先顯示上次的階段並標「上次更新 X 前」。

## 自訂

**要改階段名稱、順序、badge、門檻、配色、點線字元，只改 `src/stages.ts`**，邏輯不用動。

卡住門檻可用環境變數暫時覆寫（分鐘）：

| 變數 | 預設 | 意義 |
|---|---|---|
| `IOS_STAGE_BAR_STUCK_MIN` | 20 | 單一工具呼叫跑超過多久且沒有新事件，算可能卡住 |
| `IOS_STAGE_BAR_IDLE_MIN` | 10 | 模型在工作但多久沒有任何工具事件，算可能卡住 |

## 開發

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .      # 單元與 plugin 測試
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate .  # 檢查 hook 與 $ 呼叫清單
```

結構：`hooks/index.ts`（接事件）、`src/rules.ts`（分類規則）、`src/state.ts`（階段狀態）、`src/format.ts`（狀態判定與排版）、`src/width.ts`（CJK 顯示寬度）、`src/stages.ts`（資料）。

## 已知限制

- 按下授權後、指令真正開始前的幾秒仍顯示「⏸ 等你」；非 Bash 工具授權後會一路顯示到結束。
- 右側的 `[-]` 是 Claude Code 自己加的收合鈕。
- Function hooks 仍是 early access，Claude Code 更新可能需要跟著調整。

## License

MIT
