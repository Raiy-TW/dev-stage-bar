import { test, expect } from 'claude-code/testing'
import { displayWidth, truncateToWidth } from '../src/width.ts'

test('displayWidth: ASCII 每字 1 欄', async () => {
  expect(displayWidth('M48 4/9')).toBe(7)
  expect(displayWidth('')).toBe(0)
})

test('displayWidth: 中文與全形 2 欄', async () => {
  expect(displayWidth('需求')).toBe(4)
  expect(displayWidth('驗證 · 42m')).toBe(4 + 1 + 1 + 1 + 3)
  expect(displayWidth('（')).toBe(2)
})

test('displayWidth: emoji 2 欄、框線與方塊 1 欄、⚠ ⏸ 視為 1 欄', async () => {
  expect(displayWidth('🔄')).toBe(2)
  expect(displayWidth('━─▰▱')).toBe(4)
  expect(displayWidth('⚠')).toBe(1)
  expect(displayWidth('⏸')).toBe(1)
})

test('displayWidth: 變體選擇符與組合字元 0 欄', async () => {
  expect(displayWidth('⚠️')).toBe(1)
  expect(displayWidth('é')).toBe(1)
})

test('truncateToWidth: 不切半個中文字，超過加 …', async () => {
  expect(truncateToWidth('abc', 5)).toBe('abc')
  expect(truncateToWidth('需求規格拆解', 7)).toBe('需求規…')
  expect(displayWidth(truncateToWidth('需求規格拆解', 7))).toBeLessThanOrEqual(7)
  expect(truncateToWidth('abcdef', 4)).toBe('abc…')
})
