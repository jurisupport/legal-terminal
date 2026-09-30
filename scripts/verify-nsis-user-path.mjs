// Build complete real installer/uninstaller templates; a standalone macro misses expansion-order bugs.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { build, Platform, Arch } = require('electron-builder')
const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget')
const { NSIS_PATH, nsisTemplatesDir } = require('app-builder-lib/out/targets/nsis/nsisUtil')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const override = await fs.readFile(path.join(root, 'build/safePerUserInstallMode.nsh'), 'utf8')
assert.match(override, /!insertmacro GetDParameter \$R0\s+\$\{If\} \$R0 != ""\s+StrCpy \$INSTDIR \$R0/, 'Explicit /D stays authoritative')
assert.match(override, /ReadRegStr \$perUserInstallationFolder HKCU/, 'Existing per-user installation path stays authoritative')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nsis-user-path-'))
const compiled = new Set()
const executeMakensis = NsisTarget.prototype.executeMakensis
try {
  await fs.mkdir(path.join(temp, 'app/resources'), { recursive: true })
  await fs.writeFile(path.join(temp, 'package.json'), JSON.stringify({ name: 'legal-terminal-installer-test', version: '1.0.0', description: 'Synthetic installer compile', author: 'test', main: 'index.js' }))
  await fs.writeFile(path.join(temp, 'app/legal-terminal-installer-test.exe'), 'Synthetic payload; never launched')
  await fs.writeFile(path.join(temp, 'app/resources/app.asar'), 'Synthetic payload')
  // Instrument compiler inputs in this test process only; leave installed dependencies untouched.
  NsisTarget.prototype.executeMakensis = async function (defines, commands, script) {
    const nsis = await NSIS_PATH()
    const compiler = path.join(nsis, process.platform === 'win32' ? 'Bin/makensis.exe' : process.platform === 'darwin' ? 'mac/makensis' : 'linux/makensis')
    const args = ['-WX', '-V4', '-INPUTCHARSET', 'UTF8', ...Object.entries(defines).map(([name, value]) => value == null ? `-D${name}` : `-D${name}=${value}`), ...Object.entries(commands).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => `-X${name} ${item}`)), '-']
    const expanded = execFileSync(compiler, args, { input: script, cwd: nsisTemplatesDir, env: { ...process.env, NSISDIR: nsis }, encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 })
    assert.ok(expanded.includes('KERNEL32::lstrcpynW'), 'Actual expanded template uses bounded copy')
    assert.equal(expanded.includes('Plugin command: Store'), false, 'No installer/uninstaller path retains legacy register copy')
    assert.equal(expanded.includes('&w8192'), false, 'No fixed-width read from a shell-allocated path')
    assert.ok(expanded.includes('StrCpy $INSTDIR \"$R0\"'), 'Expanded template keeps explicit directory override')
    compiled.add('BUILD_UNINSTALLER' in defines ? 'uninstaller' : 'installer')
  }
  const outputs = await build({ publish: 'never', projectDir: temp, prepackaged: path.join(temp, 'app'), targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), config: {
    appId: 'test.legalterminal.nsis', electronVersion: require('electron/package.json').version, directories: { output: path.join(temp, 'out'), buildResources: path.join(root, 'build') },
    win: { icon: path.join(root, 'build/icon.ico'), signAndEditExecutable: false },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, include: path.join(root, 'build/customInstaller.nsh') }, npmRebuild: false
  } })
  assert.deepEqual([...compiled].sort(), ['installer', 'uninstaller'])
  assert.ok(outputs.some(file => file.endsWith('.exe')))
  console.log('NSIS safe path: full real installer/uninstaller compiled; all expanded paths use bounded copies and retain explicit /D')
} finally {
  NsisTarget.prototype.executeMakensis = executeMakensis
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
