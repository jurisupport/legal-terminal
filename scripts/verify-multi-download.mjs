import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const fileTree = await readFile(new URL('../src/renderer/src/filetree/FileTree.tsx', import.meta.url), 'utf8')
const preload = await readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')

assert.match(fileTree, /onDownload\(paths\)/, 'the file tree must pass every selected path')
assert.match(fileTree, /`다운로드 \(\$\{downloadableEntries\.length\}개\)`/, 'the menu must show the selected count')
assert.match(preload, /source: string \| string\[\]/, 'the preload bridge must accept multiple paths')
assert.match(main, /if \(sources\.length > 1\)/, 'the main process must handle multiple paths together')
assert.match(main, /plans\.flatMap\(\(item\) => item\.files\)/, 'all selected download plans must be merged')

console.log('multi download ok')
