import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { basename,join } from 'node:path'
import { tmpdir } from 'node:os'

export async function verifyBoardDownloads(board,id,workspace,disk,store,api,setDialog) {
  const docs = await mkdtemp(join(disk,'첨부-'))
  const downloads = await mkdtemp(join(tmpdir(),'lt-downloads-'))
  const relative = name => basename(docs)+'/'+name
  const listed = name => workspace.replaceAll('\\','/')+'/'+relative(name)
  const original = (await board.detail(id)).report
  const reportFile = id+'.report.md'
  const win = {}
  let response, dialogs = 0
  const pick = filePath => { response = () => ({filePath,canceled:!filePath}) }
  setDialog(async (parent,options) => {
    assert.equal(parent,win)
    assert.ok(options.defaultPath && !options.defaultPath.startsWith('ssh://'))
    dialogs++
    return response()
  })
  const artifact = (name,selected = board) => api.downloadBoardDocument(selected,id,listed(name),win)
  const report = () => api.downloadBoardReport(board,id,win)
  const contents = new Map([
    ['검토.html',Buffer.from('\ufeff<html>\r\n<script>ignoredAsBytes()</script>\r\n한글</html>')],
    ['요약.md',Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('본문\r\n','utf16le')])],
    ['원본.pdf',Buffer.alloc(800_000,0xdc)],['빈 자료.txt',Buffer.alloc(0)]
  ])
  const allow = '## 결재 대상 문서\n\n'+[...contents.keys()].map(n=>'- `'+relative(n)+'`').join('\n')
  try {
    for (const [name,bytes] of contents) await writeFile(join(docs,name),bytes)
    await store.writeText(reportFile,allow)
    pick(null)
    await assert.rejects(artifact('다른 자료.pdf'),/보고서/)
    assert.equal(dialogs,0)
    assert.equal(await artifact('검토.html'),false)
    assert.equal(dialogs,1)
    for (const [name,bytes] of contents) {
      const target = join(downloads,name)
      pick(target)
      if (name === '원본.pdf') await writeFile(target,'사용자가 교체하기로 한 이전 파일')
      assert.equal(await artifact(name),true)
      assert.deepEqual(await readFile(target),bytes)
    }
    if (!workspace.startsWith('ssh://')) {
      const race = join(downloads,'동시 저장.md')
      pick(race)
      await assert.rejects(artifact('요약.md'),{code:'EEXIST'})
      assert.equal(await readFile(race,'utf8'),'다른 사용자의 저장')
      const failure = join(downloads,'저장 실패.md')
      pick(failure)
      await assert.rejects(artifact('요약.md'),/fixture blocked publication/)
      await assert.rejects(readFile(failure),{code:'ENOENT'})
    }
    const name = '검토.html'
    pick(join(docs,name))
    await assert.rejects(artifact(name),/원본/)
    assert.deepEqual(await readFile(join(docs,name)),contents.get(name))
    const other = join(disk,'보드대상-테스트')
    const boardDisk = board.folder.startsWith('ssh://') ? board.folder.slice(board.folder.indexOf('/',6)) : board.folder
    pick(join(boardDisk,'other-task.md'))
    await assert.rejects(artifact(name),/보드/)
    await assert.rejects(readFile(join(boardDisk,'other-task.md')),{code:'ENOENT'})
    const protectedFile = join(downloads,'유지할 파일')
    await writeFile(protectedFile,'원래 내용')
    if (process.platform !== 'win32') {
      await symlink(protectedFile,other)
      try { pick(other); await assert.rejects(artifact(name),/일반 파일/) }
      finally { await rm(other,{force:true}) }
    }
    // Simulate revocation between copying and final publication, after bytes have reached staging.
    let checks = 0
    const revoked = {folder:board.folder, async documentPath(...args) {
      if (++checks === 3) await store.writeText(reportFile,'첨부 대상 변경')
      return board.documentPath(...args)
    }}
    pick(protectedFile)
    await assert.rejects(artifact(name,revoked),/현재 보고서/)
    assert.equal(await readFile(protectedFile,'utf8'),'원래 내용')
    assert.ok(!(await readdir(downloads)).some(n => n.startsWith('.legal-download-')))
    const markdown = '\ufeff## 검토 보고서\r\n\r\n한글과 **서식**\r\n'
    await store.writeText(reportFile,markdown)
    pick(null)
    assert.equal(await report(),false)
    pick(join(downloads,'보고.md'))
    assert.equal(await report(),true)
    assert.deepEqual(await readFile(join(downloads,'보고.md')),Buffer.from(markdown))
    for (const diagnostic of ['','## 할 일 조회 확인 필요\n\n로그인을 확인해 주세요.','## 결재 필요\n\n권한 요청']) {
      await store.writeText(reportFile,diagnostic)
      const calls = dialogs
      await assert.rejects(report(),/보고서/)
      assert.equal(dialogs,calls)
    }
    console.log('결재 문서·보고서 다운로드 · 원본 바이트·취소·재검증·교체 실패 시 원본 보존 확인')
  } finally {
    setDialog(undefined)
    await store.writeText(reportFile,original)
    await rm(docs,{recursive:true,force:true})
    await rm(downloads,{recursive:true,force:true})
  }
}
