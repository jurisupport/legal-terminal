import assert from 'node:assert/strict'
import { createHash,randomUUID } from 'node:crypto'
import { mkdir,readFile,readdir,rm,symlink,utimes,writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const hash = value => createHash('sha256').update(value).digest('hex')
const busy = err => err.code === 'BOARD_BUSY'
const changed = err => err.code === 'BOARD_OWNER_CHANGED'
export async function verifyBoardStorage(Store, root, disk) {
  const a = new Store(root), b = new Store(root), c = new Store(root)
  await a.init()
  assert.equal(await a.claimOwner('a'), true)
  await assert.rejects(b.takeOwnership('a','b',async()=>{throw Error('guard declined')}),/guard declined/)
  assert.equal(await a.readText('_배분기'),'a')
  let enter, release
  const entered = new Promise(ok=>{enter=ok})
  const hold = new Promise(ok=>{release=ok})
  const oldWriter = a.withOwner('a',async()=>{
    enter()
    await hold
    await a.writeText('_배분기-활동','late write')
  })
  await entered
  await assert.rejects(b.takeOwnership('a','b',async()=>{}),busy)
  // Simulate a disconnected holder resuming after a human has confirmed its device stopped.
  const lock = join(disk,'.work-board-lock')
  const [firstNonce] = await readdir(lock)
  await utimes(join(lock,firstNonce),new Date(0),new Date(0))
  await assert.rejects(b.withOwner('a',async()=>{},'b'),busy)
  await b.takeOwnership('a','b',async()=>{})
  await assert.rejects(c.takeOwnership('a','c',async()=>{}),changed)
  await b.withOwner('b',async()=>{
    release()
    await assert.rejects(oldWriter,changed)
    assert.equal((await readdir(lock)).length,1,'old release cannot remove the new holder')
  })
  assert.equal(await a.readText('_배분기-활동'),null)
  await assert.rejects(a.withOwner('a',async()=>{}),changed)
  // Crash after ownership marker commit, before releasing the previous generation's nonce.
  await mkdir(lock)
  const orphan = join(lock,[randomUUID(),hash('foreign'),1,hash('a'),hash('b')].join('_'))
  await writeFile(orphan,'')
  await utimes(orphan,new Date(0),new Date(0))
  await c.takeOwnership('b','c',async()=>{})
  assert.equal(await c.readText('_배분기'),'c')
  const contenders = await Promise.allSettled([a.takeOwnership('c','a',async()=>{}), b.takeOwnership('c','b',async()=>{})])
  assert.equal(contenders.filter(r=>r.status === 'fulfilled').length,1)
  const owner = await c.readText('_배분기')
  await assert.rejects(c.withOwner(owner, async()=>{
    await writeFile(join(disk,'_배분기'),'out-of-band')
    await c.writeText('_배분기-활동','stale operation')
  }),changed)
  await writeFile(join(disk,'_배분기'),owner)
  const now = new Date().toISOString()
  const task = {id:'edit',cwd:root,title:'원문',body:'초기',status:'blocked',order:0,attempts:0,log:[],createdAt:now,updatedAt:now}
  await c.save(task)
  const detail = {report:'이전 보고',review:'이전 검토'}
  const evidence = (key) => task.id+'.'+key+'.md'
  for (const [key,content] of Object.entries(detail)) await c.writeText(evidence(key),content)
  await c.withOwner(owner, async()=>{
    const [source] = await c.list(true)
    await assert.rejects(c.saveEdit({...source,body:'수정'}, {...detail,review:'다른 검토'}),/변경/)
    await c.saveEdit({...source,body:'수정',editedNeedsRun:true},detail)
    assert.ok((await c.list(true))[0].editedNeedsRun)
    assert.equal(await c.readText(evidence('review')),null)
    assert.equal(await readFile(join(disk,'_보관',(await readdir(join(disk,'_보관'))).find(n=>n.endsWith('.review.md'))),'utf8'),detail.review)
    await c.writeText(evidence('report'),'새 보고')
    await c.writeText(evidence('review'),'새 검토')
    await assert.rejects(c.archive('edit',detail),/변경/)
    const archive = join(disk,'_보관','edit')
    await mkdir(archive)
    await writeFile(join(archive,'edit.md'),'기존 보관 자료')
    await assert.rejects(c.archive('edit'),/다른 보관/)
    assert.equal(await readFile(join(archive,'edit.md'),'utf8'),'기존 보관 자료')
    await rm(archive,{recursive:true})
    await c.archive('edit',{report:'새 보고',review:'새 검토'})
    assert.deepEqual(await c.list(true),[])
    assert.equal(await readFile(join(archive,'edit.report.md'),'utf8'),'새 보고')
    assert.equal(await readFile(join(archive,'edit.review.md'),'utf8'),'새 검토')
    // Replay the post-commit/pre-cleanup state and verify resumability and hidden evidence.
    for (const name of ['edit.md','edit.report.md','edit.review.md']) await writeFile(join(disk,name),await readFile(join(archive,name)))
    assert.deepEqual(await a.list(true),[])
    assert.equal(await a.readText('edit.report.md'),null)
    await c.archive('edit')
    await c.archive('edit')
    await assert.rejects(c.save(task),/보관/)
    await assert.rejects(c.archive('../escape'))
    await writeFile(join(disk,'outside'),'보호할 자료')
    await symlink(join(disk,'outside'),join(disk,'edit.review.md'))
    await assert.rejects(c.archive('edit'))
    assert.equal(await readFile(join(disk,'outside'),'utf8'),'보호할 자료')
  })
}
