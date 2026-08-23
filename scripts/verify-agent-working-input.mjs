import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

if (process.platform !== 'darwin') {
  console.log('agent working-input check skipped: macOS only')
  process.exit(0)
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const userData = path.join(os.tmpdir(), 'legal-terminal-agent-working-input-check')
await fs.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const app = await _electron.launch({
  executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [`--user-data-dir=${userData}`, repo],
  env
})

try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(8_000)
  await app.evaluate(({ dialog, ipcMain }, { repo }) => {
    dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false })
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, handler)
    }
    replace('dialog:pickFolder', () => ({ path: repo, name: '입력 회귀' }))
    replace('agent:create', () => ({ ok: true }))
    replace('agent:models', () => ({ ok: true, models: [] }))
    replace('agent:send', (event, payload) => {
      const sessionId = payload.sessionId
      event.sender.send('agent:event', {
        type: 'message:user',
        sessionId,
        messageId: 'working-input-user',
        text: payload.input.text
      })
      event.sender.send('agent:event', { type: 'status', sessionId, status: 'working' })
      event.sender.send('agent:event', {
        type: 'message:assistant_start',
        sessionId,
        messageId: 'working-input-assistant'
      })
      globalThis.__workingInputSender = event.sender
      globalThis.__workingInputSessionId = sessionId
      return { ok: true }
    })
  }, { repo })

  await page.locator('.activity-item[title*="새 사건 추가"]').click()
  await page.locator('.new-case-row', { hasText: '작성서류 폴더' }).click()
  const local = page.locator('.modal.conn-menu button.conn-row', { hasText: '이 컴퓨터' })
  if (await local.isVisible({ timeout: 2_000 }).catch(() => false)) await local.click()
  const startFresh = page.locator('button', { hasText: '새로 시작' })
  if (await startFresh.isVisible({ timeout: 2_000 }).catch(() => false)) await startFresh.click()
  const openAgent = page.locator('button', { hasText: '이 사건에서 Agent 열기' })
  if (await openAgent.isVisible({ timeout: 2_000 }).catch(() => false)) await openAgent.click()
  const composer = page.locator('.agent-composer textarea')
  await composer.waitFor({ state: 'visible' })
  await composer.fill('첫 요청')
  await composer.press('Enter')
  await page.locator('.agent-status-line.working').waitFor()

  await app.evaluate(() => {
    const sender = globalThis.__workingInputSender
    const sessionId = globalThis.__workingInputSessionId
    let index = 0
    globalThis.__workingInputTimer = setInterval(() => {
      sender?.send('agent:event', {
        type: 'message:assistant_delta',
        sessionId,
        messageId: 'working-input-assistant',
        text: `출력 ${index++} `
      })
    }, 1)
  })

  const followUp = '작업 중에도 후속 지시를 입력하고 수정할 수 있어야 합니다.'
  await composer.click()
  await page.keyboard.type(followUp, { delay: 1 })
  await page.waitForTimeout(300)
  assert.equal(await composer.inputValue(), followUp)
  assert.equal(await composer.isEditable(), true)
  assert.equal(await composer.evaluate((textarea) => document.activeElement === textarea), true)

  await app.evaluate(() => {
    globalThis.__workingInputSender?.send('agent:event', {
      type: 'message:assistant_delta',
      sessionId: globalThis.__workingInputSessionId,
      messageId: 'working-input-assistant',
      text: '준비 '.repeat(2_000)
    })
  })
  await page.waitForTimeout(100)
  await page.locator('.agent-timeline').evaluate((timeline) => {
    if (timeline.scrollHeight <= timeline.clientHeight) throw new Error('timeline did not overflow')
    timeline.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    timeline.scrollTop = 0
    timeline.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await app.evaluate(() => {
    clearInterval(globalThis.__workingInputTimer)
    const sender = globalThis.__workingInputSender
    const sessionId = globalThis.__workingInputSessionId
    sender?.send('agent:event', {
      type: 'message:assistant_done',
      sessionId,
      messageId: 'working-input-assistant'
    })
    sender?.send('agent:event', {
      type: 'tool:start',
      sessionId,
      toolId: 'working-input-tool',
      name: 'Bash'
    })
    sender?.send('agent:event', {
      type: 'tool:done',
      sessionId,
      toolId: 'working-input-tool',
      outputPreview: 'done'
    })
    let index = 0
    globalThis.__workingInputTimer = setInterval(() => {
      sender?.send('agent:event', {
        type: 'message:assistant_delta',
        sessionId,
        messageId: 'working-input-assistant',
        text: `재개 ${index++} `
      })
    }, 1)
  })
  await page.waitForTimeout(1_500)
  assert.equal(await page.locator('.agent-panel').isVisible(), true)
  console.log('agent stream remains usable after tool output while the timeline is scrolled')
} finally {
  await app.evaluate(() => clearInterval(globalThis.__workingInputTimer)).catch(() => {})
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await fs.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
}
