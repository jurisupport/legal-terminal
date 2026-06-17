import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Decoration, EditorView, keymap, drawSelection, dropCursor, type DecorationSet } from '@codemirror/view'
import {
  EditorSelection,
  EditorState,
  Compartment,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type ChangeDesc
} from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { livePreview } from './livePreview'
import { mdToPrintHtml, type PrintLayoutProfile } from './mdExport'
import { mergeTextAgainstBase } from './threeWayMerge'
import FindBar from '../search/FindBar'
import { IconAlignCenter, IconHistory, IconSave, IconSaveAs, IconSearch } from '../icons/Icons'
import { writeMarkdownDataTransfer } from '../markdownClipboard'
import type { DocumentDraftHistoryEntry } from '../env'

const DEFAULT_MD_FONT = "'D2Coding', 'Cascadia Mono', Consolas, monospace"
const DEFAULT_UNTITLED_NAME = '무제.md'
const EXTERNAL_FILE_POLL_MS = 2500
const CLAUDE_DRAFT_FILE_POLL_MS = 750
const ALIGN_CENTER_OPEN = '<!-- lt-align:center -->'
const ALIGN_CENTER_CLOSE = '<!-- /lt-align -->'
export const TEXT_SELECTION_OVERLAY_EVENT = 'lt:text-selection-overlay'
export const MARKDOWN_CENTER_SELECTION_EVENT = 'lt:markdown-center-selection'

export interface TextSelectionOverlayDetail {
  x: number
  y: number
  text: string
  markdown?: string
  editorDraftId?: string
  count: number
}

interface TextReplacement {
  from: number
  to: number
  insert: string
}

interface FileSignature {
  size: number
  mtimeMs?: number
}

interface PositionBookmark {
  line: number
  column: number
}

interface SelectionBookmark {
  ranges: { anchor: PositionBookmark; head: PositionBookmark }[]
  mainIndex: number
}

interface ViewportBookmark {
  pos: number
  topOffset: number | null
  scrollTop: number
  scrollLeft: number
}

interface DocumentScrollPosition {
  key: string
  top: number
  left: number
}

interface EditorFindRange {
  from: number
  to: number
  active: boolean
}

const setFindDecorations = StateEffect.define<EditorFindRange[]>()

const findHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setFindDecorations)) continue
      const builder = new RangeSetBuilder<Decoration>()
      for (const range of effect.value) {
        builder.add(
          range.from,
          range.to,
          Decoration.mark({ class: range.active ? 'cm-find-match cm-find-active' : 'cm-find-match' })
        )
      }
      next = builder.finish()
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field)
})

function findEditorRanges(text: string, query: string): { from: number; to: number }[] {
  const needle = query.trim()
  if (!needle) return []
  const haystack = text.toLocaleLowerCase('ko-KR')
  const target = needle.toLocaleLowerCase('ko-KR')
  const out: { from: number; to: number }[] = []
  let index = haystack.indexOf(target)
  while (index >= 0 && out.length < 2000) {
    out.push({ from: index, to: index + needle.length })
    index = haystack.indexOf(target, index + Math.max(needle.length, 1))
  }
  return out
}

export interface MarkdownDocumentPayload {
  title: string
  path?: string
  markdown: string
}

export type MarkdownSaveHandler = () => Promise<string | undefined>

function makeTheme(family: string, size: number): ReturnType<typeof EditorView.theme> {
  return EditorView.theme(
    {
      '&': { height: '100%', fontSize: `${size}px` },
      '.cm-scroller': { fontFamily: family, lineHeight: '1.7', overflow: 'auto' },
      '.cm-content': { padding: '12px 16px', caretColor: '#fff' },
      '.cm-gutters': { display: 'none' },
      '&.cm-focused': { outline: 'none' }
    },
    { dark: true }
  )
}

function isRemotePath(value?: string): boolean {
  return !!value && value.startsWith('ssh://')
}

function fileNameOf(value?: string): string | undefined {
  return value?.split(/[\\/]/).pop() || undefined
}

function joinDefaultPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`
}

function defaultSaveName(title?: string): string {
  const name = title?.trim().replace(/[\\/]+/g, '-')
  return name || DEFAULT_UNTITLED_NAME
}

function saveAsDefaultPath(
  currentPath?: string,
  defaultDir?: string,
  title?: string
): string | undefined {
  if (currentPath && !isRemotePath(currentPath)) return currentPath
  const name = fileNameOf(currentPath) ?? defaultSaveName(title)
  if (defaultDir && !isRemotePath(defaultDir)) return joinDefaultPath(defaultDir, name)
  return name
}

function dirnameOf(value?: string): string | undefined {
  if (!value) return undefined
  const clean = value.replace(/[\\/]+$/, '')
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  if (slash < 0) return undefined
  if (slash === 0) return clean.startsWith('/') ? '/' : undefined
  if (slash === 2 && /^[A-Za-z]:$/.test(clean.slice(0, slash))) return clean.slice(0, slash + 1)
  return clean.slice(0, slash)
}

function claudeDraftFileName(currentPath?: string, title?: string): string {
  const raw = fileNameOf(currentPath) ?? defaultSaveName(title)
  const safe = raw.trim().replace(/[\\/]+/g, '-') || DEFAULT_UNTITLED_NAME
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  return `${stem}.claude-draft.md`
}

function isClaudeDraftPath(value?: string): boolean {
  return !!value && /\.claude-draft(?: \(\d+\))?\.md$/i.test(fileNameOf(value) ?? '')
}

function formatDraftHistorySavedAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ko-KR')
}

function draftHistoryPreview(content: string): string {
  const line = content
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean)
  return line || '(빈 문서)'
}

function findMinimalReplacement(current: string, next: string): TextReplacement | null {
  if (current === next) return null
  const limit = Math.min(current.length, next.length)
  let prefix = 0
  while (prefix < limit && current.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++

  let currentSuffix = current.length
  let nextSuffix = next.length
  while (
    currentSuffix > prefix &&
    nextSuffix > prefix &&
    current.charCodeAt(currentSuffix - 1) === next.charCodeAt(nextSuffix - 1)
  ) {
    currentSuffix--
    nextSuffix--
  }

  return { from: prefix, to: currentSuffix, insert: next.slice(prefix, nextSuffix) }
}

function fileSignatureOf(value: { size: number; mtimeMs?: number }): FileSignature {
  return { size: value.size, mtimeMs: value.mtimeMs }
}

function sameFileSignature(a?: FileSignature | null, b?: FileSignature | null): boolean {
  if (!a || !b) return false
  return a.size === b.size && Math.abs((a.mtimeMs ?? 0) - (b.mtimeMs ?? 0)) < 1
}

function bookmarkPosition(state: EditorState, pos: number): PositionBookmark {
  const line = state.doc.lineAt(Math.max(0, Math.min(pos, state.doc.length)))
  return { line: line.number, column: pos - line.from }
}

function restorePosition(state: EditorState, bookmark: PositionBookmark): number {
  const line = state.doc.line(Math.max(1, Math.min(bookmark.line, state.doc.lines)))
  return Math.min(line.from + bookmark.column, line.to)
}

function bookmarkSelection(state: EditorState): SelectionBookmark {
  return {
    mainIndex: state.selection.mainIndex,
    ranges: state.selection.ranges.map((range) => ({
      anchor: bookmarkPosition(state, range.anchor),
      head: bookmarkPosition(state, range.head)
    }))
  }
}

function restoreSelection(state: EditorState, bookmark: SelectionBookmark): EditorSelection {
  const ranges = bookmark.ranges.map((range) =>
    EditorSelection.range(restorePosition(state, range.anchor), restorePosition(state, range.head))
  )
  return EditorSelection.create(ranges, Math.min(bookmark.mainIndex, ranges.length - 1))
}

function changeCoversSelection(changes: ChangeDesc, selection: EditorSelection): boolean {
  return selection.ranges.some((range) => changes.touchesRange(range.from, range.to) === 'cover')
}

function editorSelectionOverlay(view: EditorView, editorDraftId: string): TextSelectionOverlayDetail | null {
  const text = selectedMarkdown(view)
  const visibleText = text.trim()
  if (!visibleText) return null

  const main = view.state.selection.main
  const from = Math.min(main.from, main.to)
  const to = Math.max(main.from, main.to)
  const start = view.coordsAtPos(from)
  const end = view.coordsAtPos(to)
  const first = start ?? end
  if (!first) return null

  const editorRect = view.scrollDOM.getBoundingClientRect()
  const sameLine = !!start && !!end && Math.abs(start.top - end.top) < 4
  const rawX = sameLine && start && end ? (start.left + end.right) / 2 : first.left + 16
  return {
    x: Math.min(Math.max(rawX, editorRect.left + 8), editorRect.right - 8),
    y: first.top - 6,
    text,
    markdown: text,
    editorDraftId,
    count: Array.from(visibleText).length
  }
}

function selectedMarkdown(view: EditorView): string {
  const ranges = view.state.selection.ranges.filter((range) => !range.empty)
  return ranges.map((range) => view.state.sliceDoc(range.from, range.to)).join('\n')
}

function centerAlignBlock(value: string): string {
  return [ALIGN_CENTER_OPEN, value, ALIGN_CENTER_CLOSE].join('\n')
}

function centerAlignSelectionInView(view: EditorView): void {
  const sel = view.state.selection.main
  const from = sel.empty ? view.state.doc.lineAt(sel.from).from : view.state.doc.lineAt(Math.min(sel.from, sel.to)).from
  const to = sel.empty ? view.state.doc.lineAt(sel.to).to : view.state.doc.lineAt(Math.max(sel.from, sel.to)).to
  const text = view.state.sliceDoc(from, to)
  view.dispatch({
    changes: { from, to, insert: centerAlignBlock(text) },
    selection: { anchor: from + ALIGN_CENTER_OPEN.length + 1 },
    scrollIntoView: true
  })
  view.focus()
}

function emitEditorSelectionOverlay(view: EditorView, editorDraftId: string): void {
  window.dispatchEvent(
    new CustomEvent<TextSelectionOverlayDetail | null>(TEXT_SELECTION_OVERLAY_EVENT, {
      detail: editorSelectionOverlay(view, editorDraftId)
    })
  )
}

function captureViewport(view: EditorView): ViewportBookmark {
  const scroller = view.scrollDOM
  const rect = scroller.getBoundingClientRect()
  const pos = view.posAtCoords({ x: rect.left + Math.min(24, rect.width / 2), y: rect.top + 8 }, false)
  const coords = view.coordsAtPos(pos)
  return {
    pos,
    topOffset: coords ? coords.top - rect.top : null,
    scrollTop: scroller.scrollTop,
    scrollLeft: scroller.scrollLeft
  }
}

function restoreViewport(view: EditorView, bookmark: ViewportBookmark, changes: ChangeDesc): void {
  const mappedPos = Math.max(0, Math.min(changes.mapPos(bookmark.pos, 1), view.state.doc.length))
  window.requestAnimationFrame(() => {
    const scroller = view.scrollDOM
    scroller.scrollLeft = bookmark.scrollLeft
    if (bookmark.topOffset == null) {
      scroller.scrollTop = bookmark.scrollTop
      return
    }
    const rect = scroller.getBoundingClientRect()
    const coords = view.coordsAtPos(mappedPos)
    if (!coords) {
      scroller.scrollTop = bookmark.scrollTop
      return
    }
    scroller.scrollTop += coords.top - rect.top - bookmark.topOffset
  })
}

/**
 * 마크다운 편집기 (CodeMirror 6). 서식(라이브 프리뷰)·원본 두 모드 모두 편집 가능.
 * 입력 후 자동 작업은 복구용 임시저장만 수행한다. 실제 파일 저장은 Ctrl+S/저장 버튼에서만 한다.
 */
export default function MarkdownEditor({
  title,
  path,
  draftId,
  platform,
  defaultDir,
  onPath,
  onAsk,
  onSendToJuriSupport,
  onSaveHandler,
  scrollKey,
  initialScroll,
  onScrollPosition,
  onDirty
}: {
  title?: string
  path?: string
  draftId: string
  platform?: string
  defaultDir?: string
  onPath?: (path: string) => void
  onAsk?: (
    draftPath?: string,
    meta?: { sourcePath?: string; sourceTitle?: string; instruction?: string }
  ) => void
  onSendToJuriSupport?: (doc: MarkdownDocumentPayload) => void
  onSaveHandler?: (handler: MarkdownSaveHandler | null) => void
  scrollKey?: string
  initialScroll?: DocumentScrollPosition
  onScrollPosition?: (position: DocumentScrollPosition) => void
  // 실제 파일에 저장되지 않은 변경사항이 있으면 닫기 전 알린다
  onDirty?: (dirty: boolean) => void
}): JSX.Element {
  const onDirtyRef = useRef(onDirty)
  onDirtyRef.current = onDirty
  const scrollKeyRef = useRef(scrollKey)
  const initialScrollRef = useRef(initialScroll)
  const onScrollPositionRef = useRef(onScrollPosition)
  scrollKeyRef.current = scrollKey
  initialScrollRef.current = initialScroll
  onScrollPositionRef.current = onScrollPosition
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const previewComp = useRef(new Compartment())
  const pathRef = useRef<string | undefined>(path)
  const titleRef = useRef(title)
  const draftIdRef = useRef(draftId)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedRef = useRef(!!path)
  const savedContentRef = useRef('')
  const localDirtyRef = useRef(false)
  const saveNowRef = useRef<MarkdownSaveHandler>(() => Promise.resolve(undefined))
  const applyingRemoteRef = useRef(false)
  const remoteSigRef = useRef<FileSignature | null>(null)
  const remoteConflictContentRef = useRef('')
  const remoteAppliedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const findOpenRef = useRef(false)
  const findQueryRef = useRef('')
  const findIndexRef = useRef(-1)
  const applyFindRef = useRef<(query: string, requestedIndex: number) => void>(() => {})
  const openFindRef = useRef<() => void>(() => {})
  const reportScrollPosition = (view = viewRef.current): void => {
    const key = scrollKeyRef.current
    if (!view || !key) return
    onScrollPositionRef.current?.({
      key,
      top: view.scrollDOM.scrollTop,
      left: view.scrollDOM.scrollLeft
    })
  }
  const [preview, setPreview] = useState(true)
  const [err, setErr] = useState('')
  const [saveError, setSaveError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [draftSaving, setDraftSaving] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)
  const [remoteApplied, setRemoteApplied] = useState(false)
  const [remoteAppliedMessage, setRemoteAppliedMessage] = useState('외부 수정 반영됨')
  const [remoteConflict, setRemoteConflict] = useState(false)
  const [saved, setSaved] = useState(!!path)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findCount, setFindCount] = useState(0)
  const [findIndex, setFindIndex] = useState(-1)
  const [printLayout, setPrintLayout] = useState<PrintLayoutProfile>('default')
  const [claudeDrafting, setClaudeDrafting] = useState(false)
  const [hasDraftHistory, setHasDraftHistory] = useState(false)
  const [draftHistoryOpen, setDraftHistoryOpen] = useState(false)
  const [draftHistoryLoading, setDraftHistoryLoading] = useState(false)
  const [draftHistoryItems, setDraftHistoryItems] = useState<DocumentDraftHistoryEntry[]>([])
  const [draftHistoryError, setDraftHistoryError] = useState('')

  const setSavedState = (value: boolean): void => {
    savedRef.current = value
    setSaved(value)
  }
  const setFindOpenState = (value: boolean): void => {
    findOpenRef.current = value
    setFindOpen(value)
  }
  const setFindQueryState = (value: string): void => {
    findQueryRef.current = value
    setFindQuery(value)
  }
  const setFindIndexState = (value: number): void => {
    findIndexRef.current = value
    setFindIndex(value)
  }

  const pulseRemoteApplied = (message = '외부 수정 반영됨'): void => {
    setRemoteConflict(false)
    setRemoteAppliedMessage(message)
    setRemoteApplied(true)
    if (remoteAppliedTimer.current) clearTimeout(remoteAppliedTimer.current)
    remoteAppliedTimer.current = setTimeout(() => {
      remoteAppliedTimer.current = null
      setRemoteApplied(false)
    }, 1200)
  }

  const clearFindDecorations = (): void => {
    viewRef.current?.dispatch({ effects: setFindDecorations.of([]) })
    setFindCount(0)
    setFindIndexState(-1)
  }

  const applyFind = (query: string, requestedIndex: number): void => {
    const view = viewRef.current
    if (!view) return
    const ranges = findEditorRanges(view.state.doc.toString(), query)
    const index = ranges.length
      ? (requestedIndex < 0 ? 0 : (requestedIndex + ranges.length) % ranges.length)
      : -1
    setFindCount(ranges.length)
    setFindIndexState(index)
    view.dispatch({
      effects: setFindDecorations.of(
        ranges.map((range, i) => ({ ...range, active: i === index }))
      ),
      ...(index >= 0
        ? {
            selection: EditorSelection.range(ranges[index].from, ranges[index].to),
            scrollIntoView: true
          }
        : {})
    })
  }
  applyFindRef.current = applyFind

  const openFind = (): void => {
    const view = viewRef.current
    if (view) {
      const sel = view.state.selection.main
      if (!sel.empty) {
        const selected = view.state.sliceDoc(sel.from, sel.to)
        if (selected.length <= 120 && !/[\r\n]/.test(selected)) setFindQueryState(selected)
      }
    }
    setFindOpenState(true)
    setFindIndexState(0)
  }
  openFindRef.current = openFind

  const refreshSavedSignature = (targetPath: string): void => {
    window.lt.fs.stat(targetPath).then((s) => {
      if (s.ok && pathRef.current === targetPath) remoteSigRef.current = fileSignatureOf(s)
    })
  }

  const draftIdentity = (targetPath = pathRef.current): { path?: string; draftId: string } => ({
    path: targetPath,
    draftId: draftIdRef.current
  })

  const deleteDraft = (targetPath = pathRef.current): void => {
    void window.lt.fs.deleteDocumentDraft(draftIdentity(targetPath)).catch(() => {})
  }

  const deleteScratchDraft = (): void => {
    void window.lt.fs.deleteDocumentDraft({ draftId: draftIdRef.current }).catch(() => {})
  }

  const setDirtyState = (value: boolean): void => {
    localDirtyRef.current = value
    setDirty(value)
    onDirtyRef.current?.(value)
  }

  const markSaved = (targetPath: string, content: string, signature?: FileSignature): void => {
    savedContentRef.current = content
    localDirtyRef.current = false
    remoteConflictContentRef.current = ''
    setDirty(false)
    setSaveError('')
    setRemoteConflict(false)
    setDraftSaved(false)
    setDraftSaving(false)
    setSavedState(true)
    onDirtyRef.current?.(false)
    if (signature) remoteSigRef.current = signature
    else refreshSavedSignature(targetPath)
    deleteDraft(targetPath)
  }

  const prepareSaveTarget = async (
    targetPath: string,
    content: string
  ): Promise<
    | { action: 'write'; expected?: FileSignature }
    | { action: 'already-saved'; signature: FileSignature }
    | { action: 'cancel' }
  > => {
    const expected = remoteSigRef.current
    const currentStat = await window.lt.fs.stat(targetPath).catch(() => null)
    if (!currentStat?.ok) return { action: 'write', expected: expected ?? undefined }

    const current = fileSignatureOf(currentStat)
    if (!expected || sameFileSignature(current, expected)) {
      remoteSigRef.current = current
      return { action: 'write', expected: current }
    }

    const latest = await window.lt.fs.readText(targetPath).catch(() => null)
    if (latest?.kind === 'text' && !latest.truncated) {
      if (latest.text === savedContentRef.current) {
        remoteSigRef.current = current
        return { action: 'write', expected: current }
      }
      if (latest.text === content) return { action: 'already-saved', signature: current }
    }

    const overwrite = window.confirm(
      '이 파일은 에디터에서 연 뒤 외부에서 변경되었습니다.\n\n현재 화면의 내용으로 덮어쓰면 외부 변경사항이 사라질 수 있습니다.\n그래도 덮어쓸까요?'
    )
    if (!overwrite) {
      setSaveError('파일이 외부에서 변경되어 저장을 취소했습니다. 최신 내용을 다시 확인한 뒤 저장하세요.')
      setSavedState(false)
      void saveDraftNow(false)
      return { action: 'cancel' }
    }

    remoteSigRef.current = current
    return { action: 'write', expected: current }
  }

  const saveAsNow = (): Promise<string | undefined> => {
    const v = viewRef.current
    if (!v) return Promise.resolve(undefined)
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const content = v.state.doc.toString()
    const previousPath = pathRef.current
    setSaveError('')
    return window.lt.fs.saveAs(content, saveAsDefaultPath(pathRef.current, defaultDir, title)).then((r) => {
      if (r.ok && r.path) {
        pathRef.current = r.path
        onPath?.(r.path)
        markSaved(r.path, content)
        if (previousPath && previousPath !== r.path) deleteDraft(previousPath)
        if (!previousPath) deleteScratchDraft()
        return r.path
      }
      if (r.error) setSaveError(r.error)
      return undefined
    })
  }

  const saveNow = async (): Promise<string | undefined> => {
    const v = viewRef.current
    if (!v) return undefined
    if (!pathRef.current) {
      return saveAsNow()
    }
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const targetPath = pathRef.current
    const content = v.state.doc.toString()
    setSaveError('')
    const prepared = await prepareSaveTarget(targetPath, content)
    if (pathRef.current !== targetPath || prepared.action === 'cancel') return undefined
    if (prepared.action === 'already-saved') {
      markSaved(targetPath, content, prepared.signature)
      return targetPath
    }
    const result = await window.lt.fs.writeText(targetPath, content, { expected: prepared.expected })
    if (pathRef.current !== targetPath) return undefined
    if (!result.ok) {
      setSaveError(
        result.conflict
          ? '파일이 외부에서 변경되어 저장하지 않았습니다. 최신 내용을 다시 확인한 뒤 저장하세요.'
          : (result.error ?? '저장 실패')
      )
      setSavedState(false)
      return undefined
    }
    markSaved(targetPath, content, result.stat)
    return targetPath
  }
  saveNowRef.current = saveNow

  useEffect(() => {
    if (!onSaveHandler) return
    const handler: MarkdownSaveHandler = () => saveNowRef.current()
    onSaveHandler(handler)
    return () => onSaveHandler(null)
  }, [onSaveHandler])

  const saveDraftNow = (updateState = true): Promise<void> => {
    const v = viewRef.current
    if (!v || !localDirtyRef.current) return Promise.resolve()
    const content = v.state.doc.toString()
    if (!content && !pathRef.current) {
      deleteDraft()
      if (updateState) {
        setDraftSaved(false)
        setDraftSaving(false)
      }
      return Promise.resolve()
    }
    if (updateState) setDraftSaving(true)
    return window.lt.fs
      .saveDocumentDraft({
        ...draftIdentity(),
        title: titleRef.current,
        content
      })
      .then((r) => {
        if (!r.ok) {
          if (updateState) {
            setSaveError(r.error ? `임시저장 실패: ${r.error}` : '임시저장 실패')
            setDraftSaved(false)
          }
          return
        }
        if (updateState) {
          setSaveError('')
          setDraftSaved(true)
        }
      })
      .catch((e) => {
        if (updateState) {
          setSaveError(`임시저장 실패: ${String(e)}`)
          setDraftSaved(false)
        }
      })
      .finally(() => {
        if (updateState) setDraftSaving(false)
      })
  }

  const createClaudeDraftNow = async (): Promise<string | undefined> => {
    const v = viewRef.current
    if (!v) return undefined
    const dir = dirnameOf(pathRef.current) ?? defaultDir
    if (!dir) {
      setSaveError('Claude 작업본을 만들 폴더가 없습니다. 먼저 문서를 저장하세요.')
      return undefined
    }
    setClaudeDrafting(true)
    setSaveError('')
    try {
      const result = await window.lt.fs.createFile(
        dir,
        claudeDraftFileName(pathRef.current, titleRef.current),
        v.state.doc.toString()
      )
      if (!result.ok || !result.path) {
        setSaveError(result.error ? `Claude 작업본 생성 실패: ${result.error}` : 'Claude 작업본 생성 실패')
        return undefined
      }
      return result.path
    } catch (e) {
      setSaveError(`Claude 작업본 생성 실패: ${String(e)}`)
      return undefined
    } finally {
      setClaudeDrafting(false)
    }
  }

  const conflictHistoryTitle = (): string => {
    const base = fileNameOf(pathRef.current) ?? titleRef.current ?? '문서'
    return `${base} (Claude 수정본)`
  }

  const recordRemoteConflictVersion = (content: string): void => {
    if (remoteConflictContentRef.current === content) return
    remoteConflictContentRef.current = content
    void saveDraftNow(false)
      .then(() =>
        window.lt.fs.addDocumentDraftHistory({
          ...draftIdentity(),
          title: conflictHistoryTitle(),
          content
        })
      )
      .then((result) => {
        if (result.ok) setHasDraftHistory(true)
      })
      .catch(() => {})
  }

  const askClaudeToMergeConflict = (): void => {
    void createClaudeDraftNow().then((draftPath) => {
      if (!draftPath) return
      onAsk?.(draftPath, {
        sourcePath: pathRef.current,
        sourceTitle: conflictHistoryTitle(),
        instruction: [
          '충돌이 났습니다. 사용자 편집본과 Claude 수정본 두 본을 비교해서 하나로 병합해줘.',
          '사용자 편집본은 위 Claude 작업본 파일이고, Claude 수정본은 원본 문서 경로의 현재 디스크 내용입니다.',
          '두 본의 의미 있는 변경을 모두 살리고, 병합 결과는 사용자 편집본 파일에만 저장해줘.',
          '원본 문서 경로는 비교용으로만 읽고 덮어쓰지 마세요.'
        ].join('\n')
      })
    })
  }

  const scheduleDraftSave = (): void => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void saveDraftNow(), 700)
  }

  const openDraftHistory = (): void => {
    setDraftHistoryOpen(true)
    setDraftHistoryLoading(true)
    setDraftHistoryError('')
    void window.lt.fs
      .listDocumentDraftHistory(draftIdentity())
      .then((result) => {
        if (!result.ok) {
          setDraftHistoryItems([])
          setHasDraftHistory(false)
          setDraftHistoryError(result.error ?? '문서 히스토리를 불러오지 못했습니다.')
          return
        }
        const items = result.history ?? []
        setDraftHistoryItems(items)
        setHasDraftHistory(items.length > 0)
      })
      .catch((e) => {
        setDraftHistoryItems([])
        setHasDraftHistory(false)
        setDraftHistoryError(String(e))
      })
      .finally(() => setDraftHistoryLoading(false))
  }

  const applyDraftHistory = (entry: DocumentDraftHistoryEntry): void => {
    const v = viewRef.current
    if (!v) return
    const current = v.state.doc.toString()
    const replacement = findMinimalReplacement(current, entry.content)
    if (replacement) {
      const viewport = captureViewport(v)
      const selectionBookmark = bookmarkSelection(v.state)
      const previewTransaction = v.state.update({ changes: replacement })
      const scrollEffect = v.scrollSnapshot().map(previewTransaction.changes)
      const selection = changeCoversSelection(previewTransaction.changes, v.state.selection)
        ? restoreSelection(previewTransaction.state, selectionBookmark)
        : undefined
      v.dispatch({
        changes: previewTransaction.changes,
        ...(selection ? { selection } : {}),
        ...(scrollEffect ? { effects: [scrollEffect] } : {})
      })
      restoreViewport(v, viewport, previewTransaction.changes)
    }
    setDraftHistoryOpen(false)
    window.requestAnimationFrame(() => viewRef.current?.focus())
  }

  useEffect(() => {
    if (pathRef.current === path) return
    pathRef.current = path
    if (!localDirtyRef.current) setSavedState(!!path)
    if (path) refreshSavedSignature(path)
  }, [path])

  useEffect(() => {
    titleRef.current = title
  }, [title])

  useEffect(() => {
    const onCenterSelection = (event: Event): void => {
      const detail = (event as CustomEvent<{ draftId?: string }>).detail
      if (detail?.draftId !== draftId) return
      const view = viewRef.current
      if (view) centerAlignSelectionInView(view)
    }
    window.addEventListener(MARKDOWN_CENTER_SELECTION_EVENT, onCenterSelection)
    return () => window.removeEventListener(MARKDOWN_CENTER_SELECTION_EVENT, onCenterSelection)
  }, [draftId])

  useEffect(() => {
    let alive = true
    setErr('')
    const init = pathRef.current
      ? window.lt.fs.readText(pathRef.current)
      : Promise.resolve({ ext: '', kind: 'text' as const, text: '', size: 0, mtimeMs: undefined })
    Promise.all([init, window.lt.settings.get()])
      .then(async ([r, s]) => {
        if (!alive || !hostRef.current) return
        const baseText = (r as { text: string }).text
        let docText = baseText
        let restoredDraft = false
        let hasRestorableDraft = false
        const draftResult = await window.lt.fs.loadDocumentDraft(draftIdentity()).catch(() => null)
        if (!alive || !hostRef.current) return
        const draft = draftResult?.ok ? draftResult.draft : null
        if (draft && draft.content !== baseText) {
          hasRestorableDraft = true
          if (!pathRef.current) {
            docText = draft.content
            restoredDraft = true
          }
        }
        savedContentRef.current = baseText
        if (pathRef.current) {
          remoteSigRef.current = fileSignatureOf({
            size: r.size,
            mtimeMs: r.mtimeMs
          })
        }
        const family = s.mdFont || DEFAULT_MD_FONT
        const size = s.mdFontSize || 14
        const state = EditorState.create({
          doc: docText,
          extensions: [
            history(),
            drawSelection(),
            dropCursor(),
            keymap.of([
              ...defaultKeymap,
              ...historyKeymap,
              indentWithTab,
              { key: 'Mod-f', run: () => (openFindRef.current(), true) },
              { key: 'Shift-Mod-s', run: () => (void saveAsNow(), true) },
              { key: 'Mod-s', run: () => (void saveNow(), true) }
            ]),
            markdown({ extensions: GFM }),
            syntaxHighlighting(defaultHighlightStyle),
            EditorView.lineWrapping,
            findHighlightField,
            makeTheme(family, size),
            previewComp.current.of(preview ? livePreview : []),
            EditorView.domEventHandlers({
              copy(event, view) {
                if (!event.clipboardData) return false
                const markdownText = selectedMarkdown(view)
                if (!writeMarkdownDataTransfer(event.clipboardData, markdownText, 'rich')) return false
                event.preventDefault()
                return true
              },
              scroll(_event, view) {
                reportScrollPosition(view)
                return false
              }
            }),
            EditorView.updateListener.of((u) => {
              if (u.selectionSet || u.docChanged || u.viewportChanged) emitEditorSelectionOverlay(u.view, draftId)
              if (u.docChanged) {
                if (applyingRemoteRef.current) {
                  savedContentRef.current = u.state.doc.toString()
                  setDirtyState(false)
                  setSavedState(true)
                  return
                }
                const current = u.state.doc.toString()
                const nextDirty = current !== savedContentRef.current
                setDirtyState(nextDirty)
                setSavedState(!nextDirty && !!pathRef.current)
                if (nextDirty) {
                  setDraftSaved(false)
                  scheduleDraftSave()
                } else {
                  if (saveTimer.current) {
                    clearTimeout(saveTimer.current)
                    saveTimer.current = null
                  }
                  setDraftSaved(false)
                  deleteDraft()
                }
                if (findOpenRef.current) {
                  window.setTimeout(
                    () => applyFindRef.current(findQueryRef.current, findIndexRef.current),
                    0
                  )
                }
              }
            })
          ]
        })
        setDirtyState(restoredDraft)
        setDraftSaved(restoredDraft)
        setHasDraftHistory(hasRestorableDraft)
        setSavedState(!restoredDraft && !!pathRef.current)
        viewRef.current = new EditorView({ state, parent: hostRef.current })
        const restoredScroll = initialScrollRef.current
        if (restoredScroll && restoredScroll.key === scrollKeyRef.current) {
          const { top, left } = restoredScroll
          window.requestAnimationFrame(() => {
            const scroller = viewRef.current?.scrollDOM
            if (!scroller) return
            scroller.scrollTop = top
            scroller.scrollLeft = left
          })
        }
        viewRef.current.focus()
      })
      .catch((e) => alive && setErr(String(e)))
    return () => {
      alive = false
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      if (localDirtyRef.current) void saveDraftNow(false)
      if (remoteAppliedTimer.current) clearTimeout(remoteAppliedTimer.current)
      reportScrollPosition()
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pathRef.current) return
    let alive = true
    const tick = (): void => {
      const currentPath = pathRef.current
      if (!currentPath) return
      window.lt.fs
        .stat(currentPath)
        .then((s) => {
          if (!alive || !s.ok) return
          const sig = fileSignatureOf(s)
          if (!remoteSigRef.current) {
            remoteSigRef.current = sig
            return
          }
          if (sameFileSignature(sig, remoteSigRef.current)) return
          window.lt.fs
            .readText(currentPath)
            .then((r) => {
              if (!alive || r.kind !== 'text' || r.truncated) return
              const v = viewRef.current
              if (!v) return
              const next = r.text
              const current = v.state.doc.toString()
              if (next === current) {
                remoteSigRef.current = sig
                savedContentRef.current = next
                remoteConflictContentRef.current = ''
                setDirtyState(false)
                setSavedState(true)
                setRemoteConflict(false)
                return
              }
              if (localDirtyRef.current || !savedRef.current) {
                if (!localDirtyRef.current) return
                const merged = mergeTextAgainstBase(savedContentRef.current, current, next)
                if (merged.status === 'conflict') {
                  recordRemoteConflictVersion(next)
                  setRemoteConflict(true)
                  return
                }
                if (merged.status === 'unchanged') {
                  remoteSigRef.current = sig
                  remoteConflictContentRef.current = ''
                  setRemoteConflict(false)
                  return
                }

                const mergedText = merged.text
                savedContentRef.current = next
                remoteSigRef.current = sig
                remoteConflictContentRef.current = ''
                setRemoteConflict(false)
                setSavedState(mergedText === next && !!pathRef.current)
                setDirtyState(mergedText !== next)

                const replacement = findMinimalReplacement(current, mergedText)
                if (replacement) {
                  const viewport = captureViewport(v)
                  const selectionBookmark = bookmarkSelection(v.state)
                  const previewTransaction = v.state.update({ changes: replacement })
                  const scrollEffect = v.scrollSnapshot().map(previewTransaction.changes)
                  const selection = changeCoversSelection(previewTransaction.changes, v.state.selection)
                    ? restoreSelection(previewTransaction.state, selectionBookmark)
                    : undefined
                  v.dispatch({
                    changes: previewTransaction.changes,
                    ...(selection ? { selection } : {}),
                    ...(scrollEffect ? { effects: [scrollEffect] } : {})
                  })
                  restoreViewport(v, viewport, previewTransaction.changes)
                }
                setDraftSaved(false)
                if (mergedText !== next) scheduleDraftSave()
                pulseRemoteApplied(merged.remoteHunkCount > 0 ? '외부 수정 병합됨' : '외부 수정 반영됨')
                return
              }
              const replacement = findMinimalReplacement(current, next)
              if (!replacement) return
              const viewport = captureViewport(v)
              const selectionBookmark = bookmarkSelection(v.state)
              const previewTransaction = v.state.update({ changes: replacement })
              const scrollEffect = v.scrollSnapshot().map(previewTransaction.changes)
              const selection = changeCoversSelection(previewTransaction.changes, v.state.selection)
                ? restoreSelection(previewTransaction.state, selectionBookmark)
                : undefined
              applyingRemoteRef.current = true
              try {
                v.dispatch({
                  changes: previewTransaction.changes,
                  ...(selection ? { selection } : {}),
                  ...(scrollEffect ? { effects: [scrollEffect] } : {})
                })
                restoreViewport(v, viewport, previewTransaction.changes)
              } finally {
                applyingRemoteRef.current = false
              }
              savedContentRef.current = next
              remoteSigRef.current = sig
              remoteConflictContentRef.current = ''
              setDirtyState(false)
              setSavedState(true)
              setDraftSaved(false)
              deleteDraft()
              pulseRemoteApplied()
            })
            .catch(() => {})
        })
        .catch(() => {})
    }
    tick()
    const timer = setInterval(
      tick,
      isClaudeDraftPath(pathRef.current) ? CLAUDE_DRAFT_FILE_POLL_MS : EXTERNAL_FILE_POLL_MS
    )
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: previewComp.current.reconfigure(preview ? livePreview : [])
    })
  }, [preview])

  useEffect(() => {
    if (findOpen) applyFind(findQuery, 0)
    else clearFindDecorations()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findQuery])

  if (err)
    return (
      <div className="welcome">
        <p className="muted">열기 실패: {err}</p>
      </div>
    )

  const onEditorKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLocaleLowerCase() !== 's') return
    e.preventDefault()
    e.stopPropagation()
    if (e.shiftKey) void saveAsNow()
    else void saveNow()
  }
  const saveShortcut = platform === 'darwin' ? '⌘S' : 'Ctrl+S'
  const saveAsShortcut = platform === 'darwin' ? '⌘⇧S' : 'Ctrl+Shift+S'
  const saveStatus = saveError
    ? '저장 실패'
    : remoteConflict
      ? '외부 수정 충돌 (히스토리 확인)'
      : remoteApplied
        ? remoteAppliedMessage
        : dirty
          ? draftSaving
            ? '임시저장 중…'
            : draftSaved
              ? `임시저장됨 (${saveShortcut}로 저장)`
              : `변경됨 (${saveShortcut}로 저장)`
          : saved
            ? '저장됨'
            : `미저장 (${saveShortcut})`
  const isProofOfContentPrint = printLayout === 'proof-of-content'
  const printLayoutTitle = isProofOfContentPrint
    ? "내용증명 양식: 인쇄할 때 PDF 뷰어/프린터 옵션에서 '이미지로 인쇄'를 선택하세요."
    : 'PDF 출력 양식'
  const exportPdfTitle = isProofOfContentPrint
    ? "내용증명 PDF로 내보내기. 인쇄할 때 '이미지로 인쇄'를 선택하세요."
    : 'PDF로 내보내기'
  const exportStem = (): string => {
    const stem = (fileNameOf(pathRef.current) ?? titleRef.current ?? '문서').replace(/\.[^.]+$/, '')
    return stem.trim() || '문서'
  }
  const exportDefaultPath = (extension: 'pdf' | 'hwpx', stem: string): string => {
    const currentPath = pathRef.current
    if (currentPath && !isRemotePath(currentPath)) return `${currentPath.replace(/\.[^.]+$/, '')}.${extension}`
    if (defaultDir && !isRemotePath(defaultDir)) return joinDefaultPath(defaultDir, `${stem}.${extension}`)
    return `${stem}.${extension}`
  }
  const centerAlignSelection = (): void => {
    const v = viewRef.current
    if (!v) return
    centerAlignSelectionInView(v)
  }
  const exportPdfNow = (): void => {
    const v = viewRef.current
    if (!v) return
    const layout = printLayout
    const name = exportStem()
    const def = exportDefaultPath('pdf', name)
    void window.lt.export
      .mdToPdf(mdToPrintHtml(v.state.doc.toString(), name, layout), def)
      .then((r) => {
        if (!r.ok) {
          if (r.error) window.alert(`PDF 내보내기 실패: ${r.error}`)
          return
        }
        if (layout === 'proof-of-content') {
          window.alert("내용증명 PDF를 인쇄할 때는 PDF 뷰어/프린터 옵션에서 '이미지로 인쇄'를 선택하세요.")
        }
      })
      .catch((e) => window.alert(`PDF 내보내기 실패: ${String(e)}`))
  }
  const exportHwpxNow = (): void => {
    const v = viewRef.current
    if (!v) return
    const name = exportStem()
    const def = exportDefaultPath('hwpx', name)
    void window.lt.export
      .mdToHwpx(v.state.doc.toString(), name, def)
      .then((r) => {
        if (!r.ok && r.error) window.alert(`HWPX 내보내기 실패: ${r.error}`)
      })
      .catch((e) => window.alert(`HWPX 내보내기 실패: ${String(e)}`))
  }

  return (
    <div className="text-doc" onKeyDown={onEditorKeyDown}>
      <div className="text-toolbar">
        <button className={`tb-btn ${preview ? 'on' : ''}`} title="서식(라이브 프리뷰)" onClick={() => setPreview(true)}>
          서식
        </button>
        <button className={`tb-btn ${!preview ? 'on' : ''}`} title="원본(소스)" onClick={() => setPreview(false)}>
          원본
        </button>
        <span className="tb-divider" />
        <button
          className="tb-btn"
          title="가운데 정렬"
          aria-label="가운데 정렬"
          onClick={centerAlignSelection}
        >
          <IconAlignCenter size={14} />
        </button>
        <span className="tb-divider" />
        <button className="tb-btn" title={`저장 (${saveShortcut})`} aria-label="저장" onClick={() => void saveNow()}>
          <IconSave size={14} />
        </button>
        <button
          className="tb-btn"
          title={`다른 이름으로 저장 (${saveAsShortcut})`}
          aria-label="다른 이름으로 저장"
          onClick={() => void saveAsNow()}
        >
          <IconSaveAs size={14} />
        </button>
        <span className="tb-divider" />
        <select
          className="tb-select"
          title={printLayoutTitle}
          aria-label={printLayoutTitle}
          value={printLayout}
          onChange={(e) => setPrintLayout(e.target.value as PrintLayoutProfile)}
        >
          <option value="default">일반</option>
          <option value="proof-of-content">내용증명</option>
        </select>
        <button
          className="tb-btn"
          title={exportPdfTitle}
          onClick={exportPdfNow}
        >
          PDF
        </button>
        <button
          className="tb-btn"
          title="HWPX로 내보내기"
          onClick={exportHwpxNow}
        >
          HWPX
        </button>
        <button
          className={`tb-btn ${hasDraftHistory ? 'has-history' : ''}`}
          title="문서 히스토리에서 가져오기"
          onClick={openDraftHistory}
        >
          <IconHistory size={14} />
          <span className="sr-only">문서 히스토리</span>
        </button>
        <button
          className={`tb-btn ${findOpen ? 'on' : ''}`}
          title="문서에서 찾기"
          onClick={openFind}
        >
          <IconSearch size={14} />
          <span className="sr-only">문서에서 찾기</span>
        </button>
        {onAsk && (
          <>
            <span className="tb-divider" />
            {remoteConflict && (
              <button
                className="tb-btn"
                title="현재 편집본과 Claude 수정본 병합 요청"
                disabled={claudeDrafting}
                onClick={askClaudeToMergeConflict}
              >
                병합 요청
              </button>
            )}
            <button
              className="tb-btn"
              title="현재 화면 내용으로 Claude 작업본을 만든 뒤 물어보기"
              disabled={claudeDrafting}
              onClick={() => {
                void createClaudeDraftNow().then((draftPath) => {
                  if (!draftPath) return
                  onAsk(draftPath, {
                    sourcePath: pathRef.current,
                    sourceTitle: titleRef.current
                  })
                })
              }}
            >
              {claudeDrafting ? '작업본…' : '✳ Claude'}
            </button>
          </>
        )}
        {onSendToJuriSupport && (
          <>
            <span className="tb-divider" />
            <button
              className="tb-btn"
              title="JuriSupport 소송문서 작성 요청"
              onClick={() => {
                const v = viewRef.current
                if (!v) return
                const title = pathRef.current?.split(/[\\/]/).pop() ?? '무제.md'
                onSendToJuriSupport({
                  title,
                  path: pathRef.current,
                  markdown: v.state.doc.toString()
                })
              }}
            >
              JS 문서
            </button>
          </>
        )}
        <span
          className={`tb-sep-text ${saveError || remoteConflict ? 'error' : remoteApplied ? 'remote' : ''}`}
          title={
            saveError ||
            (remoteConflict
              ? '외부 변경사항과 현재 편집 내용이 같은 문단에서 겹쳐 자동 병합하지 않았습니다. Claude 수정본은 문서 히스토리에 저장됩니다.'
              : saveStatus)
          }
        >
          {saveStatus}
        </span>
      </div>
      {findOpen && (
        <FindBar
          value={findQuery}
          placeholder="문서에서 찾기"
          resultLabel={findQuery.trim() ? (findCount ? `${findIndex + 1}/${findCount}` : '0/0') : ''}
          onChange={(value) => {
            setFindQueryState(value)
            setFindIndexState(0)
          }}
          onPrev={() => applyFind(findQuery, findIndex - 1)}
          onNext={() => applyFind(findQuery, findIndex + 1)}
          onClose={() => {
            setFindOpenState(false)
            viewRef.current?.focus()
          }}
        />
      )}
      {draftHistoryOpen && (
        <div className="modal-overlay" onMouseDown={() => setDraftHistoryOpen(false)}>
          <div
            className="modal draft-history-modal"
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-title">문서 히스토리</div>
            <div className="draft-history-list">
              {draftHistoryLoading && <p className="muted pad small">히스토리를 불러오는 중입니다.</p>}
              {!draftHistoryLoading && draftHistoryError && (
                <p className="draft-history-error">{draftHistoryError}</p>
              )}
              {!draftHistoryLoading && !draftHistoryError && draftHistoryItems.length === 0 && (
                <p className="muted pad small">가져올 과거 임시저장본이 없습니다.</p>
              )}
              {!draftHistoryLoading &&
                !draftHistoryError &&
                draftHistoryItems.map((entry) => (
                  <button
                    key={entry.id}
                    className="draft-history-row"
                    title={formatDraftHistorySavedAt(entry.savedAt)}
                    onClick={() => applyDraftHistory(entry)}
                  >
                    <span className="draft-history-row-main">
                      <span className="draft-history-title">{entry.title}</span>
                      <span className="draft-history-preview">{draftHistoryPreview(entry.content)}</span>
                    </span>
                    <span className="draft-history-time">{formatDraftHistorySavedAt(entry.savedAt)}</span>
                  </button>
                ))}
            </div>
            <div className="modal-actions">
              <button className="empty-action" onClick={() => setDraftHistoryOpen(false)}>
                닫기
              </button>
            </div>
          </div>
        </div>
      )}
      <div
        className={`cm-host ${preview ? 'preview' : 'source'} ${remoteApplied ? 'remote-applied' : ''}`}
        ref={hostRef}
      />
    </div>
  )
}
