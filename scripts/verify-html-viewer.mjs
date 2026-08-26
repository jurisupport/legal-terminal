import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
const classifier = app.match(/const docKindForPath[\s\S]*?\n}/)?.[0] ?? ''
const normalizer = app.match(/const normalizeDocKind[\s\S]*?\n\s+path[^\n]+/)?.[0] ?? ''
const htmlView = app.match(/function HtmlView[\s\S]*?\/\*\* HWP\/HWPX/)?.[0] ?? ''

assert.match(classifier, /if \(HTML_EXT_RE\.test\(lower\)\) return 'file'/)
assert.ok(classifier.indexOf('HTML_EXT_RE') < classifier.indexOf('TEXT_EDIT_EXT_RE'))
assert.doesNotMatch(normalizer, /isHtmlPath/)
assert.match(app, /isHtmlPath\(tab\.path\)[\s\S]*?<HtmlView/)
assert.match(htmlView, /sandbox=""/, 'HTML preview scripts must remain sandboxed')
assert.match(htmlView, /!path\.startsWith\('ssh:\/\/'\)[\s\S]*?openHtml\(path\)/, 'local HTML must open in the default browser')
assert.match(htmlView, /스크립트는 미리보기에서 실행되지 않습니다/)
assert.match(preload, /openHtml:.*invoke\('app:openHtml', path\)/)
assert.match(main, /ipcMain\.handle\('app:openHtml'[\s\S]*?isAbsolute\(path\)[\s\S]*?\.html\?\$[\s\S]*?shell\.openPath\(path\)/)
