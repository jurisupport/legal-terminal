// Run only after the producer exits successfully. Publishing never overwrites the producer's file.
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, rename, writeFile, rm, realpath } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { resolve, relative, isAbsolute, join, extname } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function publishMedia(projectDir, engine, output, entry) {
  if (!['ffmpeg', 'remotion'].includes(engine)) throw new Error('engine must be ffmpeg or remotion')
  const root = await realpath(projectDir)
  const source = await realpath(resolve(root, output))
  const within = (path) => {
    const rel = relative(root, path)
    return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))
  }
  if (!within(source)) throw new Error('output must be inside the project')
  const before = await stat(source)
  if (!before.isFile() || before.size === 0) throw new Error('output is empty or not a file')
  const version = randomUUID()
  const control = join(root, '.legal-terminal')
  await mkdir(control, { recursive: true })
  if (!within(await realpath(control))) throw new Error('.legal-terminal must remain inside the project')
  const directory = join(control, 'media-versions')
  await mkdir(directory, { recursive: true })
  if (!within(await realpath(directory))) throw new Error('media-versions must remain inside the project')
  const path = join(directory, version + extname(source))
  const partial = path + '.part'
  const marker = join(control, `media.${version}.tmp`)
  try {
    await pipeline(createReadStream(source), createWriteStream(partial, { flags: 'wx' }))
    const after = await stat(source)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('output changed while publishing')
    await rename(partial, path)
    const manifest = {
      version: 1, engine, ...(entry ? { entry } : {}),
      completed: { version, path: relative(root, path).split('\\').join('/'), completedAt: new Date().toISOString() }
    }
    await writeFile(marker, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
    await rename(marker, join(control, 'media.json'))
    return manifest
  } catch (error) {
    await Promise.all([rm(partial, { force: true }), rm(marker, { force: true }), rm(path, { force: true })])
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [project, engine, output, entry] = process.argv.slice(2)
  if (!project || !engine || !output) {
    console.error('Usage: node scripts/publish-media.mjs <project-dir> <ffmpeg|remotion> <completed-output> [source-entry]')
    process.exitCode = 1
  } else {
    try { console.log(JSON.stringify(await publishMedia(project, engine, output, entry))) }
    catch (error) { console.error(error.message); process.exitCode = 1 }
  }
}
