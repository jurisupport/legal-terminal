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
  await page.addInitScript(() => {
    class FakeMediaRecorder {
      static isTypeSupported() {
        return true
      }
      state = 'inactive'
      mimeType
      ondataavailable = null
      onstop = null
      constructor(_stream, options = {}) {
        this.mimeType = options.mimeType || 'audio/webm'
      }
      start() {
        this.state = 'recording'
      }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['fake-audio'], { type: this.mimeType }) })
        queueMicrotask(() => this.onstop?.())
      }
    }
    class FakeAudioContext {
      state = 'running'
      createAnalyser() {
        return {
          fftSize: 256,
          getByteTimeDomainData(values) {
            values.fill(128)
            values[0] = 140
          }
        }
      }
      createMediaStreamSource() {
        return { connect() {} }
      }
      close() {
        this.state = 'closed'
        return Promise.resolve()
      }
    }
    Object.defineProperty(globalThis, 'MediaRecorder', { value: FakeMediaRecorder })
    Object.defineProperty(globalThis, 'AudioContext', { value: FakeAudioContext })
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] })
      }
    })
  })
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
    replace('dictation:keyStatus', () => 'ok')
    replace('dictation:setKey', () => undefined)
    globalThis.__hearingTranscriptions = []
    replace('dictation:transcribe', (_event, payload) => new Promise((resolve, reject) => {
      globalThis.__hearingTranscriptions.push({ payload, resolve, reject })
    }))
    replace('js:listCases', () => ({ ok: true, cases: [dashboardCase] }))
    replace('js:getCase', async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      return { ok: true, case: { ...dashboardCase, memo: '웹에서 늦게 도착한 상세 정보' } }
    })
    replace('case:getJsPairing', () => ({ drafts: dashboardDrafts }))
    replace('case:setJsPairing', () => undefined)
    replace('fs:list', (_event, dir) => [...new Set(
      (globalThis.__hearingWrites ?? []).map((write) => write.path)
    )].filter((filePath) => filePath.startsWith(`${dir}/`)).map((filePath) => ({
      path: filePath, name: filePath.split('/').at(-1), isDir: false, mtimeMs: Date.now()
    })))
    replace('fs:stat', async (_event, targetPath) => {
      if (String(targetPath).startsWith('ssh://')) {
        await new Promise((resolve) => setTimeout(resolve, 3_000))
      }
      if (targetPath === `${dashboardDrafts}/.hearings`) return { ok: true, isDir: true }
      if (String(targetPath).startsWith(dashboardDrafts) && String(targetPath).endsWith('.hearing.json')) {
        return { ok: true, isDir: false, size: 512, mtimeMs: Date.now() }
      }
      return { ok: false, error: 'missing' }
    })
    replace('fs:readText', (_event, targetPath) => {
      const text = globalThis.__hearingWrites?.findLast((write) => write.path === targetPath)?.content ?? JSON.stringify({
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
    replace('fs:writeText', async (_event, payload) => {
      if (globalThis.__holdNextHearingWrite) {
        globalThis.__holdNextHearingWrite = false
        await new Promise((resolve) => { globalThis.__releaseHearingWrite = resolve })
      }
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

  await shellPanel.locator('.hearing-template-btn', { hasText: '형사' }).click()
  assert.match(
    await shellPanel.locator('select[title="화자 선택"]').textContent(),
    /검사/,
    '형사 템플릿을 선택하면 형사 화자가 표시되어야 한다'
  )
  await page.locator('.activity-item[title="설정"]').click()
  await page.locator('.setting-label', { hasText: 'OpenAI API 키' }).waitFor()
  assert.match(await page.locator('.setting-row', { has: page.locator('.setting-label', { hasText: 'OpenAI API 키' }) }).textContent(),
    /키 저장됨.*API 연결·잔액 미확인/, '키 복호화 성공을 API 연결 성공으로 표시하면 안 된다')
  await page
    .locator('[data-work-side="left"] button[title="문서를 오른쪽으로 이동"]')
    .click()
  await page.locator('[data-work-side="right"] .tab', { hasText: '기일기록' }).click()
  assert.match(
    await shellPanel.locator('select[title="화자 선택"]').textContent(),
    /검사/,
    '입력 전에 고른 템플릿은 다른 탭을 다녀와도 유지되어야 한다'
  )
  console.log('empty hearing template selection survives tab changes')

  const urgentMemo = '재판부가 석명을 요구함'
  await shellPanel.locator('.hearing-composer textarea').fill(urgentMemo)
  await shellPanel.locator('.hearing-composer .hearing-primary-btn', { hasText: '입력' }).click()
  const entryTexts = shellPanel.locator('textarea[aria-label="진행 메모 수정"]')
  await entryTexts.last().waitFor()
  assert.equal(await entryTexts.last().inputValue(), urgentMemo)
  await page.waitForTimeout(4_500)
  assert.equal(await entryTexts.last().inputValue(), urgentMemo)
  const savedEntryText = entryTexts.first()
  await savedEntryText.waitFor()
  assert.equal(await savedEntryText.inputValue(), '기존 기록')
  const writes = await app.evaluate(() => globalThis.__hearingWrites ?? [])
  assert.ok(
    writes.some((write) => String(write.content).includes(urgentMemo)),
    '웹 조회 중 입력한 메모는 기존 기록과 합쳐져 저장되어야 한다'
  )
  console.log('hearing shell opens before web detail and preserves urgent input')

  const savedEntry = savedEntryText.locator('..')
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

  const revisedSavedMemo = '수정한 기존 기록'
  await savedEntryText.fill(revisedSavedMemo)
  await page.waitForTimeout(1_100)
  const textWrites = await app.evaluate(() => globalThis.__hearingWrites ?? [])
  const savedText = textWrites
    .map((write) => JSON.parse(write.content))
    .flatMap((record) => record.entries)
    .findLast((entry) => entry.id === 'saved-entry')?.text
  assert.equal(savedText, revisedSavedMemo, '수정한 진행 메모 본문은 기일기록에 저장되어야 한다')
  console.log('saved hearing entry text can be changed')

  const composer = shellPanel.locator('.hearing-composer textarea')
  const submit = shellPanel.locator('.hearing-composer .hearing-primary-btn', { hasText: '입력' })
  const dictationButton = shellPanel.locator('.hearing-dictation-btn')
  const speakerPicker = shellPanel.locator('select[title="화자 선택"]')
  const messages = shellPanel.locator('.hearing-message')
  const entryCountBeforeDictation = await messages.count()
  const resolveDictation = (index, result) => app.evaluate(async (_electron, { index, result }) => {
    const deadline = Date.now() + 5_000
    while (!globalThis.__hearingTranscriptions[index] && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const request = globalThis.__hearingTranscriptions[index]
    if (!request) throw new Error(`Dictation request ${index} did not arrive`)
    if (result.rejection) request.reject(new Error(result.rejection))
    else request.resolve(result)
    return request.payload.context
  }, { index, result })

  await speakerPicker.selectOption('court')
  await composer.fill('앞 뒤')
  await composer.evaluate((input) => input.setSelectionRange(2, 2))
  await dictationButton.click()
  await shellPanel.locator('.hearing-dictation-btn.recording').waitFor()
  assert.equal(await dictationButton.textContent(), '... 00:00')
  const recordingColor = await dictationButton.evaluate((button) => getComputedStyle(button).color)
  const [red, green, blue] = recordingColor.match(/\d+/g).map(Number)
  assert.ok(green > red && green > blue, `녹음 중 표시는 녹색이어야 한다: ${recordingColor}`)
  await dictationButton.click()
  const firstDictation = messages.nth(entryCountBeforeDictation)
  const firstStatus = firstDictation.locator('.hearing-dictation-status[role="status"]')
  await firstStatus.waitFor()
  assert.equal(await firstStatus.textContent(), '전사 중...')
  assert.equal(await firstDictation.locator('textarea').inputValue(), '앞 뒤')
  assert.equal(await composer.inputValue(), '', '녹음 정지 직후 기존 초안은 대화목록으로 옮겨져야 한다')
  assert.ok(await composer.isEnabled(), '전사 중에도 새 메모를 입력할 수 있어야 한다')
  assert.ok(await submit.isEnabled(), '전사 중에도 새 메모를 제출할 수 있어야 한다')
  assert.ok(await dictationButton.isEnabled(), '전사 중에도 다음 녹음을 시작할 수 있어야 한다')
  assert.ok(await firstDictation.locator('textarea').isDisabled(), '전사 중인 원본 초안은 수정할 수 없어야 한다')
  await composer.press('ArrowUp')
  assert.equal(await messages.count(), entryCountBeforeDictation + 1, '위쪽 방향키가 전사 대기 행을 제거하면 안 된다')
  assert.equal(await firstDictation.locator('textarea').inputValue(), '앞 뒤')
  assert.equal(await composer.inputValue(), '')

  await speakerPicker.selectOption('prosecutor')
  await composer.fill('전사 대기 중 직접 입력')
  await submit.click()
  assert.equal(await messages.last().locator('textarea').inputValue(), '전사 대기 중 직접 입력')
  await composer.fill('두 번째 초안')
  await dictationButton.click()
  await shellPanel.locator('.hearing-dictation-btn.recording').waitFor()
  await page.screenshot({ path: '/tmp/legal-terminal-dictation-check.png' })
  const firstContext = await resolveDictation(0, { ok: true, text: '가운데', corrected: true })
  await page.waitForFunction(
    (index) => document.querySelectorAll('.hearing-message textarea')[index]?.value === '앞 가운데 뒤',
    entryCountBeforeDictation
  )
  assert.equal(firstContext.speaker, '재판부', '전사 요청은 정지 당시 화자를 사용해야 한다')
  assert.equal(await firstDictation.locator('select').inputValue(), 'court')
  assert.equal(await composer.inputValue(), '두 번째 초안', '완료된 전사는 새 초안을 덮어쓰면 안 된다')
  assert.equal(await dictationButton.getAttribute('aria-label'), '녹음 정지')
  assert.ok(await dictationButton.evaluate((button) => button.classList.contains('recording')),
    '이전 전사가 완료되어도 다음 녹음은 계속되어야 한다')
  console.log('hearing dictation moves progress to a row and keeps new input and recording available')

  await dictationButton.click()
  const secondDictation = messages.nth(entryCountBeforeDictation + 2)
  await secondDictation.locator('.hearing-dictation-status[role="status"]').waitFor()
  await speakerPicker.selectOption('court')
  await dictationButton.click()
  await shellPanel.locator('.hearing-dictation-btn.recording').waitFor()
  await dictationButton.click()
  const thirdDictation = messages.nth(entryCountBeforeDictation + 3)
  await thirdDictation.locator('.hearing-dictation-status[role="status"]').waitFor()
  await composer.fill('새로 작성 중인 메모')
  await resolveDictation(2, { ok: true, text: '세 번째 발언', corrected: false })
  await page.waitForFunction(
    (index) => document.querySelectorAll('.hearing-message textarea')[index]?.value === '세 번째 발언',
    entryCountBeforeDictation + 3
  )
  assert.equal(await secondDictation.locator('.hearing-dictation-status').textContent(), '전사 중...')
  await resolveDictation(1, { ok: true, text: '두 번째 발언', corrected: false })
  await page.waitForFunction(
    (index) => document.querySelectorAll('.hearing-message textarea')[index]?.value === '두 번째 초안 두 번째 발언',
    entryCountBeforeDictation + 2
  )
  assert.equal(await secondDictation.locator('select').inputValue(), 'prosecutor')
  assert.equal(await thirdDictation.locator('select').inputValue(), 'court')
  assert.deepEqual(
    await messages.locator('textarea').evaluateAll((inputs) => inputs.map((input) => input.value)),
    [revisedSavedMemo, urgentMemo, '앞 가운데 뒤', '전사 대기 중 직접 입력', '두 번째 초안 두 번째 발언', '세 번째 발언'],
    '전사가 역순으로 완료되어도 발언 순서는 녹음 정지 순서를 유지해야 한다'
  )
  assert.equal(await composer.inputValue(), '새로 작성 중인 메모')
  await page.waitForTimeout(1_100)
  const dictationWrites = await app.evaluate(() => globalThis.__hearingWrites ?? [])
  const savedDictations = JSON.parse(dictationWrites.at(-1).content).entries
  assert.deepEqual(savedDictations.slice(entryCountBeforeDictation).map((entry) => entry.text), [
    '앞 가운데 뒤', '전사 대기 중 직접 입력', '두 번째 초안 두 번째 발언', '세 번째 발언'
  ], '완료된 전사 결과와 발언 순서는 자동 저장되어야 한다')
  assert.ok(savedDictations.every((entry) => !entry.dictation), '완료된 전사는 대기 상태로 저장되면 안 된다')
  console.log('hearing dictation resolves out of order without changing row order, speakers, or new drafts')

  await dictationButton.click()
  await shellPanel.locator('.hearing-dictation-btn.recording').waitFor()
  await dictationButton.click()
  const failedDictation = messages.last()
  await failedDictation.locator('.hearing-dictation-status[role="status"]').waitFor()
  await composer.fill('실패 후에도 새 입력')
  await resolveDictation(3, { ok: false, error: '전사 연결 실패' })
  await page.waitForFunction(() =>
    document.querySelector('.hearing-message:last-child .hearing-dictation-status')?.textContent?.includes('전사 연결 실패')
  )
  assert.equal(await failedDictation.locator('textarea').inputValue(), '새로 작성 중인 메모')
  assert.equal(await composer.inputValue(), '실패 후에도 새 입력')
  assert.ok(await composer.isEnabled())
  assert.ok(await dictationButton.isEnabled())
  assert.ok(await submit.isEnabled())
  await submit.click()
  assert.equal(await messages.last().locator('textarea').inputValue(), '실패 후에도 새 입력')
  assert.equal(await messages.locator('.hearing-dictation-status', { hasText: '전사 연결 실패' }).count(), 1)
  console.log('hearing dictation failure stays with its row and allows more input')

  await dictationButton.click()
  await shellPanel.locator('.hearing-dictation-btn.recording').waitFor()
  await dictationButton.click()
  await messages.last().locator('.hearing-dictation-status[role="status"]').waitFor()
  await resolveDictation(4, { rejection: 'IPC 전사 오류' })
  await page.waitForFunction(() =>
    document.querySelector('.hearing-message:last-child .hearing-dictation-status')?.textContent?.includes('IPC 전사 오류')
  )
  assert.ok(await composer.isEnabled())
  assert.ok(await dictationButton.isEnabled())
  console.log('hearing dictation handles rejected transcription requests without blocking input')

  const beforePendingDelete = await messages.locator('textarea').evaluateAll(
    (inputs) => inputs.map((input) => input.value)
  )
  await composer.fill('삭제할 녹음 초안')
  await dictationButton.click()
  await shellPanel.locator('.hearing-dictation-btn.recording').waitFor()
  await dictationButton.click()
  await messages.last().locator('.hearing-dictation-status[role="status"]').waitFor()
  await composer.fill('삭제와 관계없는 새 초안')
  await messages.last().getByRole('button', { name: '진행 메모 삭제', exact: true }).click()
  assert.equal(await messages.count(), beforePendingDelete.length)
  await resolveDictation(5, { ok: true, text: '늦게 도착한 삭제된 발언', corrected: false })
  await page.waitForTimeout(1_100)
  assert.deepEqual(await messages.locator('textarea').evaluateAll(
    (inputs) => inputs.map((input) => input.value)
  ), beforePendingDelete, '전사 완료 후에도 삭제한 대화가 되살아나면 안 된다')
  assert.equal(await composer.inputValue(), '삭제와 관계없는 새 초안')
  const afterPendingDelete = await app.evaluate(() => JSON.parse(globalThis.__hearingWrites.at(-1).content))
  assert.deepEqual(afterPendingDelete.entries.map((entry) => entry.text), beforePendingDelete)
  console.log('deleted pending dictation stays deleted when transcription completes')

  for (let index = 1; index <= 16; index += 1) {
    await composer.fill(`연속 발언 ${index}`)
    await submit.click()
  }
  const latestMessage = shellPanel.locator('.hearing-message').last()
  await latestMessage.waitFor()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const latestScrollMetrics = () => shellPanel.locator('.hearing-body').evaluate((body) => {
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
  const scrollMetrics = await latestScrollMetrics()
  assert.ok(
    scrollMetrics &&
      scrollMetrics.scrollTop > 0 &&
      scrollMetrics.messageBottom <= scrollMetrics.bodyBottom + 1 &&
      scrollMetrics.messageTop >= scrollMetrics.bodyTop - 1,
    `새 발언이 쌓이면 기일기록 스크롤이 마지막 발언을 따라가야 한다: ${JSON.stringify(scrollMetrics)}`
  )
  console.log('hearing record follows the latest statement')

  await shellPanel.locator('.hearing-body').evaluate((body) => body.scrollTo(0, 0))
  await page.locator('[data-work-side="right"] .tab', { hasText: '설정' }).click()
  await page.locator('[data-work-side="right"] .tab', { hasText: '기일기록' }).click()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const restoredScrollMetrics = await latestScrollMetrics()
  assert.ok(
    restoredScrollMetrics &&
      restoredScrollMetrics.scrollTop > 0 &&
      restoredScrollMetrics.messageBottom <= restoredScrollMetrics.bodyBottom + 1 &&
      restoredScrollMetrics.messageTop >= restoredScrollMetrics.bodyTop - 1,
    `기일기록 탭에 돌아오면 마지막 발언이 보여야 한다: ${JSON.stringify(restoredScrollMetrics)}`
  )
  console.log('hearing record returns to the latest statement after tab changes')

  await page.waitForTimeout(1_100)
  const beforeDelete = await app.evaluate(() => JSON.parse(globalThis.__hearingWrites.at(-1).content))
  await messages.nth(1).getByRole('button', { name: '진행 메모 삭제', exact: true }).click()
  await page.waitForTimeout(1_100)
  const afterDelete = await app.evaluate(() => JSON.parse(globalThis.__hearingWrites.at(-1).content))
  assert.deepEqual(afterDelete.entries, beforeDelete.entries.filter((_, index) => index !== 1),
    '선택한 대화만 삭제하고 다른 대화의 내용·화자·순서를 보존해 저장해야 한다')
  assert.deepEqual(afterDelete.requests, beforeDelete.requests)
  assert.deepEqual(afterDelete.result, beforeDelete.result)
  console.log('deleting one hearing entry preserves and saves all other entries')

  while (await messages.count()) {
    await messages.last().getByRole('button', { name: '진행 메모 삭제', exact: true }).click()
  }
  await shellPanel.locator('.hearing-log .hearing-empty-line').waitFor()
  await page.waitForTimeout(1_100)
  const emptyRecord = await app.evaluate(() => JSON.parse(globalThis.__hearingWrites.at(-1).content))
  assert.deepEqual(emptyRecord.entries, [], '마지막 대화 삭제도 자동 저장되어야 한다')
  await shellPanel.getByRole('button', { name: '읽기', exact: true }).click()
  await shellPanel.locator('.hearing-reader-item').first().click()
  assert.equal(await messages.count(), 0, '저장 기록을 다시 열어도 삭제한 대화가 되살아나면 안 된다')
  await shellPanel.locator('.hearing-log .hearing-empty-line').waitFor()
  console.log('deleting the final hearing entry persists after reopening the saved record')

  await shellPanel.getByRole('button', { name: '새 기록', exact: true }).click()
  const writesBeforeEmptyRecord = await app.evaluate(() => globalThis.__hearingWrites.length)
  await page.waitForTimeout(1_100)
  assert.equal(await app.evaluate(() => globalThis.__hearingWrites.length), writesBeforeEmptyRecord,
    '입력하지 않은 새 기록은 자동 저장하지 않아야 한다')
  await app.evaluate(() => { globalThis.__holdNextHearingWrite = true })
  await composer.fill('최초 저장 중 삭제할 대화')
  await submit.click()
  await app.evaluate(async () => {
    const deadline = Date.now() + 5_000
    while (!globalThis.__releaseHearingWrite && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (!globalThis.__releaseHearingWrite) throw new Error('첫 저장 요청이 도착하지 않았습니다.')
  })
  await messages.last().getByRole('button', { name: '진행 메모 삭제', exact: true }).click()
  await page.waitForTimeout(1_100)
  await app.evaluate(() => { globalThis.__releaseHearingWrite() })
  await page.waitForTimeout(1_100)
  const deletedDuringSave = await app.evaluate(() => JSON.parse(globalThis.__hearingWrites.at(-1).content))
  assert.deepEqual(deletedDuringSave.entries, [], '지연된 최초 저장이 삭제 결과를 덮어쓰면 안 된다')
  console.log('deleting during the first save leaves the final saved record empty')

  for (const destination of ['새 기록', '저장 기록']) {
    await composer.fill(`전환 전에 삭제할 대화: ${destination}`)
    await submit.click()
    await page.waitForTimeout(1_100)
    const originalPath = await app.evaluate(() => globalThis.__hearingWrites.at(-1).path)
    // 저장 목록은 삭제 전 내용이어도 전환 시 최신 파일을 읽어야 한다.
    if (destination === '저장 기록') {
      await shellPanel.getByRole('button', { name: '읽기', exact: true }).click()
      await shellPanel.locator('.hearing-reader-item').first().waitFor()
    }
    await messages.last().getByRole('button', { name: '진행 메모 삭제', exact: true }).click()
    if (destination === '새 기록') {
      await shellPanel.getByRole('button', { name: destination, exact: true }).click()
    } else {
      await shellPanel.locator('.hearing-reader-item').first().click()
    }
    await page.waitForTimeout(1_100)
    const switchedRecord = await app.evaluate((_electron, originalPath) =>
      JSON.parse(globalThis.__hearingWrites.findLast((write) => write.path === originalPath).content), originalPath)
    assert.deepEqual(switchedRecord.entries, [], `${destination}으로 즉시 전환해도 삭제를 먼저 저장해야 한다`)
    assert.equal(await messages.count(), 0, '전환 시 삭제 전 메모를 다시 표시하지 않아야 한다')
  }
  console.log('immediate new/saved record switches flush deletions and read current saved content')

  const diarizationEntryOffset = await messages.count()
  let nextDiarizationIndex = await app.evaluate(() => globalThis.__hearingTranscriptions.length)
  const diarizeToggle = shellPanel.getByRole('checkbox', { name: '화자 자동 분리' })
  await diarizeToggle.check()
  await composer.fill('녹음과 별개로 작성 중인 메모')
  const recordingStartedAt = Date.now()
  await dictationButton.click()
  await shellPanel.locator('.hearing-dictation-btn.recording').waitFor()
  assert.ok(await diarizeToggle.isDisabled(), '녹음 도중 화자 분리 방식을 바꾸지 못해야 한다')
  await dictationButton.click()
  await messages.last().getByRole('status').waitFor()
  assert.equal(await composer.inputValue(), '녹음과 별개로 작성 중인 메모')
  await submit.click()
  const diarizedResult = {
    ok: true,
    text: '첫 질문 첫 답변 다음 질문',
    segments: [
      { speaker: 'A', text: '첫 질문', start: 0.5, end: 2 },
      { speaker: 'B', text: '첫 답변', start: 2.5, end: 5 },
      { speaker: 'A', text: '다음 질문', start: 6, end: 8 }
    ]
  }
  await resolveDictation(nextDiarizationIndex++, diarizedResult)
  await shellPanel.getByRole('combobox', { name: '화자 1 일괄 지정' }).waitFor()
  assert.equal(await app.evaluate(() => globalThis.__hearingTranscriptions.at(-1).payload.diarize), true)
  assert.deepEqual(await messages.locator('textarea').evaluateAll((inputs, offset) => inputs.slice(offset).map((input) => input.value), diarizationEntryOffset),
    ['첫 질문', '첫 답변', '다음 질문', '녹음과 별개로 작성 중인 메모'],
    '한 녹음의 발언 순서를 보존하고 전사 대기 중 작성한 메모도 유지해야 한다')
  const firstDetectedId = await messages.nth(diarizationEntryOffset + 0).getByRole('combobox').inputValue()
  assert.equal(await messages.nth(diarizationEntryOffset + 2).getByRole('combobox').inputValue(), firstDetectedId)
  assert.notEqual(await messages.nth(diarizationEntryOffset + 1).getByRole('combobox').inputValue(), firstDetectedId)
  await page.waitForTimeout(1_100)
  await shellPanel.getByRole('button', { name: '읽기', exact: true }).click()
  await shellPanel.locator('.hearing-reader-item').first().click()
  await shellPanel.getByRole('combobox', { name: '화자 1 일괄 지정' }).waitFor()
  await page.screenshot({ path: '/tmp/legal-terminal-diarization-check.png' })
  await shellPanel.locator('.hearing-template-btn', { hasText: '형사' }).click()
  assert.equal(await shellPanel.locator('.hearing-detected-speakers select').count(), 2,
    '템플릿을 바꿔도 이미 기록한 화자는 유지해야 한다')
  assert.equal(await messages.nth(diarizationEntryOffset + 0).getByRole('combobox').inputValue(), firstDetectedId)
  await shellPanel.getByRole('combobox', { name: '화자 1 일괄 지정' }).selectOption('court')
  assert.equal(await messages.nth(diarizationEntryOffset + 0).getByRole('combobox').inputValue(), 'court')
  assert.equal(await messages.nth(diarizationEntryOffset + 2).getByRole('combobox').inputValue(), 'court')
  assert.notEqual(await messages.nth(diarizationEntryOffset + 1).getByRole('combobox').inputValue(), 'court')
  await page.waitForTimeout(1_100)
  const separatedRecord = await app.evaluate(() => JSON.parse(globalThis.__hearingWrites.at(-1).content))
  const savedDiarization = separatedRecord.entries.slice(diarizationEntryOffset)
  assert.equal(savedDiarization[0].recording.id, savedDiarization[2].recording.id)
  assert.deepEqual(savedDiarization.slice(0, 3).map((entry) => [entry.recording.start, entry.recording.end]),
    [[0.5, 2], [2.5, 5], [6, 8]], '녹음 구간은 원본 값으로 저장해야 한다')
  assert.ok(Date.parse(savedDiarization[0].createdAt) >= recordingStartedAt)
  assert.equal(Date.parse(savedDiarization[2].createdAt) - Date.parse(savedDiarization[0].createdAt), 5500)
  console.log('one recording splits by speaker, preserves drafts and timestamps, and supports persisted bulk assignment')

  await dictationButton.click()
  await shellPanel.locator('.hearing-dictation-btn.recording').waitFor()
  await dictationButton.click()
  await messages.last().getByRole('status').waitFor()
  await resolveDictation(nextDiarizationIndex++, diarizedResult)
  await page.waitForFunction((expected) => document.querySelectorAll('.hearing-message').length === expected, diarizationEntryOffset + 7)
  assert.notEqual(await messages.nth(diarizationEntryOffset + 4).getByRole('combobox').inputValue(), 'court',
    '새 녹음의 A 화자를 이전 녹음에서 지정한 재판부로 추정하면 안 된다')
  assert.notEqual(await messages.nth(diarizationEntryOffset + 5).getByRole('combobox').inputValue(),
    await messages.nth(diarizationEntryOffset + 1).getByRole('combobox').inputValue(), '화자 번호는 녹음마다 독립적이어야 한다')

  await dictationButton.click()
  await shellPanel.locator('.hearing-dictation-btn.recording').waitFor()
  await dictationButton.click()
  await messages.last().getByRole('status').waitFor()
  await resolveDictation(nextDiarizationIndex++, { ok: false, error: '화자 전사 연결 실패' })
  await page.waitForFunction(() => document.querySelector('.hearing-message:last-child .hearing-dictation-status')
    ?.textContent?.includes('화자 전사 연결 실패'))
  assert.ok(await dictationButton.isEnabled(), '화자 분리 실패 후에도 다음 녹음이 가능해야 한다')
  await composer.press('ArrowUp')
  assert.equal(await messages.count(), diarizationEntryOffset + 8, '위쪽 방향키가 재시도할 녹음과 실패 행을 제거하면 안 된다')
  await messages.last().getByRole('button', { name: '전사 재시도', exact: true }).click()
  await messages.last().getByRole('status').waitFor()
  await resolveDictation(nextDiarizationIndex++, diarizedResult)
  await page.waitForFunction((expected) => document.querySelectorAll('.hearing-message').length === expected, diarizationEntryOffset + 10)
  assert.equal(await messages.count(), diarizationEntryOffset + 10, '재녹음 없이 실패한 행을 화자별 발언으로 바꿔야 한다')
  assert.equal(await app.evaluate(() => globalThis.__hearingTranscriptions.at(-1).payload.audio.byteLength), 10)
  await dictationButton.click()
  await shellPanel.locator('.hearing-dictation-btn.recording').waitFor()
  await dictationButton.click()
  await messages.last().getByRole('status').waitFor()
  await resolveDictation(nextDiarizationIndex++, { ok: false, error: '다시 연결 실패' })
  const retryButton = messages.last().getByRole('button', { name: '전사 재시도', exact: true })
  await retryButton.waitFor()
  await retryButton.click()
  await dictationButton.click()
  await shellPanel.locator('.hearing-dictation-btn.recording').waitFor()
  await resolveDictation(nextDiarizationIndex++, diarizedResult)
  await page.waitForFunction((expected) => document.querySelectorAll('.hearing-message').length === expected, diarizationEntryOffset + 13)
  assert.equal(await dictationButton.getAttribute('aria-label'), '녹음 정지',
    '전사 재시도가 완료되어도 다른 녹음은 계속되어야 한다')
  await dictationButton.click()
  await messages.last().getByRole('status').waitFor()
  await resolveDictation(nextDiarizationIndex++, diarizedResult)
  await page.waitForFunction((expected) => document.querySelectorAll('.hearing-message').length === expected, diarizationEntryOffset + 16)
  await diarizeToggle.uncheck()
  console.log('speaker groups remain distinct across recordings; failed recordings are retried without interrupting new recordings')

  const ordinaryRetryIndex = await app.evaluate(() => globalThis.__hearingTranscriptions.length)
  await speakerPicker.selectOption('court')
  await composer.fill('재시도할 초안')
  await dictationButton.click()
  await shellPanel.locator('.hearing-dictation-btn.recording').waitFor()
  await dictationButton.click()
  const ordinaryRetryRow = messages.last()
  await ordinaryRetryRow.getByRole('status').waitFor()
  const ordinaryRetryCount = await messages.count()
  await resolveDictation(ordinaryRetryIndex, { ok: false, error: 'OpenAI API 크레딧이 소진되었습니다. 충전 후 다시 시도해 주세요.' })
  await ordinaryRetryRow.getByRole('button', { name: '전사 재시도', exact: true }).click()
  await ordinaryRetryRow.getByRole('status').waitFor()
  await speakerPicker.selectOption('prosecutor')
  await composer.fill('재시도 중 새 초안')
  await resolveDictation(ordinaryRetryIndex + 1, { rejection: '재시도 중 연결 끊김' })
  await ordinaryRetryRow.getByRole('button', { name: '전사 재시도', exact: true }).waitFor()
  assert.match(await ordinaryRetryRow.getByRole('status').textContent(), /재시도 중 연결 끊김/)
  assert.equal(await ordinaryRetryRow.locator('textarea').inputValue(), '재시도할 초안')
  assert.equal(await messages.count(), ordinaryRetryCount, '재시도 실패가 대화 항목을 추가하면 안 된다')
  await ordinaryRetryRow.getByRole('button', { name: '전사 재시도', exact: true }).evaluate((button) => {
    button.click()
    button.click()
  })
  const retryContext = await resolveDictation(ordinaryRetryIndex + 2, { ok: true, text: '복구된 발언', corrected: false })
  await page.waitForFunction(() => document.querySelector('.hearing-message:last-child textarea')?.value === '재시도할 초안 복구된 발언')
  assert.equal(retryContext.speaker, '재판부')
  assert.equal(await ordinaryRetryRow.getByRole('combobox').inputValue(), 'court')
  assert.equal(await composer.inputValue(), '재시도 중 새 초안')
  assert.equal(await messages.count(), ordinaryRetryCount)
  assert.equal(await app.evaluate(() => globalThis.__hearingTranscriptions.length), ordinaryRetryIndex + 3,
    '재시도 버튼을 연속 클릭해도 같은 녹음을 중복 전송하면 안 된다')
  assert.equal(await ordinaryRetryRow.getByRole('button', { name: '전사 재시도', exact: true }).count(), 0)
  assert.ok(await app.evaluate((_electron, index) => {
    const original = globalThis.__hearingTranscriptions[index].payload
    return original.diarize === false && globalThis.__hearingTranscriptions.slice(index + 1).every(({ payload }) =>
      payload.diarize === false && Buffer.from(original.audio).equals(Buffer.from(payload.audio)))
  }, ordinaryRetryIndex), '일반 받아쓰기도 재녹음 없이 원래 음성으로 재시도해야 한다')
  console.log('ordinary dictation survives quota and repeated connection failures, deduplicates retries, and preserves audio, speaker, and drafts')

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
