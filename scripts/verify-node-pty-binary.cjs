#!/usr/bin/env node

const path = require('path')
const { assertNodePtyBinary } = require('../build/nodePtyBinary.cjs')

function readArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const platform = readArg('platform', process.platform)
const arch = readArg('arch', process.arch)
const nodeModulesDir = path.resolve(readArg('node-modules', 'node_modules'))

try {
  const expected = assertNodePtyBinary({
    platform,
    arch,
    nodeModulesDir,
    label: `${platform}-${arch} install`
  })
  console.log(`Found ${expected.packageName}/${expected.binaryName}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
