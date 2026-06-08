const fs = require('fs')
const path = require('path')

const BINARY_BY_PLATFORM = {
  darwin: 'claude',
  linux: 'claude',
  win32: 'claude.exe'
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

function expectedClaudeAgentSdkBinary({ platform, arch, nodeModulesDir }) {
  const normalizedArch = normalizeArch(arch)
  const binaryName = BINARY_BY_PLATFORM[platform]
  if (!binaryName) {
    throw new Error(`Unsupported Claude Agent SDK platform: ${platform}-${normalizedArch}`)
  }

  const packageName = `@anthropic-ai/claude-agent-sdk-${platform}-${normalizedArch}`
  const relativePath = path.join('@anthropic-ai', `claude-agent-sdk-${platform}-${normalizedArch}`, binaryName)
  return {
    packageName,
    binaryName,
    relativePath,
    absolutePath: path.join(nodeModulesDir, relativePath)
  }
}

function listInstalledClaudeAgentSdkPackages(nodeModulesDir) {
  const scopeDir = path.join(nodeModulesDir, '@anthropic-ai')
  if (!fs.existsSync(scopeDir)) return []
  return fs
    .readdirSync(scopeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('claude-agent-sdk-'))
    .map((entry) => `@anthropic-ai/${entry.name}`)
    .sort()
}

function assertClaudeAgentSdkBinary({ platform, arch, nodeModulesDir, label = 'node_modules' }) {
  const expected = expectedClaudeAgentSdkBinary({ platform, arch, nodeModulesDir })
  if (!fs.existsSync(expected.absolutePath)) {
    const installed = listInstalledClaudeAgentSdkPackages(nodeModulesDir)
    throw new Error(
      [
        `Missing ${expected.packageName}/${expected.binaryName} in ${label}.`,
        `Expected: ${expected.absolutePath}`,
        `Installed Claude Agent SDK binary packages: ${installed.length ? installed.join(', ') : '(none)'}`,
        'Install dependencies on the target platform with optional dependencies enabled before packaging.'
      ].join('\n')
    )
  }
  return expected
}

module.exports = {
  assertClaudeAgentSdkBinary,
  expectedClaudeAgentSdkBinary,
  listInstalledClaudeAgentSdkPackages,
  normalizeArch
}
