import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const classifier = app.match(/const docKindForPath[\s\S]*?\n}/)?.[0] ?? ''

assert.match(classifier, /if \(HTML_EXT_RE\.test\(lower\)\) return 'file'/)
assert.ok(classifier.indexOf('HTML_EXT_RE') < classifier.indexOf('TEXT_EDIT_EXT_RE'))
assert.match(app, /const normalizeDocKind[\s\S]*?isHtmlPath\(path\) \? 'file'/)
assert.match(app, /isHtmlPath\(tab\.path\)[\s\S]*?<HtmlView/)
