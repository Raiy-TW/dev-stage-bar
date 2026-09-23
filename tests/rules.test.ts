import { test, expect, describe } from 'claude-code/testing'
import { classify, commandLabel, agentShortName } from '../src/rules.ts'

describe('權威轉換', () => {
  test('Skill load → 接手標記，不改階段', async () => {
    const c = classify({ tool: 'Skill', skill: 'load' })
    expect(c.handoff).toBe('load')
    expect(c.authority).toBeUndefined()
  })
  test('Skill save → 交接完成標記', async () => {
    expect(classify({ tool: 'Skill', skill: 'save' }).handoff).toBe('save')
  })
  test('Skill 或 Workflow 的 ios-review → review', async () => {
    expect(classify({ tool: 'Skill', skill: 'ios-review' }).authority).toBe('review')
    expect(classify({ tool: 'Workflow', name: 'ios-review' }).authority).toBe('review')
    expect(classify({ tool: 'Workflow', scriptPath: '/Users/x/.claude/workflows/ios-review.js' }).authority).toBe('review')
  })
  test('ios-sim-verify → verify（Skill 與 Workflow 都接）', async () => {
    expect(classify({ tool: 'Skill', skill: 'ios-sim-verify' }).authority).toBe('verify')
    expect(classify({ tool: 'Workflow', name: 'ios-sim-verify' }).authority).toBe('verify')
  })
  test('ios-to-tf → tf；ios-submit → submit', async () => {
    expect(classify({ tool: 'Skill', skill: 'ios-to-tf' }).authority).toBe('tf')
    expect(classify({ tool: 'Skill', skill: 'ios-submit' }).authority).toBe('submit')
  })
  test('反例：其他 skill 不是權威轉換', async () => {
    const c = classify({ tool: 'Skill', skill: 'superpowers:brainstorming' })
    expect(c.authority).toBeUndefined()
    expect(c.handoff).toBeUndefined()
    expect(classify({ tool: 'Skill', skill: 'ios-review-notes' }).authority).toBeUndefined()
  })
  test('ios-diagnose（Skill 或 Workflow）→ debug badge', async () => {
    expect(classify({ tool: 'Skill', skill: 'ios-diagnose' }).badge).toBe('debug')
    expect(classify({ tool: 'Workflow', name: 'ios-diagnose' }).badge).toBe('debug')
  })
})

describe('推測：Write/Edit specs', () => {
  test('路徑含 /specs/ → spec', async () => {
    expect(classify({ tool: 'Write', file_path: '/p/docs/superpowers/specs/a.md' }).guess).toBe('spec')
    expect(classify({ tool: 'Edit', file_path: '/p/docs/specs/b.md' }).guess).toBe('spec')
  })
  test('反例：一般路徑與 Read 不推測', async () => {
    expect(classify({ tool: 'Write', file_path: '/p/Sources/App.swift' }).guess).toBeUndefined()
    expect(classify({ tool: 'Read', file_path: '/p/docs/specs/b.md' }).guess).toBeUndefined()
  })
})

describe('推測：Agent description', () => {
  test('impl 樣式', async () => {
    for (const d of ['M48 T3 add parser', 'T2 wire model', 'Implement T4 view', 'Bank A: split']) {
      expect(classify({ tool: 'Agent', description: d }).guess).toBe('impl')
    }
  })
  test('review 樣式', async () => {
    for (const d of ['Review M48 T3', 'Review T2 diff', 'fresh review of branch', 'Final whole-branch review', 'Independent review']) {
      expect(classify({ tool: 'Agent', description: d }).guess).toBe('review')
    }
  })
  test('codex-rescue 帶審查字眼 → review，否則 debug badge', async () => {
    expect(classify({ tool: 'Agent', subagent_type: 'codex:codex-rescue', description: 'codex 審查 T3' }).guess).toBe('review')
    const dbg = classify({ tool: 'Agent', subagent_type: 'codex:codex-rescue', description: 'diagnose crash' })
    expect(dbg.guess).toBeUndefined()
    expect(dbg.badge).toBe('debug')
  })
  test('反例：一般描述不推測', async () => {
    expect(classify({ tool: 'Agent', description: 'Explore codebase' }).guess).toBeUndefined()
    expect(classify({ tool: 'Agent', description: 'Tidy T-shirt copy' }).guess).toBeUndefined()
  })
})

describe('推測：主迴圈 Bash', () => {
  test('verify 指令', async () => {
    for (const c of ['xcodebuild test -scheme A', 'xcodebuild test-without-building', 'xcodebuild build-for-testing -x', 'xcrun simctl boot X', 'swiftlint', 'scripts/check-lint.sh', './check-warnings']) {
      expect(classify({ tool: 'Bash', command: c }).guess).toBe('verify')
    }
  })
  test('tf 指令', async () => {
    for (const c of ['asc builds upload x.ipa', 'asc publish testflight', 'asc xcode archive', 'agvtool next-version -all']) {
      expect(classify({ tool: 'Bash', command: c }).guess).toBe('tf')
    }
  })
  test('submit 指令並標記已送出', async () => {
    const c = classify({ tool: 'Bash', command: 'asc submit --version 1.2' })
    expect(c.guess).toBe('submit')
    expect(c.submitted).toBe(true)
    expect(classify({ tool: 'Bash', command: 'asc review status' }).guess).toBe('submit')
  })
  test('反例：xcodebuild build 與一般指令不推測', async () => {
    expect(classify({ tool: 'Bash', command: 'xcodebuild build -scheme A' }).guess).toBeUndefined()
    expect(classify({ tool: 'Bash', command: 'echo hi' }).guess).toBeUndefined()
  })
  test('subagent 內的 xcodebuild test 不改階段', async () => {
    expect(classify({ tool: 'Bash', command: 'xcodebuild test', agentId: 'a1' }).guess).toBeUndefined()
    expect(classify({ tool: 'Bash', command: 'asc builds upload', agentId: 'a1' }).guess).toBeUndefined()
  })
})

describe('badge', () => {
  test('DesignSync → design', async () => {
    expect(classify({ tool: 'DesignSync' }).badge).toBe('design')
  })
  test('mutate.sh → mutation；git merge/push → merge', async () => {
    expect(classify({ tool: 'Bash', command: 'bash scripts/mutate.sh Foo' }).badge).toBe('mutation')
    expect(classify({ tool: 'Bash', command: 'git merge --ff-only feature/x' }).badge).toBe('merge')
    expect(classify({ tool: 'Bash', command: 'git push origin main' }).badge).toBe('merge')
    expect(classify({ tool: 'Bash', command: 'git status' }).badge).toBeUndefined()
  })
  test('升級路徑驗證 → upgrade', async () => {
    expect(classify({ tool: 'Agent', description: '升級路徑驗證 1.3→1.4' }).badge).toBe('upgrade')
    expect(classify({ tool: 'Bash', command: 'scripts/upgrade-path.sh' }).badge).toBe('upgrade')
    expect(classify({ tool: 'Agent', description: 'M48 T3 add parser' }).badge).toBeUndefined()
  })
  test('Skill codex:rescue → debug', async () => {
    expect(classify({ tool: 'Skill', skill: 'codex:rescue' }).badge).toBe('debug')
  })
})

describe('標籤', () => {
  test('commandLabel 抓 xcodebuild 動作並去掉 cd 前綴', async () => {
    expect(commandLabel('cd /p && xcodebuild -scheme A test -destination x')).toBe('xcodebuild test')
    expect(commandLabel('FOO=1 sleep 90')).toBe('sleep 90')
    expect(commandLabel('echo hi')).toBe('echo hi')
    expect(commandLabel('for i in $(seq 1 150); do sleep 1; done; echo done')).toBe('for i in $(seq 1 150)')
    expect(commandLabel('while read l; do x; done')).toBe('while read l')
  })
  test('agentShortName', async () => {
    expect(agentShortName('M48 T3 add parser')).toBe('T3 impl')
    expect(agentShortName('Review M48 T2')).toBe('T2 review')
    expect(agentShortName('Bank A: split data')).toBe('Bank A')
    expect(agentShortName('Explore the whole codebase quickly')).toBe('Explore the w…')
  })
})
