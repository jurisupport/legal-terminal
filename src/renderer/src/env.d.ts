/// <reference types="vite/client" />

export interface PtyCreateOpts {
  id: string
  cwd?: string
  cols: number
  rows: number
  autoLaunchClaude?: boolean
  resumeSessionId?: string
}

export interface AppSettings {
  draftsRoot?: string
  recordsRoot?: string
  pdfZoom?: string
  termFont?: string
  termFontSize?: number
  mdFont?: string
  mdFontSize?: number
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
    list: (dirPath: string) => Promise<{ name: string; path: string; isDir: boolean }[]>
    readBytes: (filePath: string) => Promise<ArrayBuffer>
    readHwpText: (filePath: string) => Promise<{ ok: boolean; text: string; error?: string }>
    writeText: (path: string, content: string) => Promise<{ ok: boolean; error?: string }>
    saveAs: (
      content: string,
      defaultPath?: string
    ) => Promise<{ ok: boolean; path?: string; error?: string }>
    copyInto: (destDir: string, srcPaths: string[]) => Promise<{ copied: string[] }>
    move: (src: string, destDir: string) => Promise<{ ok: boolean; path?: string; error?: string }>
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
  sessions: {
    current: (
      cwd: string,
      since?: number
    ) => Promise<{ sessionId: string; title?: string } | null>
    list: (cwd: string) => Promise<{ sessionId: string; title?: string; mtime: number }[]>
  }
  claude: {
    ask: (payload: string) => Promise<void>
    onIncoming: (cb: (payload: string) => void) => () => void
  }
  tabs: {
    beginDrag: (payload: { path: string; title: string }) => Promise<void>
    endDrag: () => Promise<{ action: 'moved' | 'none' }>
    ready: () => Promise<void>
    onReceive: (cb: (p: { path: string; title: string }) => void) => () => void
  }
  pty: {
    create: (opts: PtyCreateOpts) => Promise<void>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
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
