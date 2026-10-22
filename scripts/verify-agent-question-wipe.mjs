import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { _electron } = require('playwright-core')

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appPath = process.env.LT_VERIFY_APP ?? repo
const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'legal-terminal-question-wipe-'))
const caseDir = path.join(userData, 'case')
const screenshots = path.join(repo, 'output/playwright/agent-question-wipe')
await fs.mkdir(caseDir)
await fs.mkdir(screenshots, { recursive: true })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const app = await _electron.launch({
  executablePath: require('electron'),
  args: [`--user-data-dir=${userData}`, appPath],
  env
})

const page = await app.firstWindow()
try {
  page.setDefaultTimeout(8_000)
  await app.evaluate(({ ipcMain, BrowserWindow }, { caseDir }) => {
    BrowserWindow.getAllWindows()[0].setSize(1500, 900)
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, handler)
    }
    replace('dialog:pickFolder', () => ({ path: caseDir, name: '질문 스크롤 검사' }))
    replace('js:tokenStatus', () => 'ok')
    replace('js:listCases', () => ({ ok: true, cases: [] }))
    replace('agent:create', () => ({ ok: true }))
    replace('agent:models', () => ({ ok: true, models: [] }))
    replace('agent:send', (event, payload) => {
      const send = (message) => event.sender.send('agent:event', { sessionId: payload.sessionId, ...message })
      globalThis.__wipeSend = send
      send({ type: 'message:assistant_delta', messageId: 'intro', text: '질문 전 안내입니다.' })
      send({ type: 'message:assistant_done', messageId: 'intro' })
      for (let index = 0; index < 3; index++) {
        send({
          type: 'message:user', messageId: `user-${index}`,
          text: index === 0 ? '이전 질문의 긴 내용입니다.\n'.repeat(8) : `${index + 1}번째 짧은 질문`,
          ...(index === 1 ? { quote: { messageId: 'answer-0', preview: '첫 답변에서 인용한 내용' } } : {})
        })
        send({
          type: 'message:assistant_delta', messageId: `answer-${index}`,
          text: Array.from({ length: 45 }, (_, line) => `${index + 1}번째 답변 ${line + 1} 문단입니다.`).join('\n\n')
        })
        send({ type: 'message:assistant_done', messageId: `answer-${index}` })
      }
      send({ type: 'status', status: 'done' })
      return { ok: true }
    })
  }, { caseDir })

  await page.locator('.activity-item[title*="새 사건 추가"]').click()
  await page.locator('.new-case-row', { hasText: '작성서류 폴더' }).click()
  const local = page.locator('.modal.conn-menu button.conn-row', { hasText: '이 컴퓨터' })
  if (await local.isVisible()) await local.click()
  const startFresh = page.getByRole('button', { name: '새로 시작', exact: true })
  if (await startFresh.isVisible()) await startFresh.click()
  await page.locator('button', { hasText: '이 사건에서 Agent 열기' }).click()
  const composer = page.locator('.agent-composer textarea')
  await composer.fill('질문 스크롤 검사')
  await composer.press('Enter')
  const questions = page.locator('.agent-msg.user')
  await questions.nth(2).waitFor()
  await questions.first().locator('.agent-user-question-toggle').click()

  const scrollToQuestion = async (index, offset = 100) => {
    await page.locator('.agent-timeline').evaluate((timeline, { index, offset }) => {
      timeline.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
      timeline.scrollTop = 0
      const question = timeline.querySelectorAll('.agent-msg.user')[index]
      timeline.scrollTop = question.getBoundingClientRect().top - timeline.getBoundingClientRect().top + offset
      timeline.dispatchEvent(new Event('scroll', { bubbles: true }))
    }, { index, offset })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  const checkWipe = async (index) => {
    const geometry = await page.locator('.agent-timeline').evaluate((timeline, index) => {
      const questions = [...timeline.querySelectorAll('.agent-msg.user')]
      return {
        top: timeline.getBoundingClientRect().top + parseFloat(getComputedStyle(timeline).paddingTop),
        clipTop: timeline.getBoundingClientRect().top,
        current: questions[index].getBoundingClientRect().top,
        previousBottoms: questions.slice(0, index).map((question) => question.getBoundingClientRect().bottom)
      }
    }, index)
    assert.ok(Math.abs(geometry.current - geometry.top) <= 1, `the current question must stay pinned: ${JSON.stringify(geometry)}`)
    assert.ok(geometry.previousBottoms.every((bottom) => bottom <= geometry.clipTop + 1),
      `older questions must leave the viewport: ${JSON.stringify(geometry)}`)
  }

  await scrollToQuestion(2)
  await page.locator('.agent-timeline-wrap').screenshot({ path: path.join(screenshots, 'latest.png') })
  assert.ok((await questions.first().boundingBox()).height > (await questions.nth(2).boundingBox()).height)
  await checkWipe(2)

  // Reverse scrolling restores the applicable question, including its quote.
  await scrollToQuestion(1)
  await checkWipe(1)
  await scrollToQuestion(1, -50)
  await page.locator('.agent-timeline-wrap').screenshot({ path: path.join(screenshots, 'transition.png') })
  const previous = await questions.first().boundingBox()
  const next = await questions.nth(1).boundingBox()
  assert.ok(previous.y + previous.height <= next.y, 'the next question must push the previous question upward')
  await scrollToQuestion(0)
  await checkWipe(0)
  assert.equal(await questions.first().locator('details').getAttribute('open'), '')

  // Resizing and appending output must preserve the short pinned question.
  const wideWidth = (await page.locator('.agent-timeline').boundingBox()).width
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
  await page.waitForFunction((width) => document.querySelector('.agent-timeline').clientWidth < width, wideWidth)
  await scrollToQuestion(2)
  await app.evaluate(() => {
    globalThis.__wipeSend({ type: 'message:assistant_delta', messageId: 'answer-2', text: '\n\n추가 생성 문장입니다.'.repeat(30) })
  })
  await page.waitForFunction(() => [...document.querySelectorAll('.agent-msg.assistant')].at(-1)?.textContent.includes('추가 생성 문장'))
  await checkWipe(2)
  await page.locator('.agent-timeline-wrap').screenshot({ path: path.join(screenshots, 'narrow-streaming.png') })
  console.log(`short questions wipe taller previous questions; reverse scroll, resize and streaming pass (${appPath})`)
} catch (error) {
  await page.screenshot({ path: path.join(screenshots, 'failure.png') })
  throw error
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await fs.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
}
