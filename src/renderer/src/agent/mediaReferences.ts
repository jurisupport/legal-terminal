import { imageMimeType, mediaMimeType, type MediaSelection } from '../../../shared/media'
import type { AgentAttachment } from '../env'

export interface AgentMediaContext {
  cwd: string
  remote?: boolean
  profileId?: string
}

export interface AgentMediaReference {
  path: string
  kind: 'image' | 'video' | 'audio'
  label: string
  selection?: MediaSelection
}

function normalizePath(path: string): string {
  const drive = /^[a-z]:/i.exec(path)?.[0] ?? ''
  const parts: string[] = []
  for (const part of path.slice(drive.length).replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${drive}/${parts.join('/')}`
}

export function resolveAgentMediaPath(value: string, context: AgentMediaContext, decodeUrl = false): string | undefined {
  let path = value.trim()
  if (decodeUrl && !/^file:/i.test(path)) {
    try { path = decodeURIComponent(path) } catch { return undefined }
  }
  if (!path || /[\u0000-\u001f]/.test(path)) return undefined
  if (path.startsWith('ssh://')) {
    const match = /^ssh:\/\/([a-z\d_-]+)(\/.*)$/i.exec(path)
    return match ? `ssh://${match[1]}${normalizePath(match[2])}` : undefined
  }
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path)
      if (url.hostname && url.hostname !== 'localhost') return undefined
      path = decodeURIComponent(url.pathname)
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1)
    } catch { return undefined }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return undefined
  if (/[\u0000-\u001f]/.test(path) || path.startsWith('//') || path.startsWith('\\\\')) return undefined
  const windows = /^[a-z]:[\\/]/i.test(path)
  const remoteCwd = /^ssh:\/\/([^/]+)(\/.*)$/.exec(context.cwd)
  const remote = context.remote || !!remoteCwd
  const cwd = remoteCwd?.[2] ?? context.cwd
  if (!path.startsWith('/') && !windows) {
    if (!cwd.startsWith('/') && !/^[a-z]:[\\/]/i.test(cwd)) return undefined
    path = `${cwd}/${path}`
  }
  path = normalizePath(path)
  if (!remote) return path
  const profileId = context.profileId ?? remoteCwd?.[1]
  return profileId && /^[a-z\d_-]+$/i.test(profileId) && !windows ? `ssh://${profileId}${path}` : undefined
}

export function agentMediaReference(value: string, label: string, context: AgentMediaContext, decodeUrl = false): AgentMediaReference | undefined {
  const path = resolveAgentMediaPath(value, context, decodeUrl)
  if (!path) return undefined
  const mime = imageMimeType(path) ?? mediaMimeType(path)
  if (!mime) return undefined
  return { path, kind: mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : 'video', label: label || path.split('/').pop() || path }
}

export function attachmentMediaReference(attachment: AgentAttachment, context: AgentMediaContext): AgentMediaReference | undefined {
  if (attachment.kind === 'folder' || attachment.kind === 'terminal-snippet') return undefined
  const capturedFrame = attachment.media?.compositionId ? attachment.source?.path ?? attachment.media.capturePath : undefined
  const path = capturedFrame ?? attachment.media?.sourcePath ?? attachment.source?.path ?? attachment.path
  if (!path) return undefined
  const local = attachment.origin === 'local'
  const reference = agentMediaReference(path, attachment.label, local ? { cwd: context.remote ? '' : context.cwd } : context)
  return reference ? { ...reference, selection: capturedFrame ? undefined : attachment.media } : undefined
}
