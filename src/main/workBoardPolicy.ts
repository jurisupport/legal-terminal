import { link, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const patterns = z.array(z.string().min(1).max(256)).max(128)
const schema = z.object({
  dangerTools: patterns,
  dangerBashCommands: patterns,
  mcpServers: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), z.object({
    url: z.url({ protocol: /^https$/ }),
    headers: z.record(z.string(), z.string()).optional()
  }))
})
export type BoardPolicy = z.infer<typeof schema>
const defaults: BoardPolicy = {
  dangerTools: ['*send*', '*post*', '*publish*', '*delete*', '*payment*', '*visibility*'],
  dangerBashCommands: ['*rm *', '*curl *', '*git push*'],
  mcpServers: {}
}
export async function readBoardPolicy(privateDir: string): Promise<BoardPolicy> {
  const file = join(privateDir, 'tool-policy.json')
  const read = async () => schema.parse(JSON.parse(await readFile(file, 'utf8')))
  try { return await read() } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  // A concurrent first run must see either a complete policy or a missing file.
  const temp = join(privateDir, randomUUID() + '.tmp')
  try {
    await writeFile(temp, JSON.stringify(defaults, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await link(temp, file).catch(err => { if (err.code !== 'EEXIST') throw err })
    return await read()
  } finally { await rm(temp, { force: true }) }
}

function matchesGlob(value: string, pattern: string): boolean {
  // Match '*' without running user-provided regular expressions.
  const parts = pattern.toLowerCase().split('*')
  let remaining = value.toLowerCase()
  const first = parts.shift()!
  if (!remaining.startsWith(first)) return false
  remaining = remaining.slice(first.length)
  if (!parts.length) return !remaining
  const last = parts.pop()!
  if (!remaining.endsWith(last)) return false
  remaining = remaining.slice(0, remaining.length - last.length)
  for (const middle of parts) {
    const at = remaining.indexOf(middle)
    if (at < 0) return false
    remaining = remaining.slice(at + middle.length)
  }
  return true
}

export const boardFileTools = ['case_list', 'case_read', 'case_draft']
export function boardPermission(name: string, command: string | undefined, grants: readonly string[], policy: BoardPolicy): boolean {
  if (name === 'Bash' && (!command || command.includes('\0'))) return false
  const grant = name === 'Bash' ? `Bash(${command})` : name
  const approved = grants.includes(grant)
  if (name === 'Bash' && policy.dangerBashCommands.some(p => matchesGlob(command!, p)) && !approved) return false
  if (policy.dangerTools.some(p => matchesGlob(name, p) || matchesGlob('mcp__board__' + name, p)) && !approved) return false
  if (boardFileTools.includes(name)) return true
  return approved && (name === 'Bash' || /^mcp__[a-zA-Z0-9_-]+?__[a-zA-Z0-9_-]+$/.test(name))
}

export function boardRelativePath(value: string): string {
  if (!value) return ''
  if (value.length > 1024 || /[\\:\x00-\x1f]/.test(value) || value.split('/').some(p => !p || p.startsWith('.'))) {
    throw new Error('작업 폴더 아래의 상대 경로를 입력하세요.')
  }
  return value
}
