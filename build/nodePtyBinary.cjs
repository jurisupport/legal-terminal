const fs = require('fs')
const path = require('path')

const BINARY_BY_PLATFORM = {
  darwin: 'pty.node',
  linux: 'pty.node',
  win32: 'conpty.node'
}

const ARCH_BY_BUILDER_VALUE = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal'
}

function normalizeArch(arch) {
  const raw = String(arch)
  return ARCH_BY_BUILDER_VALUE[raw] ?? raw
}

function expectedNodePtyBinary({ platform, arch, nodeModulesDir }) {
  const normalizedArch = normalizeArch(arch)
  const binaryName = BINARY_BY_PLATFORM[platform]
  if (!binaryName) {
    throw new Error(`Unsupported node-pty platform: ${platform}-${normalizedArch}`)
  }

  const packageName = `@lydell/node-pty-${platform}-${normalizedArch}`
  const relativePath = path.join('@lydell', `node-pty-${platform}-${normalizedArch}`, binaryName)
  return {
    packageName,
    binaryName,
    relativePath,
    absolutePath: path.join(nodeModulesDir, relativePath)
  }
}

function listInstalledNodePtyPackages(nodeModulesDir) {
  const scopeDir = path.join(nodeModulesDir, '@lydell')
  if (!fs.existsSync(scopeDir)) return []
  return fs
    .readdirSync(scopeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('node-pty-'))
    .map((entry) => `@lydell/${entry.name}`)
    .sort()
}

function assertNodePtyBinary({ platform, arch, nodeModulesDir, label = 'node_modules' }) {
  const expected = expectedNodePtyBinary({ platform, arch, nodeModulesDir })
  if (!fs.existsSync(expected.absolutePath)) {
    const installed = listInstalledNodePtyPackages(nodeModulesDir)
    throw new Error(
      [
        `Missing ${expected.packageName}/${expected.binaryName} in ${label}.`,
        `Expected: ${expected.absolutePath}`,
        `Installed node-pty binary packages: ${installed.length ? installed.join(', ') : '(none)'}`,
        'Install dependencies on the target platform with optional dependencies enabled before packaging.'
      ].join('\n')
    )
  }
  return expected
}

module.exports = {
  assertNodePtyBinary,
  expectedNodePtyBinary,
  listInstalledNodePtyPackages,
  normalizeArch
}
