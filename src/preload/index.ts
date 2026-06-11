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
  quickStartPaths?: string[]
}

interface RemoteEntry {
  name: string
  path: string
  isDir: boolean
  mtimeMs?: number
}

interface FsListOptions {
  refresh?: boolean
}

interface FileSignature {
  size: number
  mtimeMs?: number
}

interface FsWriteTextOptions {
  expected?: FileSignature
}

type FsWriteTextResult =
  | { ok: true; stat?: FileSignature }
  | { ok: false; error?: string; conflict?: boolean; stat?: FileSignature }

interface FolderMatchSuggestion {
  path: string
  name: string
  reason: string
  score: number
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
  kind?: 'terminal' | 'agent'
  caseTabId?: string
  cwd: string
  recordsFolder?: string
  suggestedRecords?: string
  suggestedRecordOptions?: FolderMatchSuggestion[]
  autoClaude?: boolean
  jsId?: string
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
  opponent?: string
  partyNames?: string
  memo?: string
  sessionTitle?: string
  renamed?: boolean
  createdAt?: number
  resumeSessionId?: string
  ssh?: SshConn
  sshLabel?: string
  profileId?: string
  side?: 'left' | 'right'
}

interface DocumentTabPayload {
  id?: string
  title: string
  kind?: 'markdown' | 'mdview' | 'file' | 'pdf' | 'image' | 'hwp' | 'docx' | 'csv' | 'settings' | 'hearing'
  caseTabId?: string
  path?: string
  side?: 'left' | 'right'
}

type TabPayload =
  | {
      kind: 'doc'
      tab?: DocumentTabPayload
      path?: string
      title?: string
      side?: 'left' | 'right'
    }
  | { kind: 'terminal'; tab: TerminalTabPayload }

interface NewWindowOptions {
  tabs?: TabPayload[]
}

interface TabMoveResult {
  action: 'moved' | 'none'
  removeSource?: boolean
}

interface WorkspaceDocTabPayload {
  id: string
  title: string
  kind: 'markdown' | 'mdview' | 'file' | 'pdf' | 'image' | 'hwp' | 'docx' | 'csv' | 'settings' | 'hearing'
  caseTabId?: string
  path?: string
  side?: 'left' | 'right'
}

interface WorkspaceCaseTabPayload {
  id: string
  name: string
  drafts: string
  records?: string
  meta?: {
    jsId?: string
    court?: string
    caseNumber?: string
    caseName?: string
    client?: string
    opponent?: string
    partyNames?: string
    memo?: string
  }
  ssh?: SshConn
  sshLabel?: string
  profileId?: string
  remotePath?: string
  activeDocId?: string
  activeTermId?: string
  activeWork?: { left?: string; right?: string }
  updatedAt?: number
}

interface DocumentDraftIdentity {
  path?: string
  draftId?: string
}

interface DocumentDraftEntry {
  key: string
  path?: string
  draftId?: string
  title: string
  content: string
  savedAt: string
}

interface WorkspaceSnapshot {
  version: number
  savedAt: string
  workspaceId?: string
  workspaceLabel?: string
  mode: 'explorer' | 'cases' | 'viewer' | 'todos'
  docs: WorkspaceDocTabPayload[]
  terminals: TerminalTabPayload[]
  caseTabs?: WorkspaceCaseTabPayload[]
  activeDoc?: string
  activeTerm?: string
  activeCaseTabId?: string
  activeWork?: { left?: string; right?: string }
  currentCase?: unknown
  crop?: { on: boolean; ratio: number }
}

interface WorkspaceEntry {
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

interface WorkspaceSaveResult {
  ok: boolean
  path?: string
  savedAt?: string
  entry?: WorkspaceEntry
  error?: string
  canceled?: boolean
}

interface WorkspaceLoadResult {
  ok: boolean
  path?: string
  snapshot?: WorkspaceSnapshot | null
  entry?: WorkspaceEntry
  error?: string
  canceled?: boolean
}

interface WorkspaceListResult {
  ok: boolean
  entries?: WorkspaceEntry[]
  error?: string
}

interface SessionSearchContext {
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

interface SessionListEntry {
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

interface SessionRememberInput extends SessionSearchContext {
  sessionId: string
  cwd: string
  title?: string
  transcriptTitle?: string
  mtime?: number
  ssh?: SshConn
}

interface SessionTranscriptMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

interface SessionTranscript {
  sessionId: string
  messages: SessionTranscriptMessage[]
  mtime: number
  truncated?: boolean
}

interface AppSettings {
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
  agentFontSize?: number
  explorerSortMode?: string
  remotePickerSortMode?: string
  remoteDirectoryCache?: boolean
  remoteFileCache?: boolean
  sshProfiles?: SshProfile[]
}

interface JsTodoProgress {
  id?: string
  text: string
  createdAt?: string
  source?: string
  terminalId?: string
  cwd?: string
}

interface JsTodo {
  id: string
  title: string
  status: string
  priority?: string | null
  dueDate?: string | null
  caseId?: string | null
  court?: string | null
  caseNumber?: string | null
  caseName?: string | null
  client?: string | null
  opponent?: string | null
  partyNames?: string | null
  notes?: string | null
  progress?: JsTodoProgress[]
  createdAt?: string
  updatedAt?: string
  completedAt?: string | null
}

interface ListTodosParams {
  page?: number
  limit?: number
  search?: string
  status?: string
  caseId?: string
  includeArchived?: boolean
}

interface TodoMutationInput {
  title?: string
  status?: string
  priority?: string
  dueDate?: string | null
  caseId?: string
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
  opponent?: string
  partyNames?: string
  notes?: string
}

interface TodoTerminalContext {
  terminalId?: string
  cwd?: string
  jsId?: string
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
  opponent?: string
  partyNames?: string
}

interface TodoTerminalResult {
  ok: boolean
  message: string
  changed?: boolean
  todo?: JsTodo | null
  todos?: JsTodo[]
}

type AgentPermissionMode = 'ask' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk'

interface AgentAttachment {
  kind: 'file' | 'folder' | 'selection' | 'pdf-page-range' | 'terminal-snippet'
  label: string
  path?: string
  origin?: 'local' | 'remote'
  access?: 'workspace-path' | 'context-only'
  range?: { startLine?: number; endLine?: number; startPage?: number; endPage?: number }
  text?: string
  content?: string
  contentTruncated?: boolean
}

interface AgentCreateOptions {
  id: string
  cwd: string
  title?: string
  model?: string
  permissionMode?: AgentPermissionMode
  resumeSessionId?: string
  tools?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  source?: 'local' | 'ssh'
  ssh?: SshConn
}

interface AgentWorktreeForkInput {
  cwd: string
  branchName?: string
}

interface AgentWorktreeForkResult extends AgentCommandResult {
  path?: string
  root?: string
  branchName?: string
}

interface AgentSendInput {
  text: string
  displayText?: string
  attachments?: AgentAttachment[]
  permissionMode?: AgentPermissionMode
  delivery?: 'normal' | 'queue' | 'steer'
}

interface AgentPermissionDecision {
  sessionId?: string
  requestId: string
  decision: 'allow' | 'reject'
  message?: string
  remember?: boolean
}

interface AgentDialogAnswer {
  sessionId: string
  dialogId: string
  answers?: Record<string, string>
  response?: string
  cancelled?: boolean
}

interface AgentCommandResult {
  ok: boolean
  error?: string
}

type AgentEvent = { type: string; sessionId?: string; [key: string]: unknown }

const api = {
  app: {
    info: (): Promise<{
      platform: string
      versions: { electron: string; node: string; chrome: string }
    }> => ipcRenderer.invoke('app:info'),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
    newWindow: (opts?: NewWindowOptions): Promise<void> => ipcRenderer.invoke('window:new', opts),
    closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
    forceCloseWindow: (): Promise<void> => ipcRenderer.invoke('window:forceClose'),
    setWindowTitle: (title: string): Promise<void> =>
      ipcRenderer.invoke('app:setWindowTitle', title),
    requestAttention: (reason?: 'done' | 'question'): void =>
      ipcRenderer.send('app:requestAttention', { reason }),
    onCloseActiveTab: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('app:closeActiveTab', listener)
      return () => ipcRenderer.removeListener('app:closeActiveTab', listener)
    },
    onCloseWindowRequest: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('app:closeWindowRequested', listener)
      return () => ipcRenderer.removeListener('app:closeWindowRequested', listener)
    }
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
      dirPath: string,
      opts?: FsListOptions
    ): Promise<{ name: string; path: string; isDir: boolean; mtimeMs?: number }[]> =>
      ipcRenderer.invoke('fs:list', dirPath, opts),
    readBytes: (filePath: string): Promise<ArrayBuffer> =>
      ipcRenderer.invoke('fs:readBytes', filePath),
    readHwpText: (
      filePath: string
    ): Promise<{ ok: boolean; text: string; error?: string }> =>
      ipcRenderer.invoke('fs:readHwpText', filePath),
    readHwpMarkdown: (
      filePath: string
    ): Promise<{ ok: boolean; markdown: string; error?: string }> =>
      ipcRenderer.invoke('fs:readHwpMarkdown', filePath),
    readDocxText: (
      filePath: string
    ): Promise<{ ok: boolean; text: string; error?: string }> =>
      ipcRenderer.invoke('fs:readDocxText', filePath),
    writeText: (
      path: string,
      content: string,
      options?: FsWriteTextOptions
    ): Promise<FsWriteTextResult> =>
      ipcRenderer.invoke('fs:writeText', { path, content, ...options }),
    saveAs: (
      content: string,
      defaultPath?: string
    ): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('fs:saveAs', { content, defaultPath }),
    saveDocumentDraft: (
      identity: DocumentDraftIdentity & { title?: string; content: string }
    ): Promise<{ ok: boolean; entry?: DocumentDraftEntry; error?: string }> =>
      ipcRenderer.invoke('fs:saveDocumentDraft', identity),
    loadDocumentDraft: (
      identity: DocumentDraftIdentity
    ): Promise<{ ok: boolean; draft?: DocumentDraftEntry | null; error?: string }> =>
      ipcRenderer.invoke('fs:loadDocumentDraft', identity),
    listDocumentDrafts: (): Promise<{
      ok: boolean
      drafts?: DocumentDraftEntry[]
      error?: string
    }> => ipcRenderer.invoke('fs:listDocumentDrafts'),
    deleteDocumentDraft: (
      identity: DocumentDraftIdentity
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:deleteDocumentDraft', identity),
    copyInto: (destDir: string, srcPaths: string[]): Promise<{ copied: string[] }> =>
      ipcRenderer.invoke('fs:copyInto', { destDir, srcPaths }),
    clipboardFiles: (): Promise<{ paths: string[]; formats: string[] }> =>
      ipcRenderer.invoke('fs:clipboardFiles'),
    download: (
      source: string
    ): Promise<{ ok: boolean; path?: string; count?: number; canceled?: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:download', source),
    autoDownloadRecords: (
      source: string
    ): Promise<{
      ok: boolean
      path?: string
      count?: number
      downloaded?: number
      skipped?: number
      failed?: number
      inProgress?: boolean
      error?: string
    }> => ipcRenderer.invoke('fs:autoDownloadRecords', source),
    move: (src: string, destDir: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('fs:move', { src, destDir }),
    rename: (
      path: string,
      name: string
    ): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('fs:rename', { path, name }),
    delete: (path: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:delete', path),
    mkdir: (dir: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
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
      mtimeMs?: number
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
      params?: {
        page?: number
        limit?: number
        search?: string
        status?: string
        caseType?: string
      }
    ): Promise<{ ok: boolean; cases?: unknown[]; error?: string }> =>
      ipcRenderer.invoke('js:listCases', params ?? {}),
    getCase: (id: string): Promise<{ ok: boolean; case?: unknown; error?: string }> =>
      ipcRenderer.invoke('js:getCase', id)
  },
  todo: {
    list: (params?: ListTodosParams): Promise<{ ok: boolean; todos?: JsTodo[]; error?: string }> =>
      ipcRenderer.invoke('todo:list', params ?? {}),
    get: (id: string): Promise<{ ok: boolean; todo?: JsTodo | null; error?: string }> =>
      ipcRenderer.invoke('todo:get', id),
    create: (input: TodoMutationInput): Promise<{ ok: boolean; todo?: JsTodo | null; error?: string }> =>
      ipcRenderer.invoke('todo:create', input),
    update: (
      id: string,
      patch: TodoMutationInput
    ): Promise<{ ok: boolean; todo?: JsTodo | null; error?: string }> =>
      ipcRenderer.invoke('todo:update', { id, patch }),
    complete: (
      id: string,
      progressText?: string,
      context?: TodoTerminalContext
    ): Promise<{ ok: boolean; todo?: JsTodo | null; error?: string }> =>
      ipcRenderer.invoke('todo:complete', { id, progressText, context }),
    archive: (id: string): Promise<{ ok: boolean; todo?: JsTodo | null; error?: string }> =>
      ipcRenderer.invoke('todo:archive', id),
    appendProgress: (
      id: string,
      text: string,
      context?: TodoTerminalContext
    ): Promise<{ ok: boolean; todo?: JsTodo | null; error?: string }> =>
      ipcRenderer.invoke('todo:appendProgress', { id, text, context }),
    applyTerminalCommand: (
      command: string,
      context?: TodoTerminalContext
    ): Promise<TodoTerminalResult> =>
      ipcRenderer.invoke('todo:applyTerminalCommand', { command, context })
  },
  ssh: {
    // 원격 디렉터리 목록 (사건 폴더 선택용). 키/agent 인증 시에만 성공.
    listDir: (
      profile: SshProfile,
      path: string,
      opts?: { refresh?: boolean }
    ): Promise<
      { ok: true; entries: RemoteEntry[]; cwd: string } | { ok: false; error: string }
    > => ipcRenderer.invoke('ssh:listDir', { profile, path, ...opts }),
    searchDirs: (
      profile: SshProfile,
      path: string,
      opts: { query: string; maxDepth?: number; limit?: number }
    ): Promise<
      | { ok: true; entries: RemoteEntry[]; cwd: string; truncated?: boolean }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('ssh:searchDirs', { profile, path, ...opts }),
    clearDirCache: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('ssh:clearDirCache')
  },
  sync: {
    remoteInfo: (
      profile: SshProfile
    ): Promise<{ installed: boolean; remotes: string[]; error?: string }> =>
      ipcRenderer.invoke('sync:remoteInfo', profile),
    run: (opts: {
      profile: SshProfile
      direction: 'pull' | 'push'
      mode?: 'full' | 'folders'
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
      ssh?: SshConn,
      context?: SessionSearchContext
    ): Promise<SessionListEntry[]> =>
      ipcRenderer.invoke('sessions:list', { cwd, ssh, context }),
    transcript: (sessionId: string, ssh?: SshConn): Promise<SessionTranscript | null> =>
      ipcRenderer.invoke('sessions:transcript', { sessionId, ssh }),
    remember: (input: SessionRememberInput): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('sessions:remember', input)
  },
  agent: {
    create: (opts: AgentCreateOptions): Promise<AgentCommandResult> =>
      ipcRenderer.invoke('agent:create', opts),
    worktreeFork: (input: AgentWorktreeForkInput): Promise<AgentWorktreeForkResult> =>
      ipcRenderer.invoke('agent:worktreeFork', input),
    send: (sessionId: string, input: AgentSendInput): Promise<AgentCommandResult> =>
      ipcRenderer.invoke('agent:send', { sessionId, input }),
    mcpStatus: (sessionId: string): Promise<AgentCommandResult> =>
      ipcRenderer.invoke('agent:mcpStatus', sessionId),
    promoteQueued: (sessionId: string, queueId: string): Promise<AgentCommandResult> =>
      ipcRenderer.invoke('agent:promoteQueued', { sessionId, queueId }),
    removeQueued: (sessionId: string, queueId: string): Promise<AgentCommandResult> =>
      ipcRenderer.invoke('agent:removeQueued', { sessionId, queueId }),
    approve: (decision: AgentPermissionDecision): Promise<AgentCommandResult> =>
      ipcRenderer.invoke('agent:approve', decision),
    answerDialog: (answer: AgentDialogAnswer): Promise<AgentCommandResult> =>
      ipcRenderer.invoke('agent:answerDialog', answer),
    interrupt: (sessionId: string): Promise<AgentCommandResult> =>
      ipcRenderer.invoke('agent:interrupt', sessionId),
    close: (sessionId: string): Promise<AgentCommandResult> =>
      ipcRenderer.invoke('agent:close', sessionId),
    authLogin: (sessionId: string): Promise<AgentCommandResult> =>
      ipcRenderer.invoke('agent:authLogin', sessionId),
    authInput: (sessionId: string, text: string): Promise<AgentCommandResult> =>
      ipcRenderer.invoke('agent:authInput', { sessionId, input: { text } }),
    onEvent: (cb: (event: AgentEvent) => void): (() => void) => {
      const listener = (_e: unknown, event: AgentEvent): void => cb(event)
      ipcRenderer.on('agent:event', listener)
      return () => ipcRenderer.removeListener('agent:event', listener)
    }
  },
  workspace: {
    save: (snapshot: WorkspaceSnapshot): Promise<WorkspaceSaveResult> =>
      ipcRenderer.invoke('workspace:save', snapshot),
    list: (): Promise<WorkspaceListResult> => ipcRenderer.invoke('workspace:list'),
    load: (id?: string): Promise<WorkspaceLoadResult> => ipcRenderer.invoke('workspace:load', id),
    exportFile: (snapshot: WorkspaceSnapshot): Promise<WorkspaceSaveResult> =>
      ipcRenderer.invoke('workspace:exportFile', snapshot),
    importFile: (): Promise<WorkspaceLoadResult> => ipcRenderer.invoke('workspace:importFile')
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
    dropOnTabBar: (side?: 'left' | 'right'): Promise<TabMoveResult> =>
      ipcRenderer.invoke('tabs:dropOnTabBar', { side }),
    endDrag: (): Promise<TabMoveResult> => ipcRenderer.invoke('tabs:endDrag'),
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
