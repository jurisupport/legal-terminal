import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

if (process.platform !== 'darwin') {
  console.log('slash command palette check skipped: macOS only')
  process.exit(0)
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const userData = path.join(os.tmpdir(), 'legal-terminal-slash-command-check')
await fs.rm(userData, { recursive: true, force: true })

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const app = await _electron.launch({
  executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [`--user-data-dir=${userData}`, repo],
  env
})

try {
  const page = await app.firstWindow()
  await page.locator('.welcome').waitFor()
  await page.locator('.welcome').click()
  await page.keyboard.press('/')

  const palette = page.locator('.slash-palette')
  const search = palette.locator('input')
  await palette.waitFor()
  assert.equal(await search.evaluate((input) => document.activeElement === input), true)
  assert.ok(await palette.locator('.slash-palette-row').count() >= 8)

  await page.keyboard.press('ArrowDown')
  assert.equal(await palette.locator('.slash-palette-row.active').count(), 1)
  await search.fill('설정')
  assert.equal(await palette.locator('.slash-palette-row').count(), 1)
  await page.keyboard.press('Enter')
  await page.locator('.settings').waitFor()
  await palette.waitFor({ state: 'hidden' })

  const officeName = page.locator('.setting-office input').first()
  await officeName.fill('법무법인')
  await officeName.press('/')
  assert.equal(await officeName.inputValue(), '법무법인/')
  assert.equal(await palette.count(), 0)

  await page.locator('.activity-item[title*="저장된 작업환경 가져오기"]').click()
  const workspaceSearch = page.locator('.workspace-search')
  await workspaceSearch.waitFor()
  assert.equal(await workspaceSearch.evaluate((input) => document.activeElement === input), true)
  await page.keyboard.type('사건')
  assert.equal(await workspaceSearch.inputValue(), '사건')

  console.log('command and workspace searches accept keyboard input')
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await app.close().catch(() => {})
  await fs.rm(userData, { recursive: true, force: true })
}
