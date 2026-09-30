import { app, BrowserWindow, dialog } from 'electron'
import { createHash } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { utils } from 'ssh2'
import type { SshProfile } from './settings'

// Separate from editable profiles: changing a profile must never reset server trust.
export async function verifySshHostKey(
  profile: Pick<SshProfile, 'host' | 'port'>,
  key: Buffer,
  connectionSignal: AbortSignal
): Promise<boolean> {
  const signal = AbortSignal.any([connectionSignal, AbortSignal.timeout(30_000)])
  const parsed = utils.parseKey(key)
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('SSH 서버키를 읽을 수 없습니다.')
  const host = profile.host.trim().toLowerCase()
  const port = profile.port || 22
  const id = createHash('sha256').update(JSON.stringify([host, port, parsed.type])).digest('hex')
  const directory = join(app.getPath('userData'), 'ssh-host-keys')
  const path = join(directory, id)
  const value = key.toString('base64')
  const matchesSavedKey = async (): Promise<boolean> => {
    try {
      const saved = await readFile(path, 'utf8')
      if (saved !== value) throw new Error(`SSH 서버키가 변경되었습니다: ${host}:${port} (${parsed.type}). 서버 관리자에게 확인하세요.`)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  signal.throwIfAborted()
  if (await matchesSavedKey()) {
    signal.throwIfAborted()
    return true
  }
  signal.throwIfAborted()
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
  if (!parent) throw new Error('SSH 서버키를 처음 확인하려면 앱 창을 연 뒤 다시 연결하세요.')
  const fingerprint = createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  let onAbort: () => void = () => {}
  try {
    const result = await Promise.race([
      dialog.showMessageBox(parent, {
        type: 'warning',
        title: 'SSH 서버 신원 확인',
        message: `${host}:${port} 서버를 신뢰하시겠습니까?`,
        detail: `처음 연결하는 서버입니다. 서버 관리자에게 아래 지문을 확인하세요.\n\n키 종류: ${parsed.type}\nSHA256:${fingerprint}\n\n승인 후에만 사용자 인증을 진행합니다. 30초 안에 응답하지 않으면 연결을 취소합니다.`,
        buttons: ['취소', '확인한 서버키 저장 및 연결'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal
      }),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('SSH 서버키 확인 시간이 초과되었거나 연결이 취소되었습니다.'))
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
    ])
    signal.throwIfAborted()
    if (result.response !== 1) throw new Error('SSH 서버키 확인을 거절하여 연결을 취소했습니다.')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    signal.throwIfAborted()
    try {
      // Exclusive creation prevents another simultaneous approval from replacing trust.
      await writeFile(path, value, { flag: 'wx', mode: 0o600, signal })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!await matchesSavedKey()) throw new Error('저장된 SSH 서버키를 확인할 수 없습니다. 다시 연결하세요.')
    }
    signal.throwIfAborted()
    return true
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
