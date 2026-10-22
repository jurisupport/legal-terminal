import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '../src/main/projectStore.ts'

const directory = await mkdtemp(join(tmpdir(), 'legal-terminal-projects-'))
const file = join(directory, 'nested', 'projects.json')
const input = {
  name: 'A사 거래대금 회수',
  goal: '미수금 회수',
  nextAction: '가압류 자료 검토',
  notes: '본안과 집행의 공통 메모',
  status: 'active',
  cases: [
    { key: 'js:case-1', name: '본안', jsId: 'case-1' },
    { key: 'js:case-1', name: '본안 중복', jsId: 'case-1' },
    { key: 'folder:/drafts', name: '가압류', drafts: '/drafts', records: '/records' },
    { key: 'remote:office:case', name: '집행', profileId: 'office', remotePath: '/cases/집행' }
  ]
}

try {
  const store = new ProjectStore(file)
  assert.deepEqual(await store.list(), [])
  const created = await store.save(input)
  assert.equal(created.name, input.name)
  assert.equal(created.cases.length, 3, 'duplicate case links are removed')
  assert.equal(created.cases[0].name, '본안')
  assert.equal(created.cases[2].remotePath, '/cases/집행')
  assert.deepEqual(created.folders, [], 'omitted folder input defaults to an empty list')
  assert.equal('workspacePath' in created, false, 'legacy projects keep automatic workspaces')
  assert.ok(created.id)
  assert.deepEqual(await new ProjectStore(file).list(), [created], 'projects survive reopening the store')
  const { folders: _folders, ...legacyProject } = created
  const legacyText = JSON.stringify({ version: 1, projects: [legacyProject] })
  await writeFile(file, legacyText)
  assert.deepEqual(await store.list(), [created], 'older stored projects gain an empty folder list on read')
  assert.equal(await readFile(file, 'utf8'), legacyText, 'reading a legacy project does not rewrite its file')

  const updated = await store.save({ ...created, expectedUpdatedAt: created.updatedAt, status: 'completed', cases: [] })
  assert.equal(updated.createdAt, created.createdAt)
  assert.notEqual(updated.updatedAt, created.updatedAt)
  assert.equal(updated.status, 'completed')
  assert.deepEqual(updated.cases, [])
  await assert.rejects(store.save({ ...created, expectedUpdatedAt: created.updatedAt }), /변경되었습니다/)
  await assert.rejects(store.save({ ...updated }), /변경되었습니다/)
  await assert.rejects(store.remove(created.id, created.updatedAt), /변경되었습니다/)
  assert.deepEqual(await store.list(), [updated], 'stale writes and deletes leave data unchanged')

  const concurrent = await Promise.allSettled([
    store.save({ ...updated, expectedUpdatedAt: updated.updatedAt, notes: '첫 편집' }),
    store.save({ ...updated, expectedUpdatedAt: updated.updatedAt, notes: '다른 창 편집' })
  ])
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1)
  const additions = await Promise.all(Array.from({ length: 8 }, (_, index) => store.save({ ...input, name: `프로젝트 ${index}` })))
  assert.equal((await store.list()).length, 9, 'concurrent creates preserve every project')
  await Promise.all(additions.map((project) => store.remove(project.id, project.updatedAt)))
  const remaining = (await store.list())[0]
  await store.remove(remaining.id, remaining.updatedAt)
  assert.deepEqual(await new ProjectStore(file).list(), [])
  await assert.rejects(store.save({ ...remaining, expectedUpdatedAt: remaining.updatedAt }), /삭제되었거나/)

  for (const invalid of [
    { ...input, name: '  ' },
    { ...input, status: 'unknown' },
    { ...input, cases: null },
    { ...input, cases: [{ key: 'case', name: '사건', jsId: 123 }] },
    { ...input, cases: [{ key: '', name: '사건' }] },
    { ...input, notes: {} },
    { ...input, name: '가'.repeat(201) },
    { ...input, goal: '가'.repeat(4001) },
    { ...input, nextAction: '가'.repeat(4001) },
    { ...input, notes: '가'.repeat(50001) },
    { ...input, cases: Array.from({ length: 1001 }, (_, index) => ({ key: `case-${index}`, name: '사건', jsId: 'case' })) },
    { ...input, cases: [{ key: 'x'.repeat(4097), name: '사건', jsId: 'case' }] },
    { ...input, cases: [{ key: 'case', name: '사건', drafts: '/'.repeat(4097) }] },
    { ...input, cases: [{ key: 'case', name: '사건' }] },
    { ...input, cases: [{ key: 'case', name: '사건', jsId: '  ', drafts: '' }] },
    { ...input, cases: [{ key: 'case', name: '사건', profileId: 'office' }] },
    { ...input, cases: [{ key: 'case', name: '사건', remotePath: '/cases/집행' }] },
    { ...input, folders: null },
    ...['', '  ', 'relative/path', '~/folder', 'C:relative', '\\relative', 'ssh://', 'ssh://office', 'ssh:///folder', 'ssh://bad profile/folder', 'ssh://office\\folder/path', 'ssh://user@office/folder', 'ssh://office:22/folder', 'ssh://office?query/folder', 'ssh://office#fragment/folder', 'ssh://office%20name/folder', 'sftp://office/folder', 'SSH://office/folder', 'https://example.com/folder', 'file:///folder', '/folder\0file', 'ssh://office/folder\0file', '/'.repeat(4097), 123, {}].map((workspacePath) => ({ ...input, workspacePath })),
    { ...input, folders: [{ name: '', path: '/valid' }] },
    { ...input, folders: [{ name: '가'.repeat(4097), path: '/valid' }] },
    { ...input, folders: [{ name: '폴더', path: '/'.repeat(4097) }] },
    { ...input, folders: Array.from({ length: 1001 }, (_, index) => ({ name: '폴더', path: `/folder-${index}` })) },
    ...['', '  ', 'relative/path', '~/folder', 'C:relative', '\\relative', 'ssh://', 'ssh://office', 'ssh:///folder', 'ssh://bad profile/folder', 'https://example.com/folder', '/folder\0file'].map((path) => ({
      ...input, folders: [{ name: '폴더', path }]
    }))
  ]) await assert.rejects(store.save(invalid))
  assert.deepEqual(await store.list(), [], 'invalid input never modifies storage')

  const boundary = await store.save({
    ...input,
    name: '가'.repeat(200),
    goal: '가'.repeat(4000),
    nextAction: '가'.repeat(4000),
    notes: '가'.repeat(50000),
    cases: Array.from({ length: 1000 }, (_, index) => ({
      key: `case-${index}`, name: '사건', jsId: 'case', drafts: '  ', records: '', profileId: '', remotePath: ''
    })),
    folders: Array.from({ length: 1000 }, (_, index) => ({ name: '폴더', path: `/folder-${index}` }))
  })
  assert.equal(boundary.cases.length, 1000, 'input at the supported limits is accepted')
  assert.equal(boundary.folders.length, 1000)
  assert.deepEqual(boundary.cases[0], { key: 'case-0', name: '사건', jsId: 'case' }, 'empty optional sources are omitted')
  assert.deepEqual(await new ProjectStore(file).list(), [boundary])
  await store.remove(boundary.id, boundary.updatedAt)

  const referenceFolder = join(directory, '공통 자료')
  const referenceFile = join(referenceFolder, '원본.txt')
  await mkdir(referenceFolder)
  await writeFile(referenceFile, '원본 기록')
  const folderPaths = [
    referenceFolder,
    '/공통/가',
    'ssh://office/공통/가',
    'ssh://other/공통/가',
    '/',
    'ssh://office/',
    'C:\\',
    'C:\\자료\\',
    '\\\\server\\share\\'
  ]
  const folderProject = await store.save({
    ...input,
    cases: [],
    folders: [
      ...folderPaths.map((path) => ({ name: '컨텍스트 폴더', path })),
      { name: '로컬 중복', path: '/공통/가/'.normalize('NFD') },
      { name: '원격 중복', path: 'ssh://office/공통/가/'.normalize('NFD') },
      { name: '루트 중복', path: '///' },
      { name: '원격 루트 중복', path: 'ssh://office///' },
      { name: '드라이브 루트 중복', path: 'C:\\\\' },
      { name: '윈도 폴더 중복', path: 'C:\\자료' },
      { name: 'UNC 루트 중복', path: '\\\\server\\share' }
    ]
  })
  assert.deepEqual(folderProject.folders.map((folder) => folder.path), folderPaths,
    'folder dedup preserves roots, original paths and different remote profile identities')
  assert.deepEqual(await new ProjectStore(file).list(), [folderProject], 'folder references persist')
  await store.remove(folderProject.id, folderProject.updatedAt)
  assert.equal(await readFile(referenceFile, 'utf8'), '원본 기록', 'project removal never deletes referenced folders or files')

  let custom = await store.save({ ...input, workspacePath: referenceFolder + '/' })
  assert.equal(custom.workspacePath, referenceFolder, 'workspace paths are normalized on save')
  assert.deepEqual(await new ProjectStore(file).list(), [custom], 'custom workspaces survive reopening')
  const { workspacePath: _workspacePath, ...withoutWorkspace } = custom
  custom = await store.save({ ...withoutWorkspace, expectedUpdatedAt: custom.updatedAt, notes: '폴더 설정을 유지하는 메모 변경' })
  assert.equal(custom.workspacePath, referenceFolder, 'omitted workspace input preserves the current selection')
  await assert.rejects(store.save({ ...input, workspacePath: join(referenceFolder, '..', '공통 자료') }), /다른 프로젝트/)
  custom = await store.save({ ...custom, expectedUpdatedAt: custom.updatedAt, workspacePath: null })
  assert.equal('workspacePath' in custom, false, 'null explicitly restores automatic workspace management')
  assert.equal('workspacePath' in (await new ProjectStore(file).list())[0], false)
  const workspaceCreates = await Promise.allSettled([
    store.save({ ...input, workspacePath: referenceFolder }),
    store.save({ ...input, workspacePath: referenceFolder + '/' })
  ])
  assert.equal(workspaceCreates.filter((result) => result.status === 'fulfilled').length, 1, 'serialized creates prevent duplicate workspace ownership')
  assert.equal(workspaceCreates.filter((result) => result.status === 'rejected').length, 1)
  const windows = await store.save({ ...input, workspacePath: 'C:\\자료\\하위\\..\\프로젝트\\' })
  assert.equal(windows.workspacePath, 'C:\\자료\\프로젝트')
  await assert.rejects(store.save({ ...input, workspacePath: 'c:/자료/프로젝트/' }), /다른 프로젝트/)
  const unc = await store.save({ ...input, workspacePath: '\\\\server\\share\\' })
  assert.equal(unc.workspacePath, '\\\\server\\share\\')
  await assert.rejects(store.save({ ...input, workspacePath: '\\\\SERVER\\SHARE' }), /다른 프로젝트/)
  let remote = await store.save({ ...input, workspacePath: 'ssh://office/자료/하위/../Case/' })
  assert.equal(remote.workspacePath, 'ssh://office/자료/Case', 'remote paths normalize without losing profile or case')
  assert.equal((await new ProjectStore(file).list()).find((entry) => entry.id === remote.id).workspacePath, remote.workspacePath)
  await assert.rejects(store.save({ ...input, workspacePath: 'ssh://office/자료//Case' }), /다른 프로젝트/)
  for (const workspacePath of ['ssh://other/자료/Case', 'ssh://Office/자료/Case', 'ssh://office/자료/case', 'ssh://office/', 'ssh://office/자료/Case'.normalize('NFD')]) {
    assert.equal((await store.save({ ...input, workspacePath })).workspacePath, workspacePath, 'server identities, case-sensitive remote paths and root are distinct')
  }
  const { workspacePath: _remoteWorkspace, ...remoteWithoutWorkspace } = remote
  remote = await store.save({ ...remoteWithoutWorkspace, expectedUpdatedAt: remote.updatedAt, notes: '원격 작업 폴더 유지' })
  assert.equal(remote.workspacePath, 'ssh://office/자료/Case')
  remote = await store.save({ ...remote, expectedUpdatedAt: remote.updatedAt, workspacePath: null })
  assert.equal('workspacePath' in remote, false, 'remote workspace settings can reset to automatic')
  const remoteCreates = await Promise.allSettled([
    store.save({ ...input, workspacePath: 'ssh://office/자료/Case' }),
    store.save({ ...input, workspacePath: 'ssh://office/자료/Case/' })
  ])
  assert.equal(remoteCreates.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(remoteCreates.filter((result) => result.status === 'rejected').length, 1)
  for (const entry of await store.list()) await store.remove(entry.id, entry.updatedAt)
  assert.equal(await readFile(referenceFile, 'utf8'), '원본 기록', 'changing, resetting and deleting workspace settings never touches files')

  const profiles = {
    primary: { host: 'Office.EXAMPLE', user: 'lawyer' },
    alias: { host: 'office.example', user: 'lawyer', port: 22 },
    differentHost: { host: 'other.example', user: 'lawyer', port: 22 },
    differentUser: { host: 'office.example', user: 'assistant', port: 22 },
    differentPort: { host: 'office.example', user: 'lawyer', port: 2222 }
  }
  const workspaceIdentity = (path) => {
    const match = /^ssh:\/\/([^/]+)(\/.*)$/s.exec(path)
    const profile = match && profiles[match[1]]
    return profile ? JSON.stringify(['ssh', profile.host.toLowerCase(), profile.user, profile.port ?? 22, match[2]]) : undefined
  }
  let primary = await store.save({ ...input, workspacePath: 'ssh://primary/Projects/Case' })
  await assert.rejects(store.save({ ...input, workspacePath: 'ssh://alias/Projects/Case/' }, workspaceIdentity), /다른 프로젝트/,
    'a profile alias cannot claim the same server, user, port and workspace')
  primary = await store.save({ ...primary, expectedUpdatedAt: primary.updatedAt, notes: '서버 별칭 중복 검사 후 메모 유지' }, workspaceIdentity)
  assert.equal(primary.workspacePath, 'ssh://primary/Projects/Case', 'the current project can retain its own workspace')
  for (const profileId of ['differentHost', 'differentUser', 'differentPort']) {
    const workspacePath = `ssh://${profileId}/Projects/Case`
    assert.equal((await store.save({ ...input, workspacePath }, workspaceIdentity)).workspacePath, workspacePath,
      'different hosts, users and ports do not share native workspace identity')
  }
  const aliasCreates = await Promise.allSettled([
    store.save({ ...input, workspacePath: 'ssh://primary/Projects/Concurrent' }, workspaceIdentity),
    store.save({ ...input, workspacePath: 'ssh://alias/Projects/Concurrent/' }, workspaceIdentity)
  ])
  assert.equal(aliasCreates.filter((result) => result.status === 'fulfilled').length, 1, 'alias checks happen inside the serialized save')
  assert.equal(aliasCreates.filter((result) => result.status === 'rejected').length, 1)
  await store.save({ ...input, workspacePath: referenceFolder }, workspaceIdentity)
  await assert.rejects(store.save({ ...input, workspacePath: referenceFolder + '/' }, workspaceIdentity), /다른 프로젝트/,
    'undefined identity retains the existing local path key')
  await store.save({ ...input, workspacePath: 'ssh://unknown/Projects/Case' }, workspaceIdentity)
  await assert.rejects(store.save({ ...input, workspacePath: 'ssh://unknown/Projects/Case/' }, workspaceIdentity), /다른 프로젝트/,
    'unknown profiles retain URI-based duplicate protection')
  for (const entry of await store.list()) await store.remove(entry.id, entry.updatedAt)

  for (const corrupt of ['{broken', '', '{"version":2,"projects":[]}', '{"version":1,"projects":[{}]}',
    JSON.stringify({ version: 1, projects: [created, created] }),
    JSON.stringify({ version: 1, projects: [{ ...created, cases: [{ key: 'case', name: '사건' }] }] }),
    JSON.stringify({ version: 1, projects: [{ ...created, folders: [{ name: '폴더', path: 'relative' }] }] }),
    JSON.stringify({ version: 1, projects: [{ ...created, workspacePath: 'ssh://office' }] })]) {
    await writeFile(file, corrupt)
    await assert.rejects(store.list(), /손상되었거나/)
    await assert.rejects(store.save(input), /손상되었거나/)
    await assert.rejects(store.remove(created.id), /손상되었거나/)
    assert.equal(await readFile(file, 'utf8'), corrupt, 'corrupt files are preserved for recovery')
  }

  await rm(file)
  await mkdir(file)
  await assert.rejects(store.list(), /읽을 수 없습니다/)
  await assert.rejects(store.save(input), /읽을 수 없습니다/)
  await assert.rejects(store.remove(created.id), /읽을 수 없습니다/)
  assert.deepEqual(await readdir(file), [], 'unreadable store paths are untouched')
  await rm(file, { recursive: true })
  await store.save(input)
  assert.equal((await store.list()).length, 1, 'the queue recovers after a rejected operation')
  assert.deepEqual((await readdir(join(directory, 'nested'))).sort(), ['projects.json'], 'atomic writes leave no temporary files')
  console.log('project store ok: persistence, case/folder links, local/SSH/automatic workspaces, profile and endpoint identity, duplicate ownership, legacy data, CRUD, conflicts, concurrency, validation, corruption safety')
} finally {
  await rm(directory, { recursive: true, force: true })
}
