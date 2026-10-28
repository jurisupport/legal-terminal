import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import electron from 'electron'

const repo = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({
  stdin: {
    contents: `import * as shared from './src/renderer/src/markdownClipboard';
      import * as agent from './src/renderer/src/agent/markdown';
      window.clipboardTest = { shared, agent };`,
    resolveDir: repo
  },
  bundle: true,
  write: false,
  format: 'iife'
})

async function verify() {
  const { shared, agent } = window.clipboardTest
  let checks = 0
  const equal = (actual, expected) => {
    if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    checks += 1
  }
  const markdown = '3. **첫째**\n4. 둘째\n   - 하위\n   - 항목\n5. 셋째'
  const expected = '3. 첫째\n4. 둘째\n  • 하위\n  • 항목\n5. 셋째'
  equal(shared.markdownToPlainText(markdown), expected)
  equal(agent.markdownToPlainText(markdown), expected)
  equal(shared.markdownToPlainText('- 사과\n- 배'), '• 사과\n• 배')
  equal(shared.markdownToPlainText('0. 영\n1. 일'), '0. 영\n1. 일')
  equal(shared.markdownToPlainText('- 첫 문단\n\n  둘째 문단\n\n- 다음 항목'), '• 첫 문단\n\n둘째 문단\n\n• 다음 항목')
  equal(shared.htmlToPlainText('<ol reversed><li>셋</li><li value="7">칠</li><li>육</li></ol>'), '3. 셋\n7. 칠\n6. 육')
  equal(shared.markdownToPlainText('**강조**와 [링크](https://example.com)\n\n`코드`'), '강조와 링크\n\n코드')
  equal(shared.markdownToPlainText('```\n1. literal\n  - literal\n```'), '1. literal\n  - literal')

  const clipboard = new DataTransfer()
  equal(shared.writeMarkdownDataTransfer(clipboard, markdown), true)
  equal(clipboard.getData('text/plain'), expected)
  equal(clipboard.getData('text/markdown'), markdown)
  equal(clipboard.getData('text/html').includes('<ol start="3">'), true)
  equal(clipboard.getData('text/html').includes('white-space'), false)
  shared.writeMarkdownDataTransfer(clipboard, markdown, 'markdown')
  equal(clipboard.getData('text/plain'), markdown)

  let written
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text) => { written = text },
    write: async (items) => { written = await (await items[0].getType('text/plain')).text() }
  } })
  for (const copy of [shared.writeMarkdownClipboard, agent.copyAgentOutput]) {
    await copy(markdown, 'text')
    equal(written, expected)
    await copy(markdown, 'rich')
    equal(written, expected)
    await copy(markdown, 'markdown')
    equal(written, markdown)
  }

  const host = document.createElement('div')
  host.innerHTML = '<ol start="5"><li>첫째</li><li><strong>둘째</strong></li><li>셋째<ul><li>하위 가</li><li>하위 나</li></ul></li></ol><p>끝</p>'
  document.body.appendChild(host)
  const originalHtml = host.innerHTML
  const items = host.querySelectorAll('li')
  const select = (start, startOffset, end, endOffset) => {
    const range = document.createRange()
    range.setStart(start, startOffset)
    range.setEnd(end, endOffset)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    const data = new DataTransfer()
    equal(agent.writeSelectionToClipboard(data, selection), true)
    equal(host.innerHTML, originalHtml)
    equal(shared.htmlToPlainText(agent.selectedHtml(selection)), data.getData('text/plain'))
    return data.getData('text/plain')
  }
  equal(select(items[1].firstChild.firstChild, 0, items[2].firstChild, 2), '6. 둘째\n7. 셋째')
  equal(select(items[1].firstChild.firstChild, 0, items[1].firstChild.firstChild, 2), '6. 둘째')
  equal(select(items[0].firstChild, 2, items[1].firstChild.firstChild, 2), '6. 둘째')
  equal(select(items[1].firstChild.firstChild, 0, items[2].firstChild, 0), '6. 둘째')
  equal(select(items[2].firstChild, 0, items[4].firstChild, 4), '7. 셋째\n  • 하위 가\n  • 하위 나')
  equal(select(host, 0, host, host.childNodes.length), '5. 첫째\n6. 둘째\n7. 셋째\n  • 하위 가\n  • 하위 나\n\n끝')
  host.remove()
  return checks
}

const temp = await mkdtemp(path.join(os.tmpdir(), 'legal-terminal-clipboard-'))
try {
  const runner = path.join(temp, 'verify.cjs')
  const code = `${bundle.outputFiles[0].text}\n(${verify.toString()})()`
  await writeFile(runner, `const { app, BrowserWindow } = require('electron');
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false });
      try {
        await win.loadURL('about:blank');
        const checks = await win.webContents.executeJavaScript(${JSON.stringify(code)});
        console.log('markdown clipboard: ' + checks + ' checks passed');
        app.exit(0);
      } catch (error) { console.error(error); app.exit(1); }
    });`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electron, [runner, `--user-data-dir=${temp}/profile`], { env, stdio: 'inherit', timeout: 30_000 })
    child.on('error', reject)
    child.on('exit', resolve)
  })
  assert.equal(exitCode, 0, 'clipboard checks must pass in Electron')
} finally {
  await rm(temp, { recursive: true, force: true })
}
