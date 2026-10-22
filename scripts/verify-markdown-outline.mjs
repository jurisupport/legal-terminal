import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-outline-'))
const screenshots = path.join(root, '.omx/artifacts/markdown-outline')
const source = String.raw`
import React from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import MarkdownEditor from './src/renderer/src/editor/MarkdownEditor'
import { markdownHeadings } from './src/renderer/src/editor/MarkdownOutline'
import './src/renderer/src/styles.css'

let disk = '', version = 1, generation = 0, dirty = false
const ok = async () => ({ ok: true })
window.lt = {
  settings: { get: async () => ({ mdFontSize: 14 }) },
  fs: {
    readText: async () => ({ kind: 'text', text: disk, size: disk.length, mtimeMs: version }),
    stat: async () => ({ ok: true, size: disk.length, mtimeMs: version }),
    loadDocumentDraft: ok, saveDocumentDraft: ok, deleteDocumentDraft: ok
  }
}
const root = createRoot(document.getElementById('root'))
const pause = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms))
const wait = async fn => {
  for (let i = 0; i < 150; i++) { if (fn()) return; await pause() }
  throw Error('Timed out: ' + fn)
}
const checks = []
const check = (condition, label) => { if (!condition) throw Error(label); checks.push(label) }
const trigger = () => document.querySelector('.md-outline-trigger')
const items = () => [...document.querySelectorAll('.md-outline-item')]
const open = async () => { trigger().click(); await wait(() => items().length) }
const fixture = '# 서면 검토 메모\n\n' + Array.from({ length: 18 }, (_, i) =>
  (i % 3 ? '### ' : '## ') + (i + 1) + '. ' + ['사건 개요', '주요 쟁점과 검토 사항', '증거 및 보완할 내용'][i % 3] + '\n\n' +
  Array.from({ length: 12 }, (_, j) => '문단 ' + i + '-' + j + ': 제출 자료와 주장 내용을 확인합니다. **검토할 사항**을 정리하고 관련 근거를 대조합니다.\n\n').join('')
).join('')
async function mount(text = fixture, plainText = false) {
  disk = text; version++; dirty = false
  root.render(<MarkdownEditor key={++generation} path='/fixture/검토.claude-draft.md'
    draftId={'outline-' + generation} plainText={plainText} onDirty={value => dirty = value} />)
  await wait(() => {
    const dom = document.querySelector('.cm-editor')
    return dom && EditorView.findFromDOM(dom)?.state.doc.toString() === text
  })
  await pause(150)
  return EditorView.findFromDOM(document.querySelector('.cm-editor'))
}
window.uiCheck = async () => {
  const fence = String.fromCharCode(96).repeat(3)
  const markdown = '# **상위** &amp; [링크](https://example.com)\n\n## 같은 제목\n\n## 같은 제목\n\n밑줄 제목\n===\n\n하위 제목\n---\n\n' +
    fence + '\n# 코드 안 제목\n' + fence + '\n\n~~~md\n## 다른 코드\n~~~\n\n    # 들여쓴 코드\n\n<!--\n# 주석\n-->\n\n#\n\n###### 마지막 ###'
  const parsed = markdownHeadings(markdown)
  check(JSON.stringify(parsed.map(h => [h.level, h.title])) === JSON.stringify([
    [1, '상위 & 링크'], [2, '같은 제목'], [2, '같은 제목'], [1, '밑줄 제목'], [2, '하위 제목'], [1, '제목 없음'], [6, '마지막']
  ]), 'Headings support inline formatting and setext, excluding code and comments')
  check(parsed[1].from !== parsed[2].from && markdown.slice(parsed[2].from).startsWith('## 같은 제목'), 'Duplicate headings keep distinct source positions')
  const long = '# 시작\n\n' + '본문\n\n'.repeat(10000) + '## 맨 끝'
  check(markdownHeadings(long).at(-1).from === long.indexOf('## 맨 끝'), 'Headings include the end of a large document')
  check(markdownHeadings('일반 본문\n\n---').length === 0, 'Horizontal rules and plain paragraphs are not headings')

  let view = await mount()
  check(!!trigger() && !document.querySelector('.md-outline-panel'), 'Outline starts as a compact rail')
  await open()
  check(items().length === 19 && items()[2].style.paddingLeft !== items()[1].style.paddingLeft, 'Outline shows heading hierarchy')
  const targetTitle = items()[10].textContent.trim()
  items()[10].click()
  await wait(() => !document.querySelector('.md-outline-panel') && view.scrollDOM.scrollTop > 1000)
  await open()
  await wait(() => document.querySelector('.md-outline-item[aria-current]')?.textContent.trim() === targetTitle)
  check(view.state.doc.lineAt(view.state.selection.main.head).text.includes(targetTitle), 'Click navigates to the exact heading and places the caret there')
  check(view.state.doc.toString() === fixture && !dirty, 'Browsing never changes or dirties the document')
  trigger().focus()
  trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await wait(() => !document.querySelector('.md-outline-panel'))
  check(document.activeElement === trigger(), 'Escape closes the outline and preserves keyboard access')
  await open()
  view.scrollDOM.scrollTop = 0
  await wait(() => items()[0].getAttribute('aria-current') === 'location')
  check(true, 'Manual scrolling updates the current section')
  document.querySelector('[title="원본(소스)"]').click()
  await open()
  items()[12].click()
  await wait(() => view.state.doc.lineAt(view.state.selection.main.head).text.includes('12.'))
  check(true, 'Navigation works in source mode')
  const from = view.state.selection.main.head
  const line = view.state.doc.lineAt(from)
  view.dispatch({ changes: { from, to: line.to, insert: '## 수정된 제목' } })
  await open()
  check(items().some(el => el.textContent.includes('수정된 제목')), 'Editing a heading refreshes the outline')
  const before = items().length
  view.dispatch({ changes: { from: 0, insert: '# 새 머리말\n\n' } })
  await wait(() => items().length === before + 1)
  items().find(el => el.textContent.includes('수정된 제목')).click()
  await wait(() => view.state.doc.lineAt(view.state.selection.main.head).text === '## 수정된 제목')
  check(true, 'Inserting text updates heading destinations')
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '본문만 남김' } })
  await wait(() => !trigger())
  check(true, 'Removing all headings hides the outline')

  view = await mount()
  disk = '# 외부 갱신\n\n' + fixture; version++
  await wait(() => view.state.doc.toString() === disk)
  await open()
  check(items()[0].textContent.includes('외부 갱신') && items().length === 20 && !dirty, 'External file updates refresh the outline without dirtying the file')
  await mount('# 일반 텍스트', true)
  check(!trigger(), 'Plain-text files do not gain Markdown navigation')
  await mount('')
  check(!trigger(), 'Empty files do not gain an empty outline')
  await mount()
  return { checks: checks.length, scenarios: checks }
}
`

try {
  await fs.mkdir(screenshots, { recursive: true })
  await build({
    stdin: { contents: source, resolveDir: root, loader: 'tsx' }, bundle: true,
    outfile: path.join(temp, 'ui.js'), platform: 'browser', jsx: 'automatic',
    loader: { '.ttf': 'file' }, define: { 'process.env.NODE_ENV': '"production"' }
  })
  await fs.writeFile(path.join(temp, 'index.html'), '<html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>#root{height:100vh;display:flex;flex-direction:column}</style></head><body><div id="root"></div><script src="ui.js"></script></body></html>')
  await fs.writeFile(path.join(temp, 'main.cjs'), String.raw`
    const { app, BrowserWindow } = require('electron')
    const fs = require('node:fs')
    const path = require('node:path')
    app.setPath('userData', ${JSON.stringify(path.join(temp, 'profile'))})
    app.whenReady().then(async () => {
      const w = new BrowserWindow({ width: 900, height: 720, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } })
      const errors = []
      w.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
      const run = code => w.webContents.executeJavaScript(code)
      const pause = () => new Promise(resolve => setTimeout(resolve, 180))
      const screenshot = async name => { await pause(); fs.writeFileSync(path.join(${JSON.stringify(screenshots)}, name + '.png'), (await w.webContents.capturePage()).toPNG()) }
      try {
        await w.loadFile(${JSON.stringify(path.join(temp, 'index.html'))})
        const result = await run('window.uiCheck()')
        await screenshot('collapsed')
        const point = await run('(() => { const r = document.querySelector(".md-outline-trigger").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 8) } })()')
        w.webContents.sendInputEvent({ type: 'mouseMove', ...point })
        await pause()
        if (!await run('!!document.querySelector(".md-outline-panel")')) throw Error('Hover does not open outline')
        await screenshot('expanded')
        w.webContents.sendInputEvent({ type: 'mouseMove', x: 850, y: 600 })
        await pause()
        if (await run('!!document.querySelector(".md-outline-panel")')) throw Error('Pointer leave does not close outline')
        result.scenarios.push('Native pointer hover opens the outline and leaving closes it')
        result.checks++
        await run('document.querySelector(".md-outline-trigger").focus()')
        w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        w.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
        w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
        await pause()
        if (!await run('!!document.querySelector(".md-outline-panel")')) throw Error('Keyboard does not open outline')
        w.setSize(380, 480)
        await pause()
        if (!await run('(() => { const r = document.querySelector(".md-outline-panel").getBoundingClientRect(); return r.right <= innerWidth && r.bottom <= innerHeight && document.querySelector(".md-outline-items").scrollHeight > document.querySelector(".md-outline-items").clientHeight })()')) throw Error('Narrow outline does not fit or scroll')
        await screenshot('narrow')
        result.scenarios.push('Keyboard opens the outline; narrow windows contain a scrollable list')
        result.checks++
        if (errors.length) throw Error(errors.join('\n'))
        console.log('MARKDOWN_OUTLINE_RESULT ' + JSON.stringify(result))
        app.exit(0)
      } catch (error) { console.error(error, errors); app.exit(1) }
    })
  `)
  const electron = createRequire(import.meta.url)('electron')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(temp, 'main.cjs')], { env })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.on('error', reject)
    const timeout = setTimeout(() => { child.kill(); reject(Error('Markdown outline check timed out\n' + output)) }, 45_000)
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }) })
  })
  assert.equal(result.code, 0, result.output)
  console.log(result.output.split('\n').filter(line => line.includes('MARKDOWN_OUTLINE_RESULT')).join('\n'))
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
