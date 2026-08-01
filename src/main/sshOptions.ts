import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type SshUsage = 'oneshot' | 'interactive'

export interface SshProfileLike {
  user: string
  host: string
  port?: number
  identityFile?: string
}

export interface SshArgsOptions {
  usage: SshUsage
  tty?: boolean
  batchMode?: boolean
  connectTimeout?: number
  platform?: NodeJS.Platform
}

const SERVER_ALIVE_INTERVAL = 30
const SERVER_ALIVE_COUNT_MAX = 3
const CONTROL_PERSIST_SECONDS = 60
const controlTargets = new Map<string, string>()

function controlSocketPath(profile: SshProfileLike): string {
  const salt = `${profile.user}@${profile.host}:${profile.port ?? 22}\0${profile.identityFile ?? ''}`
  const digest = createHash('sha256').update(salt).digest('hex')
  return join(tmpdir(), `legal-terminal-ssh-${digest.slice(0, 16)}.sock`)
}

function withControlMasterArgs(profile: SshProfileLike, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return []
  const path = controlSocketPath(profile)
  controlTargets.set(path, `${profile.user}@${profile.host}`)
  return [
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${path}`,
    '-o',
    `ControlPersist=${CONTROL_PERSIST_SECONDS}`
  ]
}

export function buildSshArgs(profile: SshProfileLike, options: SshArgsOptions): string[] {
  const platform: NodeJS.Platform = options.platform ?? process.platform
  const args: string[] = []
  if (options.tty) args.push('-tt')
  if (profile.port) args.push('-p', String(profile.port))
  if (profile.identityFile) args.push('-i', profile.identityFile)
  if (options.batchMode !== false) args.push('-o', 'BatchMode=yes')
  const defaultConnectTimeout = options.usage === 'interactive' ? 20 : 12
  const connectTimeout = options.connectTimeout ?? defaultConnectTimeout
  args.push('-o', `ConnectTimeout=${connectTimeout}`)
  args.push('-o', `ServerAliveInterval=${SERVER_ALIVE_INTERVAL}`)
  args.push('-o', `ServerAliveCountMax=${SERVER_ALIVE_COUNT_MAX}`)
  args.push('-o', 'StrictHostKeyChecking=accept-new')
  if (options.usage === 'oneshot') args.push(...withControlMasterArgs(profile, platform))
  args.push(`${profile.user}@${profile.host}`)
  return args
}

export function disposeSshControlMasters(): void {
  for (const [path, target] of controlTargets) {
    try {
      execFileSync('ssh', ['-o', `ControlPath=${path}`, '-O', 'exit', target], {
        timeout: 1_000,
        stdio: 'ignore'
      })
    } catch {
      /* The master may have already exited. */
    }
    try {
      rmSync(path, { force: true })
    } catch {
      /* Best effort during app shutdown. */
    }
  }
  controlTargets.clear()
}

export { controlSocketPath as getControlPathForProfile }
