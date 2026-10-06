// Regression guard: claude-fable-5-1[1m] requires Claude Code 2.1.251 or newer.
// Inspect the native dependency shipped with this SDK, never the user's PATH CLI.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const sdkRoot = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'))
const sdk = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'))
const nativeName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
const sdkRequire = createRequire(join(sdkRoot, 'package.json'))
const nativeManifest = sdkRequire.resolve(`${nativeName}/package.json`)
const native = JSON.parse(readFileSync(nativeManifest, 'utf8'))
assert.equal(native.version, sdk.version, 'Claude SDK and its bundled native package must use the same version')
const executable = join(dirname(nativeManifest), process.platform === 'win32' ? 'claude.exe' : 'claude')
const output = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim()
const match = output.match(/\b(\d+)\.(\d+)\.(\d+)\b/)
assert.ok(match, `Cannot read bundled Claude version: ${output}`)
const [major, minor, patch] = match.slice(1).map(Number)
assert.ok(major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 251))),
  `Bundled Claude ${match[0]} cannot run claude-fable-5-1[1m]; update the SDK/native dependency to Claude Code >= 2.1.251`)
console.log(`Agent runtime verified: SDK/native ${sdk.version}, bundled ${output} (${process.platform}/${process.arch})`)
