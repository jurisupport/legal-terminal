import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const bootstrap = await readFile(new URL('../install.ps1', import.meta.url))
const payload = await readFile(new URL('../install-windows.ps1', import.meta.url))
const releaseWorkflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')

assert.ok(bootstrap.every((byte) => byte < 128), 'install.ps1 must stay ASCII-safe for irm | iex')
assert.equal(payload.subarray(0, 3).toString('hex'), 'efbbbf', 'Windows payload must keep its UTF-8 BOM')
assert.match(bootstrap.toString(), /Get-Content[^\r\n]+-Encoding UTF8/)
assert.match(releaseWorkflow, /gh release upload[^\r\n]+install\.ps1[^\r\n]+install-windows\.ps1/)

console.log('windows installer encoding ok')
