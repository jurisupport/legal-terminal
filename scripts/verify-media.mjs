import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, stat, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mediaSelectionKey, normalizeMediaSelection, mediaSelectionText, mediaMimeType, formatMediaTime } from '../src/shared/media.ts'
import { publishMedia } from './publish-media.mjs'

const selection = { sourcePath: 'ssh://sample/shorts/clip.mp4', versionId: 'first', time: 12.5, start: 12.3, end: 15.8 }
const restored = normalizeMediaSelection(JSON.parse(JSON.stringify(selection)))
assert.deepEqual(restored, selection, 'a remote selection must survive serialization')
assert.notEqual(mediaSelectionKey(selection), mediaSelectionKey({ ...selection, end: 16 }), 'different ranges remain distinct')
assert.notEqual(mediaSelectionKey(selection), mediaSelectionKey({ ...selection, versionId: 'second' }), 'different versions remain distinct')
for (const invalid of [{ time: NaN }, { time: Infinity }, { time: -1 }, { start: 20 }, { end: undefined }, { sourcePath: '' }]) {
  assert.equal(normalizeMediaSelection({ ...selection, ...invalid }), undefined)
}
assert.match(mediaSelectionText({ ...selection, capturePath: '/shorts/frame.jpg' }), /이미지를 실제 이미지 읽기 도구/)
assert.match(mediaSelectionText(selection), /전사문은 자동 첨부되지/)
assert.equal(normalizeMediaSelection({ ...selection, projectDir: '/shorts' }).projectDir, '/shorts')
assert.match(mediaSelectionText(selection), /고유한 새 파일명/)
assert.match(mediaSelectionText(selection), /\.legal-terminal\/media\.json/)
assert.equal(mediaMimeType('/test/쇼츠.MP4'), 'video/mp4')
assert.equal(mediaMimeType('/test/readme.md'), undefined)
assert.equal(formatMediaTime(59.9996), '1:00.000')

const root = await mkdtemp(join(tmpdir(), 'lt-media-publish-'))
try {
  await writeFile(join(root, 'finished.mp4'), 'first completed output')
  const first = await publishMedia(root, 'ffmpeg', 'finished.mp4', 'render.py')
  await writeFile(join(root, 'finished.mp4'), 'second completed output')
  const second = await publishMedia(root, 'remotion', 'finished.mp4', 'src/index.ts')
  assert.notEqual(first.completed.path, second.completed.path)
  assert.equal(await readFile(join(root, first.completed.path), 'utf8'), 'first completed output')
  assert.equal(await readFile(join(root, second.completed.path), 'utf8'), 'second completed output')
  assert.equal(await readFile(join(root, 'finished.mp4'), 'utf8'), 'second completed output', 'producer file survives publication')
  assert.deepEqual(JSON.parse(await readFile(join(root, '.legal-terminal/media.json'), 'utf8')), second)
  await assert.rejects(publishMedia(root, 'unknown', 'finished.mp4'))
  await assert.rejects(publishMedia(root, 'ffmpeg', '../outside.mp4'))
  await writeFile(join(root, 'empty.mp4'), '')
  await assert.rejects(publishMedia(root, 'ffmpeg', 'empty.mp4'), /empty/)
  assert.deepEqual(JSON.parse(await readFile(join(root, '.legal-terminal/media.json'), 'utf8')), second, 'failed output does not change completion marker')
  const unsafe = join(root, 'unsafe-project')
  const outside = join(root, 'outside')
  await mkdir(unsafe); await mkdir(outside)
  await writeFile(join(unsafe, 'finished.mp4'), 'completed')
  await symlink(outside, join(unsafe, '.legal-terminal'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(publishMedia(unsafe, 'ffmpeg', 'finished.mp4'), /inside the project/)
  await assert.rejects(stat(join(outside, 'media-versions')), { code: 'ENOENT' }, 'reject escaping control directory before creating output')
} finally { await rm(root, { recursive: true, force: true }) }
console.log('media selection persistence, version identity and FFmpeg/Remotion output publication verified')
