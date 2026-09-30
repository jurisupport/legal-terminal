// Compile the backport with the same NSIS toolchain used by electron-builder.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { NSIS_PATH, NsisTargetOptions, nsisTemplatesDir } = require('app-builder-lib/out/targets/nsis/nsisUtil')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const override = await fs.readFile(path.join(root, 'build/safePerUserInstallMode.nsh'), 'utf8')
const modes = await fs.readFile(path.join(nsisTemplatesDir, 'multiUserUi.nsh'), 'utf8')
const config = await fs.readFile(path.join(root, 'electron-builder.yml'), 'utf8')
assert.match(config, /oneClick: false/, 'The early install-mode hook is for assisted installers')
assert.ok(modes.indexOf('!insertmacro customInstallMode') < modes.indexOf('!insertmacro setInstallModePerUser'), 'Both installer/uninstaller mode functions must override before expansion')
assert.match(override, /!insertmacro GetDParameter \$R0\s+\$\{If\} \$R0 != ""\s+StrCpy \$INSTDIR \$R0/, 'Explicit /D stays authoritative')
assert.match(override, /ReadRegStr \$perUserInstallationFolder HKCU/, 'Existing per-user installation path stays authoritative')
NsisTargetOptions.resolve({})
const nsis = await NSIS_PATH()
const compiler = path.join(nsis, process.platform === 'win32' ? 'Bin/makensis.exe' : process.platform === 'darwin' ? 'mac/makensis' : 'linux/makensis')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nsis-user-path-'))
try {
  const script = [
    'Unicode true', 'Name "Synthetic safe path"', `OutFile "${path.join(temp, 'test.exe')}"`, 'RequestExecutionLevel user',
    '!include LogicLib.nsh', `!addincludedir "${path.join(root, 'build')}"`, '!include installer.nsh',
    '!define FOLDERID_UserProgramFiles {5CD7AEE2-2219-4A67-B85D-6C9CE15660CB}', '!define KF_FLAG_CREATE 0x00008000',
    '!define INSTALL_REGISTRY_KEY "Software\\synthetic-safe-copy"', '!define APP_FILENAME "synthetic-safe-copy"',
    'Var installMode', 'Var perUserInstallationFolder',
    '!macro setInstallModePerUser', '!error "Unsafe legacy macro was expanded"', '!macroend',
    '!macro GetDParameter outVar', 'StrCpy ${outVar} "synthetic-explicit-directory"', '!macroend',
    'Section', '!insertmacro customInstallMode', '!insertmacro setInstallModePerUser', 'SectionEnd',
    'Section "Uninstall"', '!insertmacro customInstallMode', '!insertmacro setInstallModePerUser', 'SectionEnd'
  ].join('\n')
  const source = path.join(temp, 'test.nsi')
  await fs.writeFile(source, script)
  const options = { env: { ...process.env, NSISDIR: nsis }, encoding: 'utf8', timeout: 30000 }
  const expanded = execFileSync(compiler, ['-PPO', source], options)
  assert.equal((expanded.match(/KERNEL32::lstrcpynW/g) ?? []).length, 2, 'Install and uninstall use bounded copies')
  assert.equal(expanded.includes('System::Store'), false)
  assert.equal(expanded.includes('&w'), false, 'No fixed-width read from a shell-allocated path')
  assert.equal((expanded.match(/StrCpy \$INSTDIR \$R0/g) ?? []).length, 2)
  execFileSync(compiler, ['-V2', source], options)
  assert.ok((await fs.stat(path.join(temp, 'test.exe'))).size > 0)
  console.log('NSIS safe path: real compiler verified installer/uninstaller bounded copies, early override, existing path and /D preservation')
} finally { await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
