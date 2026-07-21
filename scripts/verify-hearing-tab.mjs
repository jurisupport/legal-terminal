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
const dashboardCase = {
  id: 'hearing-shell-check',
  caseNumber: '2026가단12345',
  caseName: '손해배상',
  court: '서울중앙지방법원',
  division: '민사1단독',
  caseType: 'civil',
  status: 'active',
  parties: [
    { role: 'client', position: '원고', party: { name: '홍길동', type: 'person' } },
    { role: 'opponent', position: '피고', party: { name: '김철수', type: 'person' } }
  ],
  hearings: [
    {
      type: 'hearing',
      dateTime: '2026-07-16T14:00:00+09:00',
      location: '301호',
      note: '변론기일'
    }
  ]
}
const dashboardDrafts = path.join(os.tmpdir(), 'legal-terminal-hearing-shell-case')

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
  await app.evaluate(({ ipcMain }, { profile, recent, dashboardCase, dashboardDrafts }) => {
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, handler)
    }
    replace('settings:get', () => ({ sshProfiles: [profile] }))
    replace('case:history', () => [recent])
    replace('case:addHistory', () => [recent])
    replace('sessions:list', () => [])
    replace('sessions:byCase', () => ({}))
    replace('sessions:byFolder', () => [])
    replace('js:tokenStatus', () => 'ok')
    replace('js:listCases', () => ({ ok: true, cases: [dashboardCase] }))
    replace('js:getCase', async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      return { ok: true, case: { ...dashboardCase, memo: '웹에서 늦게 도착한 상세 정보' } }
    })
    replace('case:getJsPairing', () => ({ drafts: dashboardDrafts }))
    replace('case:setJsPairing', () => undefined)
    replace('fs:list', () => [])
    replace('fs:stat', async (_event, targetPath) => {
      if (String(targetPath).startsWith('ssh://')) {
        await new Promise((resolve) => setTimeout(resolve, 3_000))
      }
      if (String(targetPath).startsWith(dashboardDrafts) && String(targetPath).endsWith('.hearing.json')) {
        return { ok: true, isDir: false, size: 512, mtimeMs: Date.now() }
      }
      return { ok: false, error: 'missing' }
    })
    replace('fs:readText', () => {
      const text = JSON.stringify({
        version: 1,
        id: 'saved-hearing',
        case: { caseNumber: dashboardCase.caseNumber, caseName: dashboardCase.caseName },
        speakers: [
          { id: 'court', label: '재판부', role: 'court' },
          { id: 'plaintiff', label: '원고', role: 'plaintiff' },
          { id: 'defendant', label: '피고', role: 'defendant' }
        ],
        activeSpeakerId: 'court',
        requests: [],
        entries: [
          {
            id: 'saved-entry',
            speakerId: 'court',
            text: '기존 기록',
            createdAt: '2026-07-16T04:00:00.000Z'
          }
        ],
        result: { nextActions: [] },
        createdAt: '2026-07-16T04:00:00.000Z',
        updatedAt: '2026-07-16T04:01:00.000Z'
      })
      return { ext: '.json', kind: 'text', text, size: text.length }
    })
    replace('fs:mkdir', (_event, payload) => ({
      ok: true,
      path: `${payload.dir}/${payload.name}`
    }))
    globalThis.__hearingWrites = []
    replace('fs:writeText', (_event, payload) => {
      globalThis.__hearingWrites.push(payload)
      return { ok: true }
    })
  }, { profile, recent, dashboardCase, dashboardDrafts })
  await page.reload()

  await page.locator('.activity-item[title*="새 사건 추가"]').click()
  await page.locator('.new-case-row', { hasText: '사건 목록' }).click()
  const card = page.locator('.case-card', { hasText: dashboardCase.caseNumber })
  await card.waitFor({ state: 'visible' })
  await card.click({ button: 'right' })
  const shellStart = Date.now()
  await page.locator('.ctx-item', { hasText: '기일 기록 시작' }).click()

  const shellPanel = page.locator('.hearing-panel')
  await shellPanel.waitFor({ state: 'visible', timeout: 2_000 })
  assert.ok(Date.now() - shellStart < 2_500, '기일 기록 꾸러미는 웹 상세 조회 전에 열려야 한다')

  const urgentMemo = '재판부가 석명을 요구함'
  await shellPanel.locator('.hearing-composer textarea').fill(urgentMemo)
  await shellPanel.locator('.hearing-composer .hearing-primary-btn', { hasText: '입력' }).click()
  await shellPanel.locator('.hearing-message-bubble', { hasText: urgentMemo }).waitFor()
  await page.waitForTimeout(4_500)
  await shellPanel.locator('.hearing-message-bubble', { hasText: urgentMemo }).waitFor()
  await shellPanel.locator('.hearing-message-bubble', { hasText: '기존 기록' }).waitFor()
  const writes = await app.evaluate(() => globalThis.__hearingWrites ?? [])
  assert.ok(
    writes.some((write) => String(write.content).includes(urgentMemo)),
    '웹 조회 중 입력한 메모는 기존 기록과 합쳐져 저장되어야 한다'
  )
  console.log('hearing shell opens before web detail and preserves urgent input')

  const savedEntry = shellPanel.locator('.hearing-message', { hasText: '기존 기록' })
  await savedEntry.locator('select[aria-label="발화자 수정"]').selectOption('plaintiff')
  await page.waitForTimeout(1_100)
  await savedEntry.waitFor({ state: 'visible' })
  assert.ok(await savedEntry.evaluate((message) => message.classList.contains('speaker-plaintiff')))
  const speakerWrites = await app.evaluate(() => globalThis.__hearingWrites ?? [])
  const savedSpeaker = speakerWrites
    .map((write) => JSON.parse(write.content))
    .flatMap((record) => record.entries)
    .findLast((entry) => entry.id === 'saved-entry')?.speakerId
  assert.equal(savedSpeaker, 'plaintiff', '수정한 발화자는 기일기록에 저장되어야 한다')
  console.log('saved hearing entry speaker can be changed')

  const composer = shellPanel.locator('.hearing-composer textarea')
  const submit = shellPanel.locator('.hearing-composer .hearing-primary-btn', { hasText: '입력' })
  for (let index = 1; index <= 16; index += 1) {
    await composer.fill(`연속 발언 ${index}`)
    await submit.click()
  }
  const latestMessage = shellPanel.locator('.hearing-message').last()
  await latestMessage.waitFor()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const scrollMetrics = await shellPanel.locator('.hearing-body').evaluate((body) => {
    const message = body.querySelector('.hearing-message:last-child')
    if (!message) return null
    const bodyRect = body.getBoundingClientRect()
    const messageRect = message.getBoundingClientRect()
    return {
      scrollTop: body.scrollTop,
      bodyTop: bodyRect.top,
      bodyBottom: bodyRect.bottom,
      messageTop: messageRect.top,
      messageBottom: messageRect.bottom
    }
  })
  assert.ok(
    scrollMetrics &&
      scrollMetrics.scrollTop > 0 &&
      scrollMetrics.messageBottom <= scrollMetrics.bodyBottom + 1 &&
      scrollMetrics.messageTop >= scrollMetrics.bodyTop - 1,
    `새 발언이 쌓이면 기일기록 스크롤이 마지막 발언을 따라가야 한다: ${JSON.stringify(scrollMetrics)}`
  )
  console.log('hearing record follows the latest statement')

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
