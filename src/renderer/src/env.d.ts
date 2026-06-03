/// <reference types="vite/client" />

export interface SshConn {
  host: string
  user: string
  port?: number
  identityFile?: string
}

export interface SshProfile extends SshConn {
  id: string
  label: string
  draftsRoot?: string
  recordsRoot?: string
}

export interface RemoteEntry {
  name: string
  path: string
  isDir: boolean
  mtimeMs?: number
}

export interface PtyCreateOpts {
  id: string
  cwd?: string
  cols: number
  rows: number
  autoLaunchClaude?: boolean
  resumeSessionId?: string
  ssh?: SshConn
}

export interface TerminalTabPayload {
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
  side?: 'left' | 'right'
}

export type TabPayload =
  | { kind: 'doc'; path: string; title: string; side?: 'left' | 'right' }
  | { kind: 'terminal'; tab: TerminalTabPayload }

export interface TabMoveResult {
  action: 'moved' | 'none'
  removeSource?: boolean
}

export interface WorkspaceDocTabPayload {
  id: string
  title: string
  kind: 'markdown' | 'mdview' | 'file' | 'pdf' | 'image' | 'hwp' | 'csv' | 'settings'
  path?: string
  side?: 'left' | 'right'
}

export interface WorkspaceSnapshot {
  version: number
  savedAt: string
  workspaceId?: string
  workspaceLabel?: string
  mode: 'explorer' | 'cases' | 'viewer'
  docs: WorkspaceDocTabPayload[]
  terminals: TerminalTabPayload[]
  activeDoc?: string
  activeTerm?: string
  activeWork?: { left?: string; right?: string }
  currentCase?: unknown
  crop?: { on: boolean; ratio: number }
}

export interface WorkspaceEntry {
  id: string
  label: string
  savedAt: string
  path: string
  docs: number
  terminals: number
  cwd?: string
  folderName?: string
  caseNumber?: string
  caseName?: string
  court?: string
  client?: string
  recordsFolder?: string
  profileId?: string
  sshLabel?: string
  searchText?: string
}

export interface WorkspaceSaveResult {
  ok: boolean
  path?: string
  savedAt?: string
  entry?: WorkspaceEntry
  error?: string
  canceled?: boolean
}

export interface WorkspaceLoadResult {
  ok: boolean
  path?: string
  snapshot?: WorkspaceSnapshot | null
  entry?: WorkspaceEntry
  error?: string
  canceled?: boolean
}

export interface WorkspaceListResult {
  ok: boolean
  entries?: WorkspaceEntry[]
  error?: string
}

export interface SessionSearchContext {
  query?: string
  displayTitle?: string
  caseNumber?: string
  caseName?: string
  court?: string
  client?: string
  folderName?: string
  recordsFolder?: string
  profileId?: string
  sshLabel?: string
}

export interface SessionListEntry {
  sessionId: string
  title?: string
  transcriptTitle?: string
  mtime: number
  cwd?: string
  displayTitle?: string
  caseNumber?: string
  caseName?: string
  folderName?: string
  indexed?: boolean
}

export interface SessionRememberInput extends SessionSearchContext {
  sessionId: string
  cwd: string
  title?: string
  transcriptTitle?: string
  mtime?: number
  ssh?: SshConn
}

export interface AppSettings {
  draftsRoot?: string
  recordsRoot?: string
  caseOpenTarget?: string
  pdfZoom?: string
  termFont?: string
  termFontSize?: number
  notificationSound?: string
  notificationVolume?: number
  mdFont?: string
  mdFontSize?: number
  sshProfiles?: SshProfile[]
}

export interface JsParty {
  role: string
  position: string | null
  party: { name: string; type: string; phone?: string | null }
}
export interface JsHearing {
  type: string
  dateTime: string
  location?: string | null
  note?: string | null
  status?: string
}
export interface JsCase {
  id: string
  caseNumber: string | null
  caseName: string | null
  court: string | null
  division: string | null
  caseType: string | null
  status: string
  parties: JsParty[]
  hearings: JsHearing[]
  updatedAt?: string
  _count?: { parties: number; hearings: number; progresses: number; documents: number }
}

export interface LtApi {
  js: {
    setToken: (token: string) => Promise<void>
    hasToken: () => Promise<boolean>
    listCases: (params?: {
      search?: string
      status?: string
      caseType?: string
    }) => Promise<{ ok: boolean; cases?: JsCase[]; error?: string }>
    getCase: (id: string) => Promise<{ ok: boolean; case?: JsCase; error?: string }>
  }
  app: {
    info: () => Promise<{
      platform: string
      versions: { electron: string; node: string; chrome: string }
    }>
    openExternal: (url: string) => Promise<void>
    newWindow: () => Promise<void>
    onCloseActiveTab: (cb: () => void) => () => void
  }
  dialog: {
    openCase: () => Promise<{ path: string; name: string } | null>
    pickFolder: (opts?: {
      title?: string
      defaultPath?: string
    }) => Promise<{ path: string; name: string } | null>
  }
  settings: {
    get: () => Promise<AppSettings>
    set: (patch: Partial<AppSettings>) => Promise<AppSettings>
  }
  export: {
    mdToPdf: (
      html: string,
      defaultPath?: string
    ) => Promise<{ ok: boolean; path?: string; error?: string }>
  }
  fs: {
    list: (dirPath: string) => Promise<{ name: string; path: string; isDir: boolean; mtimeMs?: number }[]>
    readBytes: (filePath: string) => Promise<ArrayBuffer>
    readHwpText: (filePath: string) => Promise<{ ok: boolean; text: string; error?: string }>
    writeText: (path: string, content: string) => Promise<{ ok: boolean; error?: string }>
    saveAs: (
      content: string,
      defaultPath?: string
    ) => Promise<{ ok: boolean; path?: string; error?: string }>
    copyInto: (destDir: string, srcPaths: string[]) => Promise<{ copied: string[] }>
    move: (src: string, destDir: string) => Promise<{ ok: boolean; path?: string; error?: string }>
    delete: (path: string) => Promise<{ ok: boolean; error?: string }>
    mkdir: (dir: string, name: string) => Promise<{ ok: boolean; error?: string }>
    createFile: (
      dir: string,
      name: string,
      content?: string
    ) => Promise<{ ok: boolean; path?: string; error?: string }>
    pathForFile: (file: File) => string
    listPdfs: (dir: string) => Promise<{ name: string; path: string }[]>
    readText: (filePath: string) => Promise<{
      ext: string
      kind: 'text' | 'binary'
      text: string
      size: number
      truncated?: boolean
    }>
    stat: (
      filePath: string
    ) => Promise<
      | { ok: true; size: number; isDir: boolean; mtimeMs?: number }
      | { ok: false; error: string }
    >
    clipboardFiles: () => Promise<{ paths: string[]; formats: string[] }>
    download: (
      source: string
    ) => Promise<{ ok: boolean; path?: string; count?: number; canceled?: boolean; error?: string }>
  }
  case: {
    getPairing: (drafts: string) => Promise<string | undefined>
    setPairing: (drafts: string, records: string) => Promise<void>
    getJsPairing: (id: string) => Promise<{ drafts: string; records?: string } | undefined>
    setJsPairing: (id: string, drafts: string, records?: string) => Promise<void>
    history: () => Promise<{ drafts: string; records?: string; name: string; ts: number }[]>
    addHistory: (entry: {
      drafts: string
      records?: string
      name: string
    }) => Promise<{ drafts: string; records?: string; name: string; ts: number }[]>
  }
  ssh: {
    listDir: (
      profile: SshProfile,
      path: string
    ) => Promise<
      { ok: true; entries: RemoteEntry[]; cwd: string } | { ok: false; error: string }
    >
  }
  sync: {
    remoteInfo: (
      profile: SshProfile
    ) => Promise<{ installed: boolean; remotes: string[]; error?: string }>
    run: (opts: {
      profile: SshProfile
      direction: 'pull' | 'push'
      mode?: 'full' | 'folders'
      macFolder: string
      dest: string
    }) => Promise<{ ok: boolean; code: number | null; error?: string }>
    cancel: () => void
    onProgress: (cb: (line: string) => void) => () => void
  }
  sessions: {
    current: (
      cwd: string,
      since?: number,
      ssh?: SshConn
    ) => Promise<{ sessionId: string; title?: string } | null>
    list: (
      cwd: string,
      ssh?: SshConn,
      context?: SessionSearchContext
    ) => Promise<SessionListEntry[]>
    remember: (input: SessionRememberInput) => Promise<{ ok: boolean; error?: string }>
  }
  workspace: {
    save: (snapshot: WorkspaceSnapshot) => Promise<WorkspaceSaveResult>
    list: () => Promise<WorkspaceListResult>
    load: (id?: string) => Promise<WorkspaceLoadResult>
    exportFile: (snapshot: WorkspaceSnapshot) => Promise<WorkspaceSaveResult>
    importFile: () => Promise<WorkspaceLoadResult>
  }
  claude: {
    ask: (payload: string) => Promise<void>
    onIncoming: (cb: (payload: string) => void) => () => void
  }
  tabs: {
    beginDrag: (payload: TabPayload) => Promise<void>
    dropOnTabBar: (side?: 'left' | 'right') => Promise<TabMoveResult>
    endDrag: () => Promise<TabMoveResult>
    ready: () => Promise<void>
    onReceive: (cb: (p: TabPayload) => void) => () => void
  }
  pty: {
    create: (opts: PtyCreateOpts) => Promise<void>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    detach: (id: string) => void
    kill: (id: string) => void
    onData: (cb: (p: { id: string; data: string }) => void) => () => void
    onExit: (cb: (p: { id: string; exitCode: number }) => void) => () => void
  }
}

declare global {
  interface Window {
    lt: LtApi
  }
}
