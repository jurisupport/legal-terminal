// 데모 fixture용 샘플 PDF 생성기.
// 실행: ELECTRON 바이너리로 직접 구동 (ELECTRON_RUN_AS_NODE 없이):
//   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/generate-demo-pdfs.mjs
import { app, BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'demo-fixtures')
const outDir = path.join(fixtures, '2026가단12345_임대차보증금', '기록')

const jobs = [
  ['계약서.html', '갑제1호증_임대차계약서.pdf'],
  ['내용증명.html', '갑제2호증_내용증명.pdf']
]

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 1200 })
  for (const [html, pdf] of jobs) {
    await win.loadURL(pathToFileURL(path.join(fixtures, html)).href)
    const data = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true })
    await writeFile(path.join(outDir, pdf), data)
    console.log('wrote', pdf, data.length, 'bytes')
  }
  app.exit(0)
})
