import { contextBridge, ipcRenderer, webUtils } from 'electron'

// 렌더러에 노출되는 좁은 API 표면. 이후 마일스톤에서
// pty.* / ide.* / fs.* / sidecar.* / caseIndex.* 채널이 여기에 추가된다.
interface SshConn {
  host: string
  user: string
  port?: number
  identityFile?: string
}

interface SshProfile extends SshConn {
  id: string
  label: string
  draftsRoot?: string
  recordsRoot?: string
}

interface RemoteEntry {
  name: string
  path: string
  isDir: boolean
  mtimeMs?: number
}

interface PtyCreateOpts {
  id: string
  cwd?: string
  cols: number
  rows: number
  autoLaunchClaude?: boolean
  resumeSessionId?: string
  ssh?: SshConn
}

interface TerminalTabPayload {
  id: string
  title: string
  cwd: string
  recordsFolder?: string
  suggestedRecords?: string
  autoClaude?: boolean
  jsId?: string
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
  sessionTitle?: string
  renamed?: boolean
  createdAt?: number
  resumeSessionId?: string
  ssh?: SshConn
  sshLabel?: string
  profileId?: string
}

type TabPayload =
  | { kind: 'doc'; path: string; title: string }
  | { kind: 'terminal'; tab: TerminalTabPayload }

interface AppSettings {
  draftsRoot?: string
  recordsRoot?: string
  caseOpenTarget?: string
  pdfZoom?: string
  termFont?: string
  termFontSize?: number
  mdFont?: string
  mdFontSize?: number
  sshProfiles?: SshProfile[]
}

const api = {
  app: {
    info: (): Promise<{
      platform: string
      versions: { electron: string; node: string; chrome: string }
    }> => ipcRenderer.invoke('app:info'),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
    newWindow: (): Promise<void> => ipcRenderer.invoke('window:new')
  },
  dialog: {
    openCase: (): Promise<{ path: string; name: string } | null> =>
      ipcRenderer.invoke('dialog:openCase'),
    pickFolder: (opts?: {
      title?: string
      defaultPath?: string
    }): Promise<{ path: string; name: string } | null> =>
      ipcRenderer.invoke('dialog:pickFolder', opts)
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:set', patch)
  },
  export: {
    mdToPdf: (
      html: string,
      defaultPath?: string
    ): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('export:mdToPdf', { html, defaultPath })
  },
  fs: {
    list: (
      dirPath: string
    ): Promise<{ name: string; path: string; isDir: boolean; mtimeMs?: number }[]> =>
      ipcRenderer.invoke('fs:list', dirPath),
    readBytes: (filePath: string): Promise<ArrayBuffer> =>
      ipcRenderer.invoke('fs:readBytes', filePath),
    readHwpText: (
      filePath: string
    ): Promise<{ ok: boolean; text: string; error?: string }> =>
      ipcRenderer.invoke('fs:readHwpText', filePath),
    writeText: (path: string, content: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:writeText', { path, content }),
    saveAs: (
      content: string,
      defaultPath?: string
    ): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('fs:saveAs', { content, defaultPath }),
    copyInto: (destDir: string, srcPaths: string[]): Promise<{ copied: string[] }> =>
      ipcRenderer.invoke('fs:copyInto', { destDir, srcPaths }),
    move: (src: string, destDir: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('fs:move', { src, destDir }),
    delete: (path: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:delete', path),
    mkdir: (dir: string, name: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:mkdir', { dir, name }),
    createFile: (
      dir: string,
      name: string,
      content?: string
    ): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('fs:createFile', { dir, name, content }),
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
    listPdfs: (dir: string): Promise<{ name: string; path: string }[]> =>
      ipcRenderer.invoke('fs:listPdfs', dir),
    readText: (
      filePath: string
    ): Promise<{
      ext: string
      kind: 'text' | 'binary'
      text: string
      size: number
      truncated?: boolean
    }> => ipcRenderer.invoke('fs:readText', filePath),
    stat: (
      filePath: string
    ): Promise<
      | { ok: true; size: number; isDir: boolean; mtimeMs?: number }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('fs:stat', filePath)
  },
  case: {
    getPairing: (drafts: string): Promise<string | undefined> =>
      ipcRenderer.invoke('case:getPairing', drafts),
    setPairing: (drafts: string, records: string): Promise<void> =>
      ipcRenderer.invoke('case:setPairing', { drafts, records }),
    getJsPairing: (id: string): Promise<{ drafts: string; records?: string } | undefined> =>
      ipcRenderer.invoke('case:getJsPairing', id),
    setJsPairing: (id: string, drafts: string, records?: string): Promise<void> =>
      ipcRenderer.invoke('case:setJsPairing', { id, drafts, records }),
    history: (): Promise<
      { drafts: string; records?: string; name: string; ts: number }[]
    > => ipcRenderer.invoke('case:history'),
    addHistory: (entry: {
      drafts: string
      records?: string
      name: string
    }): Promise<{ drafts: string; records?: string; name: string; ts: number }[]> =>
      ipcRenderer.invoke('case:addHistory', entry)
  },
  js: {
    setToken: (token: string): Promise<void> => ipcRenderer.invoke('js:setToken', token),
    hasToken: (): Promise<boolean> => ipcRenderer.invoke('js:hasToken'),
    listCases: (
      params?: { search?: string; status?: string; caseType?: string }
    ): Promise<{ ok: boolean; cases?: unknown[]; error?: string }> =>
      ipcRenderer.invoke('js:listCases', params ?? {}),
    getCase: (id: string): Promise<{ ok: boolean; case?: unknown; error?: string }> =>
      ipcRenderer.invoke('js:getCase', id)
  },
  ssh: {
    // 원격 디렉터리 목록 (사건 폴더 선택용). 키/agent 인증 시에만 성공.
    listDir: (
      profile: SshProfile,
      path: string
    ): Promise<
      { ok: true; entries: RemoteEntry[]; cwd: string } | { ok: false; error: string }
    > => ipcRenderer.invoke('ssh:listDir', { profile, path })
  },
  sync: {
    remoteInfo: (
      profile: SshProfile
    ): Promise<{ installed: boolean; remotes: string[]; error?: string }> =>
      ipcRenderer.invoke('sync:remoteInfo', profile),
    run: (opts: {
      profile: SshProfile
      direction: 'pull' | 'push'
      macFolder: string
      dest: string
    }): Promise<{ ok: boolean; code: number | null; error?: string }> =>
      ipcRenderer.invoke('sync:run', opts),
    cancel: (): void => ipcRenderer.send('sync:cancel'),
    onProgress: (cb: (line: string) => void): (() => void) => {
      const listener = (_e: unknown, line: string): void => cb(line)
      ipcRenderer.on('sync:progress', listener)
      return () => ipcRenderer.removeListener('sync:progress', listener)
    }
  },
  sessions: {
    current: (
      cwd: string,
      since?: number,
      ssh?: SshConn
    ): Promise<{ sessionId: string; title?: string } | null> =>
      ipcRenderer.invoke('sessions:current', { cwd, since, ssh }),
    list: (
      cwd: string,
      ssh?: SshConn
    ): Promise<{ sessionId: string; title?: string; mtime: number }[]> =>
      ipcRenderer.invoke('sessions:list', { cwd, ssh })
  },
  claude: {
    ask: (payload: string): Promise<void> => ipcRenderer.invoke('claude:ask', payload),
    onIncoming: (cb: (payload: string) => void): (() => void) => {
      const listener = (_e: unknown, payload: string): void => cb(payload)
      ipcRenderer.on('claude:incoming', listener)
      return () => ipcRenderer.removeListener('claude:incoming', listener)
    }
  },
  tabs: {
    beginDrag: (payload: TabPayload): Promise<void> =>
      ipcRenderer.invoke('tabs:beginDrag', payload),
    endDrag: (): Promise<{ action: 'moved' | 'none' }> => ipcRenderer.invoke('tabs:endDrag'),
    ready: (): Promise<void> => ipcRenderer.invoke('tabs:ready'),
    onReceive: (cb: (p: TabPayload) => void): (() => void) => {
      const listener = (_e: unknown, p: TabPayload): void => cb(p)
      ipcRenderer.on('tabs:receive', listener)
      return () => ipcRenderer.removeListener('tabs:receive', listener)
    }
  },
  pty: {
    create: (opts: PtyCreateOpts): Promise<void> => ipcRenderer.invoke('pty:create', opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', { id, data }),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', { id, cols, rows }),
    detach: (id: string): void => ipcRenderer.send('pty:detach', { id }),
    kill: (id: string): void => ipcRenderer.send('pty:kill', { id }),
    onData: (cb: (p: { id: string; data: string }) => void): (() => void) => {
      const listener = (_e: unknown, p: { id: string; data: string }): void => cb(p)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.removeListener('pty:data', listener)
    },
    onExit: (cb: (p: { id: string; exitCode: number }) => void): (() => void) => {
      const listener = (_e: unknown, p: { id: string; exitCode: number }): void => cb(p)
      ipcRenderer.on('pty:exit', listener)
      return () => ipcRenderer.removeListener('pty:exit', listener)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('lt', api)
  } catch (error) {
    console.error('[preload] contextBridge 노출 실패', error)
  }
} else {
  // contextIsolation 비활성 시 폴백 (개발 편의용; 배포에서는 항상 isolated)
  ;(window as unknown as { lt: typeof api }).lt = api
}

export type LtApi = typeof api
