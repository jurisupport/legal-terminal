// The lawyer's own specialist files (~/.claude/agents/<name>.md) on the machine that runs the departments.
// The app writes only <name>.md files it can read back; plugin specialists stay read-only.
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dump, JSON_SCHEMA, load } from 'js-yaml'
import type { BoardAgentFile } from '../shared/workBoard'

// Same folder the board runner reads specialists from.
function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

const maxPromptChars = 20_000
const namePattern = /^[\p{L}\d_-]{1,100}$/u
const modelPattern = /^[\w.:-]{1,100}$/

interface AgentFolder {
  read(file: string): Promise<string | null>
  write(file: string, text: string): Promise<void>
  remove(file: string): Promise<void>
  /** Called after a change so the next listing reads the folder again. */
  changed(): Promise<void>
}

function localFolder(): AgentFolder {
  const root = join(claudeConfigDir(), 'agents')
  return {
    async read(file) {
      try {
        const info = await stat(join(root, file))
        if (!info.isFile() || info.size > 256 * 1024) throw new Error('전문가 파일의 종류나 크기를 확인해 주세요: ' + file)
        return await readFile(join(root, file), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async write(file, text) {
      await mkdir(root, { recursive: true, mode: 0o700 })
      const tmp = join(root, '.agent-' + randomUUID() + '.tmp')
      const handle = await open(tmp, 'wx', 0o600)
      try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
      await rename(tmp, join(root, file))
    },
    async remove(file) { await rm(join(root, file)) },
    async changed() {}
  }
}

async function remoteFolder(workspace: string): Promise<AgentFolder> {
  const fs = await import('./remoteFs')
  const root = await fs.rfsBoardAgentDirectory(workspace)
  const { profileId, path } = fs.parseRemote(root)
  const uri = (file: string) => fs.makeRemote(profileId, path + '/' + file)
  return {
    async read(file) {
      const info = await fs.rfsBoardStat(uri(file))
      if (!info) return null
      if (info.directory || info.size > 256 * 1024) throw new Error('전문가 파일의 종류나 크기를 확인해 주세요: ' + file)
      return fs.rfsReadBoardText(uri(file))
    },
    async write(file, text) {
      const folder = await fs.rfsBoardStat(root)
      if (!folder) {
        const parent = path.slice(0, path.lastIndexOf('/')) || '/'
        await fs.rfsMkdir(fs.makeRemote(profileId, parent), 'agents')
      } else if (!folder.directory) throw new Error('원격 전문가 폴더 경로가 폴더가 아닙니다: ' + path)
      await fs.rfsWriteText(uri(file), text, undefined, false)
    },
    async remove(file) { await fs.rfsDelete(uri(file)) },
    async changed() { await fs.rfsForgetBoardAgents(workspace) }
  }
}

function folderFor(workspace: string): Promise<AgentFolder> {
  return workspace.startsWith('ssh://') ? remoteFolder(workspace) : Promise.resolve(localFolder())
}

function parse(text: string): { data: Record<string, unknown>; prompt: string } | null {
  const parts = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (!parts) return null
  try {
    const data = load(parts[1], { schema: JSON_SCHEMA })
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    return { data: data as Record<string, unknown>, prompt: parts[2].replace(/^\r?\n/, '') }
  } catch { return null }
}

function checkName(name: unknown): string {
  if (typeof name !== 'string' || !namePattern.test(name)) throw new Error('부서원 이름은 한글·영문·숫자·-·_ 로 100자 이내로 적어 주세요.')
  return name
}

/** The name, description, instructions and model of one of the lawyer's own specialists. */
export async function readBoardAgentFile(workspace: string, name: string): Promise<BoardAgentFile> {
  checkName(name)
  const text = await (await folderFor(workspace)).read(name + '.md')
  const parsed = text === null ? null : parse(text)
  if (!parsed || parsed.data.name !== name) {
    throw new Error(`앱 밖에서 다른 파일 이름으로 만든 부서원이라 여기서 고칠 수 없습니다. 전문가 폴더의 파일을 직접 고쳐 주세요: ${name}`)
  }
  const model = typeof parsed.data.model === 'string' ? parsed.data.model : undefined
  return { name, description: String(parsed.data.description ?? ''), prompt: parsed.prompt.trim(), ...(model && { model }) }
}

function validFile(input: unknown): BoardAgentFile {
  if (!input || typeof input !== 'object') throw new Error('부서원 내용을 확인해 주세요.')
  const value = input as Record<string, unknown>
  const name = checkName(typeof value.name === 'string' ? value.name.trim() : value.name)
  const description = typeof value.description === 'string' ? value.description.trim().replace(/\s+/g, ' ') : ''
  if (!description || description.length > 500) throw new Error('맡는 일을 500자 이내로 적어 주세요.')
  const prompt = typeof value.prompt === 'string' ? value.prompt.replace(/\r\n/g, '\n').trim() : ''
  if (!prompt || prompt.length > maxPromptChars) throw new Error(`일하는 방법(지침)을 ${maxPromptChars.toLocaleString()}자 이내로 적어 주세요.`)
  const model = typeof value.model === 'string' && value.model.trim() ? value.model.trim() : undefined
  if (model && !modelPattern.test(model)) throw new Error('모델 이름을 확인해 주세요.')
  return { name, description, prompt, ...(model && { model }) }
}

/**
 * Writes `<name>.md` in the specialist folder. A new member must not reuse a listed name.
 * Editing keeps frontmatter the app does not show (tools, effort, maxTurns) and returns the previous text.
 */
export async function writeBoardAgentFile(workspace: string, input: unknown, mode: 'create' | 'update', taken: string[]): Promise<string | null> {
  const file = validFile(input)
  const folder = await folderFor(workspace)
  const previous = await folder.read(file.name + '.md')
  let data: Record<string, unknown> = {}
  if (mode === 'create') {
    if (previous !== null || taken.includes(file.name)) throw new Error('같은 이름의 부서원이 이미 있습니다: ' + file.name)
  } else {
    const parsed = previous === null ? null : parse(previous)
    if (!parsed || parsed.data.name !== file.name) throw new Error('고칠 부서원 파일을 찾을 수 없습니다: ' + file.name)
    data = parsed.data
  }
  const { name: _name, description: _description, model: _model, ...rest } = data
  const head = dump({ name: file.name, description: file.description, ...(file.model && { model: file.model }), ...rest },
    { lineWidth: -1, noRefs: true }).trimEnd()
  await folder.write(file.name + '.md', `---\n${head}\n---\n\n${file.prompt}\n`)
  await folder.changed()
  return previous
}

/** Removes `<name>.md` and returns its text so the caller can keep a copy. */
export async function removeBoardAgentFile(workspace: string, name: string): Promise<string> {
  checkName(name)
  const folder = await folderFor(workspace)
  const previous = await folder.read(name + '.md')
  const parsed = previous === null ? null : parse(previous)
  if (previous === null || !parsed || parsed.data.name !== name) throw new Error('지울 부서원 파일을 찾을 수 없습니다: ' + name)
  await folder.remove(name + '.md')
  await folder.changed()
  return previous
}
