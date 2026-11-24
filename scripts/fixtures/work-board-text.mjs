import assert from 'node:assert/strict'
import { mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function verifyBoardText(read, disk, remoteBase, bytesTransferred) {
  const folder = join(await realpath(disk), '문서 본문 검증')
  await mkdir(folder)
  const file = name => join(folder, name)
  const target = name => remoteBase ? remoteBase + '/문서 본문 검증/' + name : file(name)
  const pageBytes = 256 * 1024
  for (const encoding of ['utf8', 'utf8-bom', 'utf16le', 'utf16be']) {
    const name = encoding + '.md'
    const utf16 = encoding.startsWith('utf16')
    const prefix = 'a'.repeat(utf16 ? pageBytes / 2 - 2 : pageBytes - (encoding === 'utf8-bom' ? 5 : 2))
    const content = prefix + '😄한글\ufeff본문'
    const bytes = utf16 ? Buffer.concat([Buffer.from([0xff,0xfe]), Buffer.from(content,'utf16le')]) :
      Buffer.concat([encoding === 'utf8-bom' ? Buffer.from([0xef,0xbb,0xbf]) : Buffer.alloc(0),Buffer.from(content)])
    if (encoding === 'utf16be') bytes.swap16()
    await writeFile(file(name),bytes)
    const a = await read(target(name),0)
    assert.equal(a.size,bytes.length)
    assert.equal(a.text,prefix)
    assert.equal(a.nextOffset,pageBytes-2)
    const b = await read(target(name),a.nextOffset)
    assert.equal(b.nextOffset,null)
    assert.equal(a.text + b.text,content)
    await assert.rejects(read(target(name),a.nextOffset + (utf16 ? 2 : 1)), /인코딩|위치/)
    if (encoding !== 'utf8') await assert.rejects(read(target(name),1),/위치/)
  }
  await writeFile(file('boundary.MDX'),'a'.repeat(pageBytes) + '\ufeff다음 쪽')
  const boundary = await read(target('boundary.MDX'),pageBytes)
  assert.equal(boundary.text,'\ufeff다음 쪽','only an actual file BOM may be stripped')
  await writeFile(file('empty.txt'),'')
  assert.deepEqual(await read(target('empty.txt'),0),{text:'',size:0,nextOffset:null})
  for (const offset of [-1,1,NaN,1.25,Number.MAX_SAFE_INTEGER+1]) {
    await assert.rejects(read(target('empty.txt'),offset),/위치/)
  }
  await writeFile(file('raw.csv'),Buffer.from([97,0,98]))
  await assert.rejects(read(target('raw.csv'),0),/텍스트/)
  await writeFile(file('odd.txt'),Buffer.from([0xff,0xfe,0x41]))
  await assert.rejects(read(target('odd.txt'),0),/인코딩/)
  await writeFile(file('invalid.json'),Buffer.from([0xff,0xff]))
  await assert.rejects(read(target('invalid.json'),0),/인코딩/)
  await mkdir(file('directory.txt'))
  await assert.rejects(read(target('directory.txt'),0),/파일/)
  await assert.rejects(read(target('not-markdown.pdf'),0),/형식/)

  // A sparse file proves the last page can be sought directly without downloading the intervening data.
  const size = 64 * 1024 * 1024
  const handle = await open(file('long.markdown'),'wx')
  try {
    await handle.write(Buffer.alloc(pageBytes + 1,0x61),0,pageBytes + 1,0)
    await handle.write(Buffer.from('끝'),0,3,size-3)
  } finally { await handle.close() }
  const before = bytesTransferred?.()
  const start = await read(target('long.markdown'),0)
  assert.equal(start.text.length,pageBytes)
  assert.equal(start.nextOffset,pageBytes)
  assert.deepEqual(await read(target('long.markdown'),size-3),{text:'끝',size,nextOffset:null})
  assert.deepEqual(await read(target('long.markdown'),size),{text:'',size,nextOffset:null})
  if (bytesTransferred) assert.ok(bytesTransferred() - before < 2 * pageBytes, 'SFTP must transfer only requested pages')
  console.log('문서 본문 페이지 · UTF-8/UTF-16 경계·손상·빈 파일·대용량 끝부분 직접 읽기 확인')
}
