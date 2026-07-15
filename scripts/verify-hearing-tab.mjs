import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

if (process.platform !== 'darwin') {
  console.log('remote hearing tab check skipped: macOS only')
  process.exit(0)
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const userData = path.join(os.tmpdir(), 'legal-terminal-hearing-tab-check')
const profile = {
  id: 'hearing-tab-check',
  label: '원격 회귀',
  host: 'example.invalid',
  user: 'tester'
}
const recent = {
  drafts: `ssh://${profile.id}/Users/tester/cases/sample`,
  name: '원격 회귀',
  ts: Date.now()
}

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
  await app.evaluate(({ ipcMain }, { profile, recent }) => {
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, handler)
    }
    replace('settings:get', () => ({ sshProfiles: [profile] }))
    replace('case:history', () => [recent])
    replace('case:addHistory', () => [recent])
    replace('sessions:list', () => [])
    replace('fs:list', () => [])
    replace('fs:stat', async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      return { ok: false, error: 'missing' }
    })
  }, { profile, recent })
  await page.reload()

  await page.locator('.activity-item[title*="새 사건 추가"]').click()
  await page.locator('.new-case-recent-row', { hasText: recent.name }).click()
  const menu = page.locator('[data-work-side="right"] .tab-menu-trigger', {
    has: page.locator('text=▾')
  })
  await menu.click()
  const start = Date.now()
  await page
    .locator('[data-work-side="right"] .tab-menu-item[title="현재 사건의 기일 진행사항 기록"]')
    .click({ force: true })

  const panel = page.locator('.hearing-panel')
  await panel.waitFor({ state: 'visible', timeout: 2_000 })
  assert.ok(Date.now() - start < 2_500, '원격 탭은 SSH 조회를 기다리지 않고 열려야 한다')
  assert.match(await panel.locator('.hearing-title').textContent(), /기일기록/)
  console.log('remote hearing tab opens without waiting for SSH')
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await app.close().catch(() => {})
  await fs.rm(userData, { recursive: true, force: true })
}
