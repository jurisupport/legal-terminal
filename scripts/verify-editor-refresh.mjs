import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-refresh-'))
const source = String.raw`
import React from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import MarkdownEditor from './src/renderer/src/editor/MarkdownEditor'
import { findTextChanges, mergeTextAgainstBase } from './src/renderer/src/editor/threeWayMerge'
import './src/renderer/src/styles.css'

let disk = '', version = 1, save, dirty = false, historyText = ''
const ok = async () => ({ ok: true })
window.lt = {
  settings: { get: async () => ({ mdFontSize: 14 }) },
  fs: {
    readText: async () => ({ kind: 'text', text: disk, size: disk.length, mtimeMs: version }),
    stat: async () => ({ ok: true, size: disk.length, mtimeMs: version }),
    loadDocumentDraft: ok, saveDocumentDraft: ok, deleteDocumentDraft: ok,
    listDocumentDraftHistory: async () => ({ ok: true, history: [{ id: 'old', title: '이전 편집본', content: historyText, savedAt: '2026-10-08T00:00:00Z' }] }),
    writeText: async (_path, content) => {
      disk = content; version++
      return { ok: true, stat: { size: disk.length, mtimeMs: version } }
    }
  }
}
const root = createRoot(document.getElementById('root'))
const pause = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms))
const wait = async (fn) => {
  for (let i = 0; i < 150; i++) { if (fn()) return; await pause() }
  throw Error('Timed out: ' + fn)
}
const checks = []
const check = (condition, label, detail = '') => { if (!condition) throw Error(label + ': ' + detail); checks.push(label) }
const original = Array.from({ length: 240 }, (_, i) =>
  '문단 ' + String(i).padStart(3, '0') + ': **확인할 문장**과 변하지 않는 본문입니다.\n\n'
).join('')
let generation = 0
async function mount(plainText = false, text = original) {
  disk = text; version++
  root.render(<MarkdownEditor key={++generation} path='/fixture/검토.claude-draft.md'
    draftId={'fixture-' + generation} plainText={plainText}
    onSaveHandler={handler => save = handler} onDirty={value => dirty = value} />)
  await wait(() => {
    const dom = document.querySelector('.cm-editor')
    return dom && EditorView.findFromDOM(dom)?.state.doc.toString() === text && !!save
  })
  await pause(100)
  return EditorView.findFromDOM(document.querySelector('.cm-editor'))
}
function visible(view) {
  const rect = view.scrollDOM.getBoundingClientRect()
  const pos = view.posAtCoords({ x: rect.left + 24, y: rect.top + 8 }, false)
  const line = view.state.doc.lineAt(pos)
  return { text: line.text, offset: view.coordsAtPos(pos)?.top - rect.top, top: view.scrollDOM.scrollTop }
}
async function position(view) {
  const from = view.state.doc.toString().indexOf('문단 120:')
  view.dispatch({ selection: { anchor: from, head: from + 6 }, effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: 8 }) })
  await pause(150)
  const before = visible(view)
  check(before.top > 1000 && before.text.includes('문단 120'), 'Fixture is scrolled to the middle')
  return before
}
async function refresh(view, text, expected = text) {
  disk = text; version++
  await wait(() => view.state.doc.toString() === expected)
  await pause(180)
}
function unchanged(view, before, label) {
  const after = visible(view)
  check(after.text === before.text && Math.abs(after.offset - before.offset) < 3,
    label, JSON.stringify({ before, after }))
  check(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) === '문단 120', label + ' keeps selection')
}
function editorGeometry(view) {
  const scroller = view.scrollDOM
  return JSON.stringify({
    docLength: view.state.doc.length, selection: view.state.selection.toJSON(),
    scrollTop: scroller.scrollTop, scrollLeft: scroller.scrollLeft,
    scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
    scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth,
    contentHeight: view.contentDOM.getBoundingClientRect().height,
    contentPadding: getComputedStyle(view.contentDOM).padding,
    firstLine: view.coordsAtPos(0), scrollerTop: scroller.getBoundingClientRect().top
  })
}
window.uiCheck = async () => {
  const pairs = [
    ['', '새 문서'], ['원래 문서', ''], ['변경 없음', '변경 없음'],
    ['첫째\n둘째\n마지막', '앞에 추가\n첫째\n바뀐 둘째\n마지막\n'],
    ['같은 줄\n'.repeat(1300), '새로운 줄\n'.repeat(1300)]
  ]
  let seed = 17
  const random = (limit) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit }
  for (let trial = 0; trial < 150; trial++) {
    const lines = Array.from({ length: random(40) }, () => ['반복 문장\n', '\n', '다른 줄\n', '한글 😀\n'][random(4)])
    const edited = [...lines]
    for (let i = 0; i < 5; i++) edited.splice(random(edited.length + 1), random(3), ...Array(random(3)).fill('수정 ' + i + '\n'))
    pairs.push([lines.join(''), edited.join('')])
  }
  for (const [before, after] of pairs) {
    const state = EditorState.create({ doc: before })
    const result = state.update({ changes: findTextChanges(before, after) }).state.doc.toString()
    if (result !== after) throw Error('Text update changed or lost content: ' + JSON.stringify({ before, after, result }))
  }
  check(true, '155 text replacement cases preserve exact contents')
  const merge = mergeTextAgainstBase('첫 문단\n\n둘째 문단', '첫 문단 사용자\n\n둘째 문단', '첫 문단\n\n둘째 문단 외부')
  check(merge.status === 'merged' && merge.text === '첫 문단 사용자\n\n둘째 문단 외부', 'Independent edits merge without losing text')
  check(mergeTextAgainstBase('원문', '사용자 수정', '외부 수정').status === 'conflict', 'Conflicting edits remain protected')
  for (const plain of [false, true]) {
    const mode = plain ? 'source' : 'preview'
    const view = await mount(plain)
    const before = await position(view)
    const remote = '새로 추가된 머리말\n\n' + original.replace('문단 010:', '문단 010: 외부 수정').replace('문단 220:', '문단 220: 외부 수정')
    await refresh(view, remote)
    unchanged(view, before, mode + ' disjoint external edits')
    check(!dirty, mode + ' external refresh stays saved')
    const localAt = view.state.doc.toString().indexOf('문단 180:')
    view.dispatch({ changes: { from: localAt, insert: '사용자 입력 ' } })
    const remoteAgain = remote.replace('문단 020:', '문단 020: 추가 수정').replace('문단 210:', '문단 210: 추가 수정')
    await refresh(view, remoteAgain, remoteAgain.replace('문단 180:', '사용자 입력 문단 180:'))
    unchanged(view, before, mode + ' external merge with unsaved input')
    check(dirty, mode + ' local input stays unsaved')
    await save()
    await pause(150)
    unchanged(view, before, mode + ' save')
    check(!dirty && disk.includes('사용자 입력 문단 180:'), mode + ' save keeps local input')
    historyText = original
    document.querySelector('[title="문서 히스토리에서 가져오기"]').click()
    await wait(() => document.querySelector('.draft-history-row'))
    document.querySelector('.draft-history-row').click()
    await wait(() => view.state.doc.toString() === historyText)
    await pause(180)
    unchanged(view, before, mode + ' history restore')
    check(dirty, mode + ' history restore remains unsaved')
  }
  const longText = original + Array.from({ length: 1200 }, (_, i) => '긴 문서 추가 문단 ' + i + '\n\n').join('')
  const longView = await mount(false, longText)
  const longBefore = await position(longView)
  await refresh(longView, '새 머리말\n\n' + longText.replace('추가 문단 1190', '추가 문단 1190 수정'))
  unchanged(longView, longBefore, 'Large document external refresh')
  // Retain overflow after deletion, as non-overlay scrollbars/padding can do on Windows.
  longView.contentDOM.style.minHeight = 'calc(100% + 24px)'
  await refresh(longView, '')
  check(longView.scrollDOM.scrollHeight > longView.scrollDOM.clientHeight, 'Empty fixture retains layout overflow', editorGeometry(longView))
  check(longView.scrollDOM.scrollTop === 0 && longView.state.selection.main.to === 0, 'Empty document clamps viewport and selection', editorGeometry(longView))
  longView.contentDOM.style.removeProperty('min-height')
  await pause(180)
  check(longView.scrollDOM.scrollTop === 0 && longView.state.selection.main.to === 0, 'Empty document stays at top after layout settles', editorGeometry(longView))
  return { checks: checks.length, scenarios: checks }
}
`

try {
  await build({
    stdin: { contents: source, resolveDir: root, loader: 'tsx' }, bundle: true,
    outfile: path.join(temp, 'ui.js'), platform: 'browser', jsx: 'automatic',
    loader: { '.ttf': 'file' }, define: { 'process.env.NODE_ENV': '"production"' }
  })
  await fs.writeFile(path.join(temp, 'index.html'), '<html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>#root{height:100vh;display:flex;flex-direction:column}</style></head><body><div id="root"></div><script src="ui.js"></script></body></html>')
  await fs.writeFile(path.join(temp, 'main.cjs'), String.raw`
    const { app, BrowserWindow } = require('electron')
    app.setPath('userData', ${JSON.stringify(path.join(temp, 'profile'))})
    app.whenReady().then(async () => {
      const w = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } })
      const errors = []
      w.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
      try {
        await w.loadFile(${JSON.stringify(path.join(temp, 'index.html'))})
        const result = await w.webContents.executeJavaScript('window.uiCheck()')
        if (errors.length) throw Error(errors.join('\n'))
        console.log('EDITOR_REFRESH_RESULT ' + JSON.stringify(result))
        app.exit(0)
      } catch (error) { console.error(error, errors); app.exit(1) }
    })
  `)
  const electron = process.platform === 'darwin'
    ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : path.join(root, 'node_modules/electron/dist/electron' + (process.platform === 'win32' ? '.exe' : ''))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(temp, 'main.cjs')], { env })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.on('error', reject)
    const timeout = setTimeout(() => { child.kill(); reject(Error('Editor refresh check timed out\n' + output)) }, 45_000)
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }) })
  })
  assert.equal(result.code, 0, result.output)
  console.log(result.output.split('\n').filter(line => line.includes('EDITOR_REFRESH_RESULT')).join('\n'))
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
