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
  quickStartPaths?: string[]
}

export interface RemoteEntry {
  name: string
  path: string
  isDir: boolean
  mtimeMs?: number
}

export interface FsListOptions {
  refresh?: boolean
}

export interface FileSignature {
  size: number
  mtimeMs?: number
}

export interface FsWriteTextOptions {
  expected?: FileSignature
}

export type FsWriteTextResult =
  | { ok: true; stat?: FileSignature }
  | { ok: false; error?: string; conflict?: boolean; stat?: FileSignature }

export interface FsDownloadProgress {
  id: string
  source: string
  name: string
  isDir: boolean
  phase: 'preparing' | 'downloading' | 'done' | 'error'
  totalFiles: number
  completedFiles: number
  totalBytes?: number
  downloadedBytes?: number
  currentFile?: string
  destPath?: string
  error?: string
}

export interface FsWatchEvent {
  dir: string
  path?: string
  eventType?: string
}

export interface FolderMatchSuggestion {
  path: string
  name: string
  reason: string
  score: number
}

export interface PtyCreateOpts {
  id: string
  cwd?: string
  cols: number
  rows: number
  autoLaunchAgent?: AgentProvider
  autoLaunchClaude?: boolean
  resumeSessionId?: string
  ssh?: SshConn
}

export interface TerminalTabPayload {
  id: string
  title: string
  kind?: 'terminal' | 'agent'
  caseTabId?: string
  cwd: string
  recordsFolder?: string
  suggestedRecords?: string
  suggestedRecordOptions?: FolderMatchSuggestion[]
  autoClaude?: boolean
  autoAgent?: AgentProvider
  agentProvider?: AgentProvider
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

export interface DocumentTabPayload {
  id?: string
  title: string
  kind?: 'markdown' | 'mdview' | 'file' | 'pdf' | 'image' | 'hwp' | 'docx' | 'csv' | 'settings' | 'hearing'
  caseTabId?: string
  path?: string
  side?: 'left' | 'right'
}

export type TabPayload =
  | {
      kind: 'doc'
      tab?: DocumentTabPayload
      path?: string
      title?: string
      side?: 'left' | 'right'
    }
  | { kind: 'terminal'; tab: TerminalTabPayload }

export interface NewWindowOptions {
  tabs?: TabPayload[]
}

export interface TabMoveResult {
  action: 'moved' | 'none'
  removeSource?: boolean
}

export interface WorkspaceDocTabPayload {
  id: string
  title: string
  kind: 'markdown' | 'mdview' | 'file' | 'pdf' | 'image' | 'hwp' | 'docx' | 'csv' | 'settings' | 'hearing'
  caseTabId?: string
  path?: string
  side?: 'left' | 'right'
}

export interface WorkspaceCaseTabPayload {
  id: string
  name: string
  drafts: string
  records?: string
  suggestedRecords?: string
  suggestedRecordOptions?: FolderMatchSuggestion[]
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

export interface DocumentDraftIdentity {
  path?: string
  draftId?: string
}

export interface DocumentDraftEntry {
  key: string
  path?: string
  draftId?: string
  title: string
  content: string
  savedAt: string
}

export interface DocumentDraftHistoryEntry {
  id: string
  key: string
  path?: string
  draftId?: string
  title: string
  content: string
  savedAt: string
}

export interface WorkspaceSnapshot {
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

export interface SessionTranscriptMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export interface SessionTranscript {
  sessionId: string
  messages: SessionTranscriptMessage[]
  mtime: number
  truncated?: boolean
}

export type AgentPermissionMode = 'ask' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk'
export type AgentProvider = 'claude' | 'codex'

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
  agentFontSize?: number
  agentDefaultPermissionMode?: AgentPermissionMode
  agentDefaultProvider?: AgentProvider
  explorerSortMode?: string
  remotePickerSortMode?: string
  remoteDirectoryCache?: boolean
  remoteFileCache?: boolean
  sshProfiles?: SshProfile[]
}

export interface AgentAttachment {
  kind: 'file' | 'folder' | 'selection' | 'pdf-page-range' | 'terminal-snippet'
  label: string
  path?: string
  origin?: 'local' | 'remote'
  access?: 'workspace-path' | 'context-only'
  range?: { startLine?: number; endLine?: number; startPage?: number; endPage?: number }
  source?: {
    docId?: string
    path?: string
    title?: string
    text?: string
    range?: {
      startLine?: number
      startColumn?: number
      endLine?: number
      endColumn?: number
      startPage?: number
      endPage?: number
    }
  }
  text?: string
  content?: string
  contentTruncated?: boolean
}

export interface AgentCreateOptions {
  id: string
  cwd: string
  title?: string
  provider?: AgentProvider
  model?: string
  permissionMode?: AgentPermissionMode
  resumeSessionId?: string
  tools?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  source?: 'local' | 'ssh'
  ssh?: SshConn
}

export interface AgentWorktreeForkInput {
  cwd: string
  branchName?: string
}

export interface AgentWorktreeForkResult extends AgentCommandResult {
  path?: string
  root?: string
  branchName?: string
}

export interface AgentSessionSnapshot {
  id: string
  cwd: string
  title?: string
  provider: AgentProvider
  source: 'local' | 'ssh'
  resumeSessionId?: string
}

export interface AgentSessionSnapshotResult extends AgentCommandResult {
  session?: AgentSessionSnapshot
}

export interface AgentModelOption {
  id: string
  model: string
  displayName: string
  description?: string
  isDefault?: boolean
  supportedReasoningEfforts?: AgentReasoningEffortOption[]
  defaultReasoningEffort?: string
}

export interface AgentModelListResult extends AgentCommandResult {
  models?: AgentModelOption[]
  selectedModel?: string
  selectedReasoningEffort?: string
}

export interface AgentReasoningEffortOption {
  reasoningEffort: string
  description?: string
}

export interface AgentSendInput {
  text: string
  displayText?: string
  attachments?: AgentAttachment[]
  permissionMode?: AgentPermissionMode
  delivery?: 'normal' | 'queue' | 'steer'
}

export interface AgentPermissionDecision {
  sessionId?: string
  requestId: string
  decision: 'allow' | 'reject'
  message?: string
  remember?: boolean
}

export interface AgentDialogAnswer {
  sessionId: string
  dialogId: string
  answers?: Record<string, string>
  response?: string
  cancelled?: boolean
}

export interface AgentCommandResult {
  ok: boolean
  error?: string
}

export type AgentEvent = { type: string; sessionId?: string; [key: string]: unknown }

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
  memo?: string | null
  parties: JsParty[]
  hearings: JsHearing[]
  updatedAt?: string
  _count?: { parties: number; hearings: number; progresses: number; documents: number }
}

export interface JsTodoProgress {
  id?: string
  text: string
  createdAt?: string
  source?: string
  terminalId?: string
  cwd?: string
}

export interface JsTodo {
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

export interface ListTodosParams {
  page?: number
  limit?: number
  search?: string
  status?: string
  caseId?: string
  includeArchived?: boolean
}

export interface TodoMutationInput {
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

export interface TodoTerminalContext {
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

export interface TodoTerminalResult {
  ok: boolean
  message: string
  changed?: boolean
  todo?: JsTodo | null
  todos?: JsTodo[]
}

export interface LtApi {
  js: {
    setToken: (token: string) => Promise<void>
    hasToken: () => Promise<boolean>
    listCases: (params?: {
      page?: number
      limit?: number
      search?: string
      status?: string
      caseType?: string
      refresh?: boolean
    }) => Promise<{ ok: boolean; cases?: JsCase[]; error?: string }>
    getCase: (id: string) => Promise<{ ok: boolean; case?: JsCase; error?: string }>
  }
  todo: {
    list: (params?: ListTodosParams) => Promise<{ ok: boolean; todos?: JsTodo[]; error?: string }>
    get: (id: string) => Promise<{ ok: boolean; todo?: JsTodo | null; error?: string }>
    create: (input: TodoMutationInput) => Promise<{ ok: boolean; todo?: JsTodo | null; error?: string }>
    update: (
      id: string,
      patch: TodoMutationInput
    ) => Promise<{ ok: boolean; todo?: JsTodo | null; error?: string }>
    complete: (
      id: string,
      progressText?: string,
      context?: TodoTerminalContext
    ) => Promise<{ ok: boolean; todo?: JsTodo | null; error?: string }>
    archive: (id: string) => Promise<{ ok: boolean; todo?: JsTodo | null; error?: string }>
    appendProgress: (
      id: string,
      text: string,
      context?: TodoTerminalContext
    ) => Promise<{ ok: boolean; todo?: JsTodo | null; error?: string }>
    applyTerminalCommand: (
      command: string,
      context?: TodoTerminalContext
    ) => Promise<TodoTerminalResult>
  }
  app: {
    info: () => Promise<{
      version: string
      platform: string
      versions: { electron: string; node: string; chrome: string }
    }>
    openExternal: (url: string) => Promise<void>
    newWindow: (opts?: NewWindowOptions) => Promise<void>
    closeWindow: () => Promise<void>
    forceCloseWindow: () => Promise<void>
    setWindowTitle: (title: string) => Promise<void>
    requestAttention: (reason?: 'done' | 'question') => void
    onCloseActiveTab: (cb: () => void) => () => void
    onCloseActiveCaseTab: (cb: () => void) => () => void
    onCloseWindowRequest: (cb: () => void) => () => void
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
    mdToHwpx: (
      markdown: string,
      title?: string,
      defaultPath?: string
    ) => Promise<{ ok: boolean; path?: string; error?: string }>
  }
  fs: {
    list: (
      dirPath: string,
      opts?: FsListOptions
    ) => Promise<{ name: string; path: string; isDir: boolean; mtimeMs?: number }[]>
    readBytes: (filePath: string) => Promise<ArrayBuffer>
    readHwpText: (filePath: string) => Promise<{ ok: boolean; text: string; error?: string }>
    readHwpMarkdown: (
      filePath: string
    ) => Promise<{ ok: boolean; markdown: string; error?: string }>
    readDocxText: (filePath: string) => Promise<{ ok: boolean; text: string; error?: string }>
    writeText: (
      path: string,
      content: string,
      options?: FsWriteTextOptions
    ) => Promise<FsWriteTextResult>
    saveAs: (
      content: string,
      defaultPath?: string
    ) => Promise<{ ok: boolean; path?: string; error?: string }>
    saveDocumentDraft: (
      identity: DocumentDraftIdentity & { title?: string; content: string }
    ) => Promise<{ ok: boolean; entry?: DocumentDraftEntry; error?: string }>
    addDocumentDraftHistory: (
      identity: DocumentDraftIdentity & { title?: string; content: string }
    ) => Promise<{ ok: boolean; entry?: DocumentDraftHistoryEntry; error?: string }>
    loadDocumentDraft: (
      identity: DocumentDraftIdentity
    ) => Promise<{ ok: boolean; draft?: DocumentDraftEntry | null; error?: string }>
    listDocumentDrafts: () => Promise<{
      ok: boolean
      drafts?: DocumentDraftEntry[]
      error?: string
    }>
    listDocumentDraftHistory: (identity: DocumentDraftIdentity) => Promise<{
      ok: boolean
      history?: DocumentDraftHistoryEntry[]
      error?: string
    }>
    deleteDocumentDraft: (identity: DocumentDraftIdentity) => Promise<{ ok: boolean; error?: string }>
    copyInto: (destDir: string, srcPaths: string[]) => Promise<{ copied: string[] }>
    move: (src: string, destDir: string) => Promise<{ ok: boolean; path?: string; error?: string }>
    rename: (path: string, name: string) => Promise<{ ok: boolean; path?: string; error?: string }>
    delete: (path: string) => Promise<{ ok: boolean; error?: string }>
    mkdir: (dir: string, name: string) => Promise<{ ok: boolean; path?: string; error?: string }>
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
      mtimeMs?: number
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
    onDownloadProgress: (cb: (progress: FsDownloadProgress) => void) => () => void
    watch: (dir: string, cb: (event: FsWatchEvent) => void) => () => void
    autoDownloadRecords: (source: string) => Promise<{
      ok: boolean
      path?: string
      count?: number
      downloaded?: number
      skipped?: number
      failed?: number
      inProgress?: boolean
      error?: string
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
  ssh: {
    listDir: (
      profile: SshProfile,
      path: string,
      opts?: { refresh?: boolean }
    ) => Promise<
      { ok: true; entries: RemoteEntry[]; cwd: string } | { ok: false; error: string }
    >
    searchDirs: (
      profile: SshProfile,
      path: string,
      opts: { query: string; maxDepth?: number; limit?: number }
    ) => Promise<
      | { ok: true; entries: RemoteEntry[]; cwd: string; truncated?: boolean }
      | { ok: false; error: string }
    >
    test: (
      profile: SshProfile
    ) => Promise<{ ok: true; cwd: string } | { ok: false; error: string }>
    clearDirCache: () => Promise<{ ok: boolean; error?: string }>
  }
  sync: {
    remoteInfo: (
      profile: SshProfile
    ) => Promise<{ installed: boolean; remotes: string[]; error?: string }>
    run: (opts: {
      profile: SshProfile
      direction: 'pull' | 'push'
      mode?: 'full' | 'folders' | 'file'
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
    transcript: (sessionId: string, ssh?: SshConn) => Promise<SessionTranscript | null>
    remember: (input: SessionRememberInput) => Promise<{ ok: boolean; error?: string }>
  }
  agent: {
    create: (opts: AgentCreateOptions) => Promise<AgentCommandResult>
    snapshot: (sessionId: string) => Promise<AgentSessionSnapshotResult>
    worktreeFork: (input: AgentWorktreeForkInput) => Promise<AgentWorktreeForkResult>
    send: (sessionId: string, input: AgentSendInput) => Promise<AgentCommandResult>
    models: (sessionId: string) => Promise<AgentModelListResult>
    setModel: (sessionId: string, model?: string, reasoningEffort?: string) => Promise<AgentCommandResult>
    slashCommand: (sessionId: string, command: string, argument?: string) => Promise<AgentCommandResult>
    mcpStatus: (sessionId: string) => Promise<AgentCommandResult>
    promoteQueued: (sessionId: string, queueId: string) => Promise<AgentCommandResult>
    removeQueued: (sessionId: string, queueId: string) => Promise<AgentCommandResult>
    approve: (decision: AgentPermissionDecision) => Promise<AgentCommandResult>
    answerDialog: (answer: AgentDialogAnswer) => Promise<AgentCommandResult>
    interrupt: (sessionId: string) => Promise<AgentCommandResult>
    close: (sessionId: string) => Promise<AgentCommandResult>
    authLogin: (sessionId: string) => Promise<AgentCommandResult>
    authInput: (sessionId: string, text: string) => Promise<AgentCommandResult>
    onEvent: (cb: (event: AgentEvent) => void) => () => void
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
