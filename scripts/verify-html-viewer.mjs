import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const classifier = app.match(/const docKindForPath[\s\S]*?\n}/)?.[0] ?? ''
const normalizer = app.match(/const normalizeDocKind[\s\S]*?\n\s+path[^\n]+/)?.[0] ?? ''

assert.match(classifier, /if \(HTML_EXT_RE\.test\(lower\)\) return 'file'/)
assert.ok(classifier.indexOf('HTML_EXT_RE') < classifier.indexOf('TEXT_EDIT_EXT_RE'))
assert.doesNotMatch(normalizer, /isHtmlPath/)
assert.match(app, /isHtmlPath\(tab\.path\)[\s\S]*?<HtmlView/)
