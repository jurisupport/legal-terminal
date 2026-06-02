const path = require('path')
const { assertNodePtyBinary, normalizeArch } = require('./nodePtyBinary.cjs')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const arch = normalizeArch(context.arch)
  const nodeModulesDir = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules'
  )
  const expected = assertNodePtyBinary({
    platform: context.electronPlatformName,
    arch,
    nodeModulesDir,
    label: `packaged app (${context.electronPlatformName}-${arch})`
  })

  console.log(`[afterPack] Found ${expected.packageName}/${expected.binaryName}`)
}
