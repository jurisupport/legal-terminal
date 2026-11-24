import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

// The SSH test exposes its temporary directory through a real SFTP channel.
export async function verifyBoardDocuments(board, id, workspace, disk, store) {
  const docs = await mkdtemp(join(disk, 'board-documents-'))
  const outside = await mkdtemp(join(dirname(disk), basename(disk) + '-outside-'))
  const original = (await board.detail(id)).report
  const reportFile = id + '.report.md'
  const subdir = basename(docs)
  const listed = name => workspace.replaceAll('\\', '/').replace(/\/$/, '') + '/' + subdir + '/' + name
  const expected = async name => (workspace.startsWith('ssh://') ? workspace.slice(0, workspace.indexOf('/', 6)) : '') + await realpath(join(docs,name))
  try {
    await writeFile(join(docs, 'result.md'), '검토 결과')
    const rawAbsolute = join(docs, '절대 경로.md')
    await writeFile(rawAbsolute, '절대 경로 산출물')
    await writeFile(join(docs, 'unlisted.md'), '보고서 미등재')
    await mkdir(join(docs, 'folder.pdf'))
    await writeFile(join(outside, 'private.md'), '다른 사건 자료')
    await symlink(outside, join(docs, 'outside'), 'junction')
    await mkdir(join(docs, 'inside'))
    await writeFile(join(docs, 'inside', 'nested.md'), '폴더 내부 결과')
    await symlink(join(docs, 'inside'), join(docs, 'alias'), 'junction')
    const names = ['result.md', 'folder.pdf', 'outside/private.md', 'alias/nested.md', 'missing.md', 'disguised.md', 'pipe.md']
    const report = '## 결재 대상 문서\n\n' + names.map(name => '- `' + subdir + '/' + name + '`').join('\n')
    await store.writeText(reportFile, report + '\n산출물 · ' + rawAbsolute)
    assert.equal(await board.documentPath(id, listed('result.md')), await expected('result.md'))
    assert.equal(await board.documentPath(id, listed('절대 경로.md')), await expected('절대 경로.md'))
    assert.equal(await board.documentPath(id, listed('alias/nested.md')), await expected('inside/nested.md'))
    await assert.rejects(board.documentPath(id, listed('unlisted.md')), /현재 보고서/)
    await assert.rejects(board.documentPath(id, listed('outside/private.md')), /폴더 밖/)
    await assert.rejects(board.documentPath(id, listed('folder.pdf')), /파일/)
    await assert.rejects(board.documentPath(id, listed('missing.md')))
    if (workspace.startsWith('ssh://')) {
      await assert.rejects(board.documentPath(id, listed('result.md').replace(/^ssh:\/\/[^/]+/u, 'ssh://other')), /현재 보고서/)
    }
    if (process.platform !== 'win32') {
      await writeFile(join(docs, 'payload.sh'), 'fixture')
      await symlink(join(docs, 'payload.sh'), join(docs, 'disguised.md'))
      await assert.rejects(board.documentPath(id, listed('disguised.md')), /형식/)
      execFileSync('mkfifo', [join(docs, 'pipe.md')])
      await assert.rejects(board.documentPath(id, listed('pipe.md')), /파일/)
    }
    await store.writeText(reportFile, '산출물 목록 변경')
    await assert.rejects(board.documentPath(id, listed('result.md')), /현재 보고서/)
  } finally {
    await store.writeText(reportFile, original)
    await rm(docs, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
}
