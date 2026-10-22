import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('background sync check skipped: macOS only')
  process.exit(0)
}

const { _electron } = await import(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'legal-terminal-sync-background-'))
const profile = {
  id: 'sync-background-check', label: 'OneDrive 회귀', host: 'example.invalid', user: 'tester',
  draftsRoot: '/Users/tester/Library/CloudStorage/OneDrive-개인/case'
}
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const app = await _electron.launch({
  executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [`--user-data-dir=${userData}`, repo], env
})

try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(8_000)
  await app.evaluate(({ ipcMain }, profile) => {
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, handler)
    }
    globalThis.__syncSettings = { sshProfiles: [profile] }
    globalThis.__syncRequests = []
    globalThis.__syncCancelCount = 0
    globalThis.__syncCacheClears = 0
    const recent = [{ drafts: `ssh://${profile.id}${profile.draftsRoot}`, name: '동기화 회귀 사건', ts: Date.now() }]
    replace('settings:get', () => globalThis.__syncSettings)
    replace('settings:set', (_event, patch) => Object.assign(globalThis.__syncSettings, patch))
    replace('case:history', () => recent)
    replace('case:addHistory', () => recent)
    replace('sessions:list', () => [])
    replace('sessions:byCase', () => ({}))
    replace('sessions:byFolder', () => [])
    replace('js:tokenStatus', () => 'missing')
    replace('dictation:keyStatus', () => 'missing')
    replace('workspace:autoLoad', () => ({ ok: true }))
    replace('workspace:autoSave', () => ({ ok: true }))
    replace('fs:list', () => [])
    replace('fs:stat', () => ({ ok: false, error: 'missing' }))
    replace('fs:writeText', () => ({ ok: true }))
    replace('ssh:listDir', (_event, payload) => ({ ok: true, cwd: payload.path, entries: [] }))
    replace('ssh:clearDirCache', () => { globalThis.__syncCacheClears++; return { ok: true } })
    replace('sync:remoteInfo', () => ({ installed: true, remotes: ['onedrive:'] }))
    replace('sync:run', (event, opts) => new Promise((resolve, reject) => {
      globalThis.__syncRequests.push({ opts, resolve, reject, sender: event.sender })
      event.sender.send('sync:progress', `mock sync #${globalThis.__syncRequests.length}`)
    }))
    ipcMain.removeAllListeners('sync:cancel')
    ipcMain.on('sync:cancel', () => {
      globalThis.__syncCancelCount++
      globalThis.__syncRequests.at(-1).resolve({ ok: false, code: null, error: '사용자가 중단했습니다.' })
    })
  }, profile)
  await page.reload()
  await page.locator('.activity-item[title="설정"]').waitFor()
  await page.keyboard.press('Meta+n')
  const documentTab = page.locator('.tab', { hasText: '새 문서 1.md' })
  const editor = page.locator('.cm-content:visible')
  await editor.fill('동기화 전 작성한 문서')

  const modal = page.locator('.sync-modal')
  const background = page.locator('.sync-background')
  const office = page.getByPlaceholder('상호 (예: 법무법인 ○○)')
  const minimize = () => modal.getByRole('button', { name: '백그라운드에서 계속', exact: true }).click()
  const restore = () => background.getByRole('button', { name: '진행 상황 보기', exact: true }).click()
  const startSync = async (mode, requestNumber) => {
    await page.locator('.activity-item[title="설정"]').click()
    if (mode === '전체') {
      await page.getByRole('button', { name: '동기화', exact: true }).click()
    } else {
      await page.locator('.ssh-card button[title="원격에서 폴더 찾기"]').first().click()
      await page.getByRole('button', { name: 'OneDrive 최신화', exact: true }).click()
    }
    await modal.getByRole('button', { name: '⬇ 내리기 (클라우드 → 맥)', exact: true }).click()
    await modal.locator('.sync-log', { hasText: `mock sync #${requestNumber}` }).waitFor()
  }
  const finish = (index, result, reject = false) => app.evaluate((_electron, { index, result, reject }) => {
    const request = globalThis.__syncRequests[index]
    if (reject) request.reject(new Error(result.error))
    else request.resolve(result)
  }, { index, result, reject })
  const focused = (input) => input.evaluate((element) => document.activeElement === element)

  await startSync('폴더명만', 1)
  await minimize()
  await background.waitFor()
  assert.equal(await page.locator('.modal-overlay:visible').count(), 0, '원격 폴더 선택창도 닫혀야 한다')
  await documentTab.click()
  await editor.fill('OneDrive 동기화 중에도 문서 작성 가능')
  assert.equal(await editor.textContent(), 'OneDrive 동기화 중에도 문서 작성 가능')
  await page.locator('.tab', { hasText: '설정' }).click()
  await office.fill('동기화 중 변경한 사무실')
  await office.press('Tab')
  assert.equal(await app.evaluate(() => globalThis.__syncSettings.officeProfile?.officeName), '동기화 중 변경한 사무실')
  await office.focus()
  await page.screenshot({ path: '/tmp/legal-terminal-sync-background.png' })
  console.log('running OneDrive sync permits tab changes, document editing, and settings saves')

  await app.evaluate(() => globalThis.__syncRequests[0].sender.send('sync:progress', '백그라운드 진행 로그'))
  await page.locator('.ssh-card button[title="원격에서 폴더 찾기"]').first().click()
  await page.getByRole('button', { name: 'OneDrive 최신화', exact: true }).click()
  await modal.locator('.sync-log', { hasText: '백그라운드 진행 로그' }).waitFor()
  assert.equal(await app.evaluate(() => globalThis.__syncRequests.length), 1, '다시 열어도 실행 중인 작업을 교체하거나 중복 실행하면 안 된다')
  await minimize()
  await office.focus()
  await finish(0, { ok: true, code: 0 })
  await background.locator('.sync-spinner').waitFor({ state: 'hidden' })
  assert.equal(await modal.isVisible(), false)
  assert.equal(await focused(office), true, '완료가 다른 탭의 입력 포커스를 가져가면 안 된다')
  assert.equal(await app.evaluate(() => globalThis.__syncCacheClears), 1, '실행 완료 시 원격 폴더 캐시를 갱신해야 한다')
  await restore()
  await modal.getByRole('button', { name: '닫기', exact: true }).click()
  console.log('progress survives restore and completion preserves the active input')

  await page.locator('.activity-item[title*="새 사건 추가"]').click()
  await page.locator('.new-case-recent-row', { hasText: '동기화 회귀 사건' }).click()
  await startSync('전체', 2)
  await minimize()
  await office.focus()
  await finish(1, { ok: true, code: 0, changes: [{ path: '준비서면.md', action: 'copy' }] })
  await background.locator('.sync-spinner').waitFor({ state: 'hidden' })
  assert.equal(await modal.isVisible(), false)
  assert.equal(await focused(office), true)
  assert.equal(await app.evaluate(() => globalThis.__syncRequests.length), 2, '미리보기 이후 확인 없이 복사하면 안 된다')
  assert.equal(await app.evaluate(() => globalThis.__syncCacheClears), 1, '미리보기만으로 폴더 캐시를 비우면 안 된다')
  await restore()
  await modal.locator('.sync-preview', { hasText: '준비서면.md' }).waitFor()
  await modal.getByRole('button', { name: '내리기 진행', exact: true }).click()
  await modal.locator('.sync-log', { hasText: 'mock sync #3' }).waitFor()
  assert.deepEqual(await app.evaluate(() => globalThis.__syncRequests.slice(1).map(({ opts }) => !!opts.dryRun)), [true, false])
  await minimize()
  await office.focus()
  await finish(2, { ok: false, code: 1, error: '회귀 테스트 연결 실패' }, true)
  await background.locator('.sync-spinner').waitFor({ state: 'hidden' })
  assert.equal(await focused(office), true)
  assert.equal(await modal.isVisible(), false)
  await restore()
  await modal.locator('.sync-log', { hasText: '회귀 테스트 연결 실패' }).waitFor()
  await modal.getByRole('button', { name: '닫기', exact: true }).click()
  console.log('background preview waits for confirmation and errors preserve input and logs')

  await startSync('폴더명만', 4)
  await minimize()
  await background.getByRole('button', { name: '중단', exact: true }).click()
  await background.locator('.sync-spinner').waitFor({ state: 'hidden' })
  assert.equal(await app.evaluate(() => globalThis.__syncCancelCount), 1)
  assert.equal(await app.evaluate(() => globalThis.__syncCacheClears), 3, '실패하거나 중단된 실행도 변경된 폴더를 다시 읽어야 한다')
  await restore()
  await modal.locator('.sync-log', { hasText: '사용자가 중단했습니다.' }).waitFor()
  console.log('background sync can be cancelled')
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await app.close().catch(() => {})
  await fs.rm(userData, { recursive: true, force: true })
}
