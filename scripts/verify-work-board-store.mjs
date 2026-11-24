import { verifyBoardText } from './fixtures/work-board-text.mjs'
import { readBoardDocumentText } from '../src/main/workBoardDocumentText.ts'
import { verifyBoardStorage } from './fixtures/work-board-storage.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkBoardStore } from '../src/main/workBoardStore.ts'

const directory = await mkdtemp(join(tmpdir(), 'legal-board-'))
try {
  await verifyBoardText(readBoardDocumentText,directory)
  const board = new WorkBoardStore(join(directory, '_업무지시'))
  await board.init()
  assert.match(await board.readText('_보고서양식.md'), /결재 요청 사항/)
  assert.ok((await board.teams()).some(t => t.agents.includes('compliance')))
  await board.writeText('_보고서양식.md', '직접 편집')
  await board.init()
  assert.equal(await board.readText('_보고서양식.md'), '직접 편집')
  const owners = await Promise.all([board.claimOwner('one'), board.claimOwner('two')])
  assert.equal(owners.filter(Boolean).length, 1)
  assert.equal(await board.claimOwner(owners[0] ? 'one' : 'two'), true)
  const id = '20261124-001'
  const source = `---
id: ${id}
title: 검토
cwd: /tmp/case
due: 2026-11-28
agent: sample  # 직접 지정
depends_on: [20261124-000]
status: queued
---
내용
`
  await writeFile(join(board.root, id + '.md'), source)
  const [task] = await board.list()
  assert.equal(task.due, '2026-11-28')
  assert.equal(task.approval, 'required')
  assert.equal(task.agent, 'sample')
  assert.deepEqual(task.depends_on, ['20261124-000'])
  task.status = 'done'
  await board.save(task)
  const [reopened] = await new WorkBoardStore(board.root).list()
  assert.deepEqual(reopened, task)
  await board.writeText(id + '.report.md', '보고')
  await board.writeText(id + '.review.md', '통과')
  await board.writeText('_일일보고/2026-11-24.html', '<html></html>')
  assert.equal(await board.readText('_일일보고/2026-11-24.html'), '<html></html>')
  assert.equal((await board.list()).length, 1)
  await writeFile(join(board.root, id + '.md'), source)
  await assert.rejects(board.save(task), /변경/)
  await assert.rejects(board.save({...task, id:'../escape'}))
  await writeFile(join(board.root, 'x.md'), source)
  assert.equal((await board.list()).length, 1)
  assert.match(board.warnings.join(' '), /x.md.*파일명/)
  await board.writeText('teams.yaml', 'teams: [broken')
  assert.deepEqual(await board.teams(), [])
  assert.match(board.warnings.join(' '), /teams.yaml/)
  await assert.rejects(board.readText('../outside.md'))
  await symlink(join(directory, 'outside'), join(board.root, 'bad.md'))
  await assert.rejects(board.writeText('bad.md', 'outside'))
  await assert.rejects(readFile(join(directory, 'outside')), {code: 'ENOENT'})
  await verifyBoardStorage(WorkBoardStore,join(directory,'인계'),join(directory,'인계'))
  console.log('업무지시 저장·재시작·충돌·배분기 소유권·경로 보호 확인')
} finally {
  await rm(directory, {recursive: true, force: true})
}
