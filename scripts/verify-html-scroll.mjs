import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'html-scroll-'))
const app = await fs.readFile(path.join(root, 'src/renderer/src/App.tsx'), 'utf8')
const parsed = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = new Set(['HtmlView', 'htmlWithLocalBase', 'localFileBaseHref', 'useRemoteFileVersion', 'HTML_VIEWER_DEFAULT_STYLE', 'REMOTE_FILE_CHANGED_EVENT'])
const declarations = parsed.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.some(decl => names.has(decl.name.getText(parsed))))
).map(node => node.getText(parsed)).join('\n')
assert.equal(declarations.includes('function HtmlView'), true)
const source = String.raw`
import React, { useState, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import './src/renderer/src/styles.css'
const isRemotePath = path => path?.startsWith('ssh://')
const fileNameFromPath = path => path.split('/').pop()
const SelectionAsk = () => null
const SelectionMenu = () => null
const TextDoc = ({ actions, text }) => <div className="html-source">{actions}<pre>{text}</pre></div>
${declarations}
const root = createRoot(document.getElementById('root'))
const fixturePath = 'ssh://fixture/case/document.html'
const original = '<html><head><style>body{width:1800px;max-width:none}p{height:40px;margin:0}</style></head><body>' +
  Array.from({ length: 150 }, (_, i) => '<p>문단 ' + i + '</p>').join('') + '</body></html>'
let disk = original, version = 1, saved, generation = 0
window.lt = { fs: {
  readText: async () => { await new Promise(resolve => setTimeout(resolve, 30)); return { kind: 'text', text: disk } },
  stat: async () => ({ ok: true, size: disk.length, mtimeMs: version })
} }
const pause = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms))
const wait = async fn => {
  for (let i = 0; i < 100; i++) { if (fn()) return; await pause() }
  throw Error('Timed out: ' + fn)
}
const checks = []
const check = (value, label, detail = '') => { if (!value) throw Error(label + ': ' + detail); checks.push(label) }
const frame = () => document.querySelector('iframe')
const pos = () => ({ top: frame().contentWindow.scrollY, left: frame().contentWindow.scrollX })
const same = (expected, label) => {
  const actual = pos()
  check(Math.abs(actual.top - expected.top) < 2 && Math.abs(actual.left - expected.left) < 2,
    label, JSON.stringify({ actual, expected }))
}
async function mount() {
  root.render(<HtmlView key={++generation} path={fixturePath} onAsk={() => {}}
    scrollKey={fixturePath} initialScroll={saved} onScrollPosition={value => saved = value} />)
  await wait(() => frame()?.contentDocument?.body?.textContent.includes('문단 0'))
  await pause(100)
}
async function refresh(text) {
  const previous = frame().contentDocument
  disk = text; version++
  window.dispatchEvent(new CustomEvent(REMOTE_FILE_CHANGED_EVENT, { detail: { paths: [fixturePath] } }))
  await wait(() => frame()?.contentDocument?.body && frame().contentDocument !== previous && frame().contentDocument.body.textContent)
  await pause(100)
}
window.uiCheck = async () => {
  await mount()
  frame().contentWindow.scrollTo(230, 2400)
  await wait(() => saved?.top === 2400 && saved?.left === 230)
  const before = pos()
  check(frame().getAttribute('sandbox') === 'allow-same-origin', 'Iframe remains script-disabled')
  await refresh(original.replace('문단 149', '수정된 문단 149'))
  same(before, 'Remote refresh preserves vertical and horizontal offsets')
  document.querySelector('[title="HTML 코드 보기"]').click()
  await wait(() => document.querySelector('.html-source'))
  document.querySelector('[title="HTML 렌더링 보기"]').click()
  await wait(() => frame()?.contentDocument?.body?.textContent.includes('문단 0'))
  await pause(100)
  same(before, 'Returning from source mode preserves rendered position')
  root.render(null)
  await wait(() => !frame())
  await mount()
  same(before, 'Remount restores parent saved position')
  await refresh('<html><body>짧은 문서</body></html>')
  same({ top: 0, left: 0 }, 'Shorter document clamps both offsets')
  check(saved.top === 0 && saved.left === 0, 'Clamped offsets replace saved position')
  await refresh(original)
  same({ top: 0, left: 0 }, 'Growing document does not restore stale out-of-range offsets')
  saved = { key: '/different/document.html', top: 1200, left: 100 }
  await mount()
  same({ top: 0, left: 0 }, 'Position from another document is ignored')
  return { checks: checks.length, scenarios: checks }
}
`

try {
  await build({ stdin: { contents: source, resolveDir: root, loader: 'tsx' }, bundle: true,
    outfile: path.join(temp, 'ui.js'), platform: 'browser', jsx: 'automatic',
    loader: { '.ttf': 'file' }, define: { 'process.env.NODE_ENV': '"production"' } })
  await fs.writeFile(path.join(temp, 'index.html'), '<html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>#root{height:100vh;display:flex;flex-direction:column}</style></head><body><div id="root"></div><script src="ui.js"></script></body></html>')
  await fs.writeFile(path.join(temp, 'main.cjs'), String.raw`
    const { app, BrowserWindow } = require('electron')
    app.setPath('userData', ${JSON.stringify(path.join(temp, 'profile'))})
    app.whenReady().then(async () => {
      const w = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } })
      try {
        await w.loadFile(${JSON.stringify(path.join(temp, 'index.html'))})
        console.log('HTML_SCROLL_RESULT ' + JSON.stringify(await w.webContents.executeJavaScript('window.uiCheck()')))
        app.exit(0)
      } catch (error) { console.error(error); app.exit(1) }
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
    const timeout = setTimeout(() => { child.kill(); reject(Error('HTML scroll check timed out\n' + output)) }, 30_000)
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }) })
  })
  assert.equal(result.code, 0, result.output)
  console.log(result.output.split('\n').filter(line => line.includes('HTML_SCROLL_RESULT')).join('\n'))
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
