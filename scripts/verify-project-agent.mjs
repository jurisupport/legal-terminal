import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request as httpRequest } from 'node:http'
import { ProjectStore } from '../src/main/projectStore.ts'
import { configureProjectAgent, getProjectWorkspace, getProjectAgentContext, forwardProjectMcp, acquireProjectMcp, releaseProjectMcp, disposeProjectMcp } from '../src/main/projectAgent.ts'

const root = await mkdtemp(join(tmpdir(), 'lt-project-agent-'))
const storeFile = join(root, 'app', 'projects.json')
const store = new ProjectStore(storeFile)
const data = join(root, 'documents'), separate = join(root, 'other'), outside = join(root, 'private.txt')
let changed = 0, remoteReads = 0, canWrite = true, approved = 0
let executionProfiles = { office: { host: 'saved-office', user: 'saved-user', port: 2222 } }
const remoteFiles = new Map([
  ['ssh://office/evidence/remote.txt', Buffer.from('원격 계약 자료\n채권 회수 근거')],
  ['ssh://office/.legal-terminal/project-workspaces/project/ai.txt', Buffer.from('프로젝트 결과물')]
])
let pairings = { 'case-1': { drafts: data, records: separate }, 'remote:office:case-1': { drafts: '/remote-drafts', records: '/remote-records' } }
let details = { id: 'case-1', name: '현재 사건 정보' }
const base = { name: '채권 회수', goal: '회수 검토', nextAction: '자료 비교', notes: '', status: 'active', cases: [], folders: [] }

function pdf(body) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`
  ]
  let text = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(text)
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return text
}

try {
  await mkdir(data); await mkdir(separate)
  await writeFile(join(data, 'facts.md'), '계약 체결\n채권 회수 근거\n가압류 필요')
  await writeFile(join(separate, 'other.txt'), '다른 프로젝트 자료')
  await writeFile(outside, '범위 밖 비밀')
  await symlink(outside, join(data, 'escape.txt'))
  await writeFile(join(data, 'letter.docx'), 'synthetic office bytes')
  await writeFile(join(data, 'record.hwp'), 'synthetic office bytes')
  await writeFile(join(data, 'scan.png'), 'image bytes')
  await writeFile(join(data, 'document.pdf'), pdf('BT /F1 12 Tf 20 100 Td (Project evidence) Tj ET'))
  await writeFile(join(data, 'scan.pdf'), pdf(''))
  configureProjectAgent({
    store, workspaceRoot: join(root, 'app', 'project-workspaces'), changed: () => changed++,
    remoteWorkspace: async (profileId, projectId) => {
      const ssh = executionProfiles[profileId]
      if (!ssh) throw new Error('SSH 프로필을 찾을 수 없습니다.')
      return { cwd: `/home/office/.legal-terminal/project-workspaces/${projectId}`, ssh, profileId }
    },
    forwardLocal: async (profileId, localUrl, onDisconnect, expectedSsh) => {
      assert.equal(profileId, 'office'); assert.equal(localUrl, 'http://127.0.0.1:1234/mcp/remote')
      assert.equal(expectedSsh.host, 'saved-office')
      return { url: 'http://127.0.0.1:5678/mcp/remote', close: onDisconnect }
    },
    pairings: async () => pairings,
    caseDetails: async (id) => { assert.equal(id, 'case-1'); return details },
    list: async (path) => path.startsWith('ssh://')
      ? [...remoteFiles.keys()].filter((file) => file.startsWith(path + '/')).map((file) => {
        const [name, ...rest] = file.slice(path.length + 1).split('/')
        return { name, path: `${path}/${name}`, isDir: rest.length > 0 }
      })
      : (await readdir(path, { withFileTypes: true })).filter((entry) => !entry.isSymbolicLink()).map((entry) => ({ name: entry.name, path: join(path, entry.name), isDir: entry.isDirectory() })),
    stat: async (path) => {
      if (path.startsWith('ssh://')) { if (!remoteFiles.has(path)) throw new Error('원격 파일 없음'); return { size: remoteFiles.get(path).length, isDir: false } }
      const value = await stat(path); return { size: value.size, isDir: value.isDirectory(), mtimeMs: value.mtimeMs }
    },
    realpath: async (path) => path === 'ssh://office/evidence/escape.txt' ? 'ssh://office/private.txt' : path.startsWith('ssh://') ? path : realpath(path),
    readBytes: async (path) => { if (path.startsWith('ssh://')) { remoteReads++; return remoteFiles.get(path) } return readFile(path) },
    officeText: (path) => `${path.endsWith('.docx') ? 'DOCX' : 'HWP'} 채권 회수 자료`
  })
  let project = await store.save({ ...base, cases: [
    { key: 'linked-case', name: '본안', jsId: 'case-1' },
    { key: 'remote-case', name: '원격 본안', jsId: 'case-1', profileId: 'office', remotePath: '/evidence' },
    { key: 'uri-case', name: 'URI 본안', jsId: 'case-1', drafts: 'ssh://office/uri-drafts' }
  ], folders: [{ name: '공통 자료', path: data }, { name: '서버 자료', path: 'ssh://office/evidence' }] })
  const other = await store.save({ ...base, name: '다른 프로젝트', folders: [{ name: '다른 자료', path: separate }] })
  const workspace = await getProjectWorkspace(project.id)
  assert.equal(workspace.cwd, await realpath(join(root, 'app', 'project-workspaces', project.id)))
  assert.equal(workspace.project.id, project.id)
  assert.equal(workspace.ssh, undefined, 'local project behavior remains unchanged')
  const remoteProject = await store.save({ ...base, name: '원격 실행', executionProfileId: 'office' })
  const remoteWorkspace = await getProjectWorkspace(remoteProject.id)
  assert.equal(remoteWorkspace.profileId, 'office')
  assert.equal(remoteWorkspace.ssh.host, 'saved-office')
  assert.equal(remoteWorkspace.cwd, `/home/office/.legal-terminal/project-workspaces/${remoteProject.id}`)
  const remoteContext = await getProjectAgentContext(remoteProject.id)
  assert.ok(remoteContext.includes(remoteWorkspace.cwd), 'context names the actual remote output directory')
  assert.equal(remoteContext.includes('로컬 outputDirectory'), false)
  const explicitContext = await getProjectAgentContext(remoteProject.id, '/canonical/remote-output')
  assert.ok(explicitContext.includes('/canonical/remote-output'), 'execution passes the canonical directory into context')
  executionProfiles = {}
  await assert.rejects(getProjectWorkspace(remoteProject.id), /SSH 프로필을 찾을 수 없습니다/, 'missing remote profile never falls back to local')
  await assert.rejects(stat(join(root, 'app', 'project-workspaces', remoteProject.id)), { code: 'ENOENT' })
  executionProfiles = { office: { host: 'saved-office', user: 'saved-user', port: 2222 } }
  let tunnelClosed = false
  const tunnel = await forwardProjectMcp('office', 'http://127.0.0.1:1234/mcp/remote', () => { tunnelClosed = true }, remoteWorkspace.ssh)
  assert.equal(tunnel.url, 'http://127.0.0.1:5678/mcp/remote')
  tunnel.close(); assert.equal(tunnelClosed, true)
  const connection = await acquireProjectMcp('session-1', project.id, { canWrite: () => canWrite, approveWrite: async () => { approved++; return true } })
  const otherConnection = await acquireProjectMcp('session-2', other.id)
  const request = async (target, method, params = {}) => {
    const response = await fetch(target.url, { method: 'POST', headers: { ...target.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    assert.equal(response.status, 200)
    return (await response.json()).result
  }
  const call = async (name, args = {}, target = connection) => {
    const result = await request(target, 'tools/call', { name, arguments: args })
    return { ...JSON.parse(result.content[0].text), failed: result.isError === true }
  }
  assert.equal((await request(connection, 'initialize', { protocolVersion: '2025-03-26' })).protocolVersion, '2025-03-26')
  const tools = (await request(connection, 'tools/list')).tools
  assert.equal(tools.length, 6)
  assert.equal(tools.find((tool) => tool.name === 'project_record_note').annotations.readOnlyHint, false)
  assert.equal((await fetch(connection.url, { method: 'POST', body: '{}' })).status, 403)
  assert.equal((await fetch(connection.url, { method: 'POST', headers: { ...connection.headers, Origin: 'https://untrusted.test' }, body: '{}' })).status, 403)
  assert.equal((await fetch(connection.url, { headers: connection.headers })).status, 405)
  assert.equal((await fetch(connection.url, { method: 'POST', headers: connection.headers, body: 'bad json' })).status, 400)
  assert.equal((await fetch(connection.url, { method: 'POST', headers: connection.headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { padding: '가'.repeat(90000) } }) })).status, 400, 'HTTP size limits count UTF-8 bytes')
  let context = await call('project_context')
  const local = context.sources.find((source) => source.name === '공통 자료')
  const ssh = context.sources.find((source) => source.name === '서버 자료')
  const caseSource = context.sources.find((source) => source.kind === 'case')
  const paired = context.sources.find((source) => source.kind === 'case-drafts')
  assert.equal(paired.path, data, 'unpaired JuriSupport cases resolve their current pairing')
  assert.equal(context.sources.find((source) => source.caseKey === 'remote-case' && source.kind === 'case-drafts').path, 'ssh://office/remote-drafts')
  assert.equal(context.sources.find((source) => source.caseKey === 'remote-case' && source.kind === 'case-records').path, 'ssh://office/remote-records')
  assert.equal(context.sources.find((source) => source.caseKey === 'uri-case' && source.kind === 'case-records').path, 'ssh://office/remote-records', 'remote URI supplies profile identity before pairing lookup')
  assert.equal((await call('project_case_details', { sourceId: caseSource.id })).details.name, details.name)
  details = { ...details, name: '갱신된 사건 정보' }
  assert.equal((await call('project_case_details', { sourceId: caseSource.id })).details.name, '갱신된 사건 정보')
  assert.equal((await call('project_case_details', { sourceId: local.id })).failed, true)
  assert.equal((await call('project_list_files', { sourceId: local.id })).entries.some((entry) => entry.path === 'facts.md'), true)
  const localRead = await call('project_read_file', { sourceId: local.id, path: 'facts.md', startLine: 2, lineCount: 1 })
  assert.match(localRead.text, /^2: 채권 회수 근거$/)
  assert.equal(localRead.source.id, local.id)
  assert.equal(localRead.truncated, true)
  const remoteRead = await call('project_read_file', { sourceId: ssh.id, path: 'remote.txt' })
  assert.match(remoteRead.text, /원격 계약 자료/)
  assert.equal(remoteRead.absolutePath, 'ssh://office/evidence/remote.txt')
  assert.ok(remoteReads > 0)
  for (const path of ['../private.txt', outside, 'escape.txt', 'C:\\private.txt']) assert.equal((await call('project_read_file', { sourceId: local.id, path })).failed, true)
  assert.equal((await call('project_read_file', { sourceId: ssh.id, path: 'escape.txt' })).failed, true)
  for (const [path, expected] of [['letter.docx', 'DOCX'], ['record.hwp', 'HWP'], ['document.pdf', 'Project evidence']]) {
    const result = await call('project_read_file', { sourceId: local.id, path })
    assert.equal(result.failed, false, result.failed)
    assert.match(result.text, new RegExp(expected))
  }
  assert.equal((await call('project_read_file', { sourceId: local.id, path: 'scan.pdf' })).failed, true)
  assert.equal((await call('project_read_file', { sourceId: local.id, path: 'scan.png' })).failed, true)
  const otherSources = (await call('project_context', {}, otherConnection)).sources
  assert.equal((await call('project_read_file', { sourceId: otherSources[0].id, path: 'other.txt' })).failed, true)
  const search = await call('project_search', { query: '채권', sourceIds: [local.id, ssh.id], limit: 20 })
  assert.ok(search.matches.some((match) => match.source.id === local.id))
  assert.ok(search.matches.some((match) => match.source.id === ssh.id))
  assert.ok(search.skipped.some((item) => item.path === 'scan.png'))
  assert.match(search.scope, /전체 일치 건수가 아닙니다/)
  const koreanBody = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'project_search', arguments: { query: '채권', sourceIds: [ssh.id] } } }))
  const splitAt = koreanBody.indexOf(Buffer.from('채권')) + 1
  const splitResult = await new Promise((resolve, reject) => {
    const request = httpRequest(connection.url, { method: 'POST', headers: { ...connection.headers, 'Content-Type': 'application/json' } }, (response) => {
      const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
    })
    request.on('error', reject); request.write(koreanBody.subarray(0, splitAt))
    setTimeout(() => request.end(koreanBody.subarray(splitAt)), 20)
  })
  const splitSearch = JSON.parse(splitResult.result.content[0].text)
  assert.equal(splitSearch.query, '채권', 'split Korean code points survive HTTP chunk boundaries')
  assert.ok(splitSearch.matches.length)

  pairings = { 'case-1': { drafts: separate } }
  const noRemotePairing = await call('project_context')
  assert.equal(noRemotePairing.sources.some((source) => source.caseKey === 'remote-case' && source.kind === 'case-records'), false, 'remote cases never fall back to the local case pairing')
  assert.equal((await call('project_read_file', { sourceId: paired.id, path: 'facts.md' })).failed, true)
  for (const pairingPath of ['/cases/공통 자료', String.raw`C:\Cases\공통 자료`, String.raw`\\server\share\공통 자료`, separate]) {
    pairings = { 'case-1': { drafts: pairingPath } }
    const promptContext = await getProjectAgentContext(project.id)
    const block = promptContext.match(/<legal-terminal-project-context>\n[^\n]*\n([^\n]+)\n/)
    assert.ok(block, 'project context contains a JSON data line inside its context block')
    const data = JSON.parse(block[1])
    assert.equal(data.sources.find((source) => source.caseKey === 'linked-case' && source.kind === 'case-drafts')?.path,
      pairingPath, 'every send includes the current pairing after JSON decoding on any platform')
  }
  const noteInput = { note: '자료 비교 후 가압류 검토', expectedUpdatedAt: project.updatedAt, nextAction: '담보 자료 확인', sources: [{ sourceId: local.id, path: 'facts.md', startLine: 2, endLine: 3 }] }
  const remembered = await call('project_record_note', noteInput)
  assert.equal(remembered.saved, true)
  assert.equal(approved, 1)
  assert.equal(changed, 1)
  project = (await store.list()).find((entry) => entry.id === project.id)
  assert.match(project.notes, /자료 비교 후 가압류 검토/)
  assert.ok(project.notes.includes(local.name) && project.notes.includes('facts.md') && project.notes.includes('2~3행'), 'saved notes show human-readable source names, paths and lines')
  assert.equal(remembered.sources[0].sourceId, local.id, 'tool result preserves exact source identity')
  assert.equal(project.nextAction, '담보 자료 확인')
  assert.equal((await call('project_record_note', noteInput)).failed, true, 'stale AI writes cannot overwrite newer state')
  const invalidSource = { ...noteInput, expectedUpdatedAt: project.updatedAt, sources: [{ sourceId: otherSources[0].id }] }
  assert.equal((await call('project_record_note', invalidSource)).failed, true)
  assert.equal(approved, 1, 'nonmember sources fail before approval')
  canWrite = false
  assert.equal((await request(connection, 'tools/list')).tools.some((tool) => tool.name === 'project_record_note'), false)
  assert.equal((await call('project_record_note', { ...noteInput, expectedUpdatedAt: project.updatedAt })).failed, true)
  canWrite = true
  await acquireProjectMcp('session-1', project.id, { canWrite: () => canWrite, approveWrite: async () => {
    await store.save({ ...project, goal: '사용자가 바꾼 목표', expectedUpdatedAt: project.updatedAt })
    return true
  } })
  assert.equal((await call('project_record_note', { ...noteInput, expectedUpdatedAt: project.updatedAt })).failed, true, 'UI changes during approval win the CAS conflict')
  project = (await store.list()).find((entry) => entry.id === project.id)
  assert.equal(project.goal, '사용자가 바꾼 목표')
  project = await store.save({ ...project, folders: [{ name: '서버 자료', path: 'ssh://office/evidence' }], expectedUpdatedAt: project.updatedAt })
  assert.equal((await call('project_read_file', { sourceId: local.id, path: 'facts.md' })).failed, true, 'removing links revokes subsequent tool access')
  assert.equal((await call('project_record_note', { ...noteInput, expectedUpdatedAt: project.updatedAt })).failed, true)
  assert.equal(await readFile(join(data, 'facts.md'), 'utf8'), '계약 체결\n채권 회수 근거\n가압류 필요', 'AI memory leaves source files untouched')

  releaseProjectMcp('session-1')
  assert.equal((await fetch(connection.url, { method: 'POST', headers: connection.headers, body: '{}' })).status, 403)
  const replacement = await acquireProjectMcp('session-1', project.id)
  assert.notEqual(replacement.headers.Authorization, connection.headers.Authorization, 'reacquisition rotates a revoked credential')
  await writeFile(storeFile, '{corrupt')
  assert.equal((await call('project_context', {}, replacement)).failed, true)
  assert.equal(await readFile(storeFile, 'utf8'), '{corrupt')
  await writeFile(storeFile, JSON.stringify({ version: 1, projects: [project, other] }))
  await store.remove(project.id, project.updatedAt)
  assert.equal((await call('project_context', {}, replacement)).failed, true)
  await assert.rejects(getProjectWorkspace(project.id), /삭제되었거나/)
  await assert.rejects(acquireProjectMcp('gone', project.id), /삭제되었거나/)
  const broad = await store.save({ ...base, folders: [{ name: '너무 넓은 자료', path: root }] })
  const broadWorkspace = await getProjectWorkspace(broad.id)
  await writeFile(join(broadWorkspace.cwd, 'ai-output.txt'), '생성한 분석')
  const broadConnection = await acquireProjectMcp('broad', broad.id)
  const broadSource = (await call('project_context', {}, broadConnection)).sources[0]
  const broadFiles = await call('project_list_files', { sourceId: broadSource.id, depth: 5 }, broadConnection)
  assert.equal(broadFiles.entries.some((entry) => entry.path.includes('project-workspaces')), false, 'broad source folders exclude private output workspaces from listing')
  assert.equal((await call('project_read_file', { sourceId: broadSource.id, path: `app/project-workspaces/${broad.id}/ai-output.txt` }, broadConnection)).failed, true)
  const broadRemote = await store.save({ ...base, folders: [{ name: '원격 앱 자료', path: 'ssh://office/.legal-terminal' }] })
  const broadRemoteConnection = await acquireProjectMcp('broad-remote', broadRemote.id)
  const broadRemoteSource = (await call('project_context', {}, broadRemoteConnection)).sources[0]
  assert.equal((await call('project_list_files', { sourceId: broadRemoteSource.id, depth: 5 }, broadRemoteConnection)).entries.length, 0, 'broad remote sources exclude private output workspaces')
  assert.equal((await call('project_read_file', { sourceId: broadRemoteSource.id, path: 'project-workspaces/project/ai.txt' }, broadRemoteConnection)).failed, true)
  console.log('project agent ok: authenticated MCP, live membership, local/SSH reads, case details, PDF/office extraction, source attribution, isolated workspace, CAS and revocation')
} finally {
  await disposeProjectMcp()
  await rm(root, { recursive: true, force: true })
}
