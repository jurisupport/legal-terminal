import { verifyBoardText } from './fixtures/work-board-text.mjs'
import { readBoardDocumentText } from '../src/main/workBoardDocumentText.ts'
import { verifyBoardStorage } from './fixtures/work-board-storage.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkBoardStore, unreadReportReceipt } from '../src/main/workBoardStore.ts'

const directory = await mkdtemp(join(tmpdir(), 'legal-board-'))
try {
  await verifyBoardText(readBoardDocumentText,directory)
  const board = new WorkBoardStore(join(directory, '_업무지시'))
  await board.init()
  assert.match(await board.readText('_보고서양식.md'), /결재 요청 사항/)
  // Departments belong to the user: a new board starts without any, and legacy files without a lead still load.
  assert.deepEqual(await board.teams(), [])
  await board.writeText('teams.yaml', 'teams:\n  - {name: 법무팀, color: "#376ac6", agents: [contract-review]}\n')
  assert.deepEqual(await board.teams(), [{ name: '법무팀', color: '#376ac6', agents: ['contract-review'] }])
  assert.deepEqual(await board.saveTeams([{ name: ' 송무팀 ', color: '#148369', lead: 'lead', agents: ['fact', 'fact'] }]),
    [{ name: '송무팀', color: '#148369', lead: 'lead', agents: ['fact'] }])
  assert.deepEqual(await board.teams(), [{ name: '송무팀', color: '#148369', lead: 'lead', agents: ['fact'] }])
  await assert.rejects(board.saveTeams([{ name: '', color: '#148369', agents: [] }]), /부서 이름/)
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
  // An old completed file stays unmodified even if a report already exists.
  const receipts = new WorkBoardStore(join(directory, '보고서 확인'))
  await receipts.init()
  const legacy = {...task, status:'done', approval:'none'}
  await receipts.save(legacy)
  await receipts.writeText(id+'.report.md','기존 업무 보고')
  const archivedSource = await readFile(join(receipts.root,id+'.md'),'utf8')
  assert.equal((await receipts.list())[0].reportReceipt,undefined)
  assert.equal(await readFile(join(receipts.root,id+'.md'),'utf8'),archivedSource)
  await assert.rejects(receipts.save({...legacy,reportReceipt:{state:'read',digest:'invalid'}}), /확인 기록/)
  const digest = unreadReportReceipt('기존 업무 보고').digest
  await receipts.save({...legacy, reportReceipt:{state:'read',digest}})
  assert.deepEqual((await new WorkBoardStore(receipts.root).list())[0].reportReceipt,{state:'read',digest})
  await receipts.writeText(id+'.report.md','수정된 업무 보고')
  assert.deepEqual((await receipts.readTask(id)).reportReceipt,unreadReportReceipt('수정된 업무 보고'))
  await receipts.writeText(id+'.report.md','## 할 일 조회 확인 필요\n범위를 선택하세요.')
  assert.equal((await receipts.list())[0].reportReceipt,undefined)
  const origin = {id:'original',title:'원 지시',body:'여러 줄\n원문',report:'## 결론\n' + '인용 "자료"'}
  const linkedTask = {...legacy,id:'follow-up',followUp:origin}
  await receipts.save(linkedTask)
  assert.deepEqual((await new WorkBoardStore(receipts.root).readTask(linkedTask.id)).followUp,origin)
  for (const invalid of [{...origin,id:'../other'},{...origin,id:linkedTask.id},{...origin,allowed_tools:['Bash']},
      {...origin,followUp:origin},{...origin,report:42},{...origin,body:'가'.repeat(160_001)}]) {
    await assert.rejects(receipts.save({...linkedTask,followUp:invalid}),/원 지시/)
  }
  await verifyBoardStorage(WorkBoardStore,join(directory,'인계'),join(directory,'인계'))
  console.log('업무지시 저장·재시작·충돌·배분기 소유권·경로 보호 확인')
} finally {
  await rm(directory, {recursive: true, force: true})
}
