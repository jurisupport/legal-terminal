import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { cancelIfTerminalPointerDrag } from '../dragGuard'

export interface Entry {
  name: string
  path: string
  isDir: boolean
  mtimeMs?: number
}

export type SortMode = 'name-asc' | 'name-desc' | 'mtime-desc' | 'mtime-asc'

export interface PendingCreateRequest {
  type: 'file' | 'folder'
  dir?: string
  side?: 'left' | 'right'
}

// 트리 내부 드래그 식별용 MIME (외부 OS 파일 드롭과 구분)
export const LT_PATH = 'application/x-lt-path'
export const LT_PATHS = 'application/x-lt-paths'

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

export function readLtPaths(dataTransfer: Pick<DataTransfer, 'getData'>): string[] {
  const packed = dataTransfer.getData(LT_PATHS)
  if (packed) {
    try {
      const parsed = JSON.parse(packed)
      if (Array.isArray(parsed)) {
        const paths = parsed.filter((value): value is string => typeof value === 'string')
        if (paths.length) return uniqueStrings(paths)
      }
    } catch {
      // Fall through to the single-path payload for older drag sources.
    }
  }
  const single = dataTransfer.getData(LT_PATH)
  return single ? [single] : []
}

function writeLtPaths(dataTransfer: DataTransfer, paths: string[]): void {
  const unique = uniqueStrings(paths)
  if (!unique.length) return
  dataTransfer.setData(LT_PATH, unique[0])
  if (unique.length > 1) dataTransfer.setData(LT_PATHS, JSON.stringify(unique))
  dataTransfer.setData('text/plain', unique.join('\n'))
}

const koCollator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' })
const SEARCH_DEPTH_LIMIT = 8
const SEARCH_RESULT_LIMIT = 300

export function sortEntries<T extends Entry>(entries: T[], mode: SortMode): T[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    if (mode === 'name-asc') return koCollator.compare(a.name, b.name)
    if (mode === 'name-desc') return koCollator.compare(b.name, a.name)
    const am = a.mtimeMs ?? 0
    const bm = b.mtimeMs ?? 0
    const byTime = mode === 'mtime-desc' ? bm - am : am - bm
    return byTime || koCollator.compare(a.name, b.name)
  })
}

function fileIcon(name: string): string {
  const n = name.toLowerCase()
  if (n.endsWith('.pdf')) return '📄'
  if (n.endsWith('.md') || n.endsWith('.mdx')) return '📝'
  if (n.endsWith('.csv') || n.endsWith('.xlsx')) return '📊'
  if (n.endsWith('.docx') || n.endsWith('.hwp') || n.endsWith('.hwpx')) return '📃'
  return '📄'
}

function normalizeSearchText(text: string): string {
  return text.toLocaleLowerCase('ko-KR')
}

function relativePath(root: string, path: string): string {
  if (!path.startsWith(root)) return path
  return path.slice(root.length).replace(/^[\\/]+/, '')
}

function isRemotePath(path: string): boolean {
  return path.startsWith('ssh://')
}

function parentPath(path: string, fallback: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (slash <= 0) return fallback
  if (isRemotePath(path) && slash <= 'ssh://'.length) return fallback
  return path.slice(0, slash)
}

function pathKey(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed || path
}

function isComposingKeyEvent(event: ReactKeyboardEvent<HTMLInputElement>): boolean {
  return event.nativeEvent.isComposing || event.key === 'Process' || event.keyCode === 229
}

function createTargetDir(pendingCreate: PendingCreateRequest | null, fallback: string): string {
  return pendingCreate?.dir ?? fallback
}

interface VisibleEntry extends Entry {
  element: HTMLElement
}

interface SelectRect {
  left: number
  top: number
  width: number
  height: number
}

type DragSelectMode = 'replace' | 'add'

function entryFromRow(element: HTMLElement): VisibleEntry | null {
  const path = element.dataset.entryPath
  const name = element.dataset.entryName
  if (!path || !name) return null
  return {
    path,
    name,
    isDir: element.dataset.entryDir === 'true',
    element
  }
}

function intersects(a: DOMRect, b: SelectRect): boolean {
  const right = b.left + b.width
  const bottom = b.top + b.height
  return a.left < right && a.right > b.left && a.top < bottom && a.bottom > b.top
}

/** 활성 사건 폴더(root)의 파일트리. 폴더는 펼칠 때 지연 로딩. */
export default function FileTree({
  root,
  refreshNonce = 0,
  onOpenFile,
  onDropTo,
  onMove,
  onRename,
  onDelete,
  onPasteTo,
  onDownload,
  onSyncFile,
  onOpenWorkspaceFromFolder,
  pendingCreate = null,
  sortMode = 'name-asc',
  onRequestCreate,
  onCreate,
  onCancelCreate,
  filter = ''
}: {
  root: string
  refreshNonce?: number
  onOpenFile: (path: string, name: string) => void
  onDropTo?: (dir: string, files: FileList) => void
  onMove?: (src: string, destDir: string) => void
  onRename?: (path: string, name: string) => void
  onDelete?: (path: string, name: string, isDir: boolean) => void | Promise<void>
  onPasteTo?: (dir: string) => void
  onDownload?: (path: string, name: string, isDir: boolean) => void
  onSyncFile?: (path: string, name: string) => void
  onOpenWorkspaceFromFolder?: (path: string, name: string) => void
  pendingCreate?: PendingCreateRequest | null
  sortMode?: SortMode
  onRequestCreate?: (dir: string, type: 'file' | 'folder') => void
  onCreate?: (name: string, type: 'file' | 'folder', dir?: string) => void
  onCancelCreate?: () => void
  filter?: string
}): JSX.Element {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [searchEntries, setSearchEntries] = useState<Entry[] | null>(null)
  const [searchErr, setSearchErr] = useState('')
  const [err, setErr] = useState<string>('')
  const [rootOver, setRootOver] = useState(false)
  const [rootDropLabel, setRootDropLabel] = useState('')
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set())
  const [selectRect, setSelectRect] = useState<SelectRect | null>(null)
  const treeRef = useRef<HTMLUListElement>(null)
  const lastRoot = useRef<string | null>(null)
  const lastRefreshNonce = useRef(refreshNonce)
  const entriesRef = useRef<Entry[] | null>(null)
  const selectedPathsRef = useRef(selectedPaths)
  const anchorPathRef = useRef<string | null>(null)
  const query = filter.trim()
  const rootCreate =
    pendingCreate && pathKey(createTargetDir(pendingCreate, root)) === pathKey(root)
  // 우클릭 컨텍스트 메뉴 (붙여넣기/다운로드/삭제 등)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    entry?: Entry
    pasteDir: string
    entries?: Entry[]
  } | null>(null)
  selectedPathsRef.current = selectedPaths

  const visibleEntries = (): VisibleEntry[] =>
    Array.from(treeRef.current?.querySelectorAll<HTMLElement>('.tree-row[data-entry-path]') ?? [])
      .map(entryFromRow)
      .filter((entry): entry is VisibleEntry => entry !== null)

  const visiblePaths = (): string[] => visibleEntries().map((entry) => entry.path)

  const selectedVisibleEntries = (): Entry[] =>
    visibleEntries()
      .filter((entry) => selectedPathsRef.current.has(entry.path))
      .map(({ element, ...entry }) => entry)

  const clearSelection = (): void => {
    anchorPathRef.current = null
    setSelectedPaths(new Set())
  }

  const selectOnly = (path: string): void => {
    anchorPathRef.current = path
    setSelectedPaths(new Set([path]))
  }

  const selectAllVisible = (): void => {
    const paths = visiblePaths()
    if (!paths.length) return
    anchorPathRef.current = paths[0]
    setSelectedPaths(new Set(paths))
  }

  const selectRangeTo = (path: string, additive: boolean): void => {
    const paths = visiblePaths()
    const currentIndex = paths.indexOf(path)
    if (currentIndex < 0) {
      selectOnly(path)
      return
    }
    const anchor = anchorPathRef.current && paths.includes(anchorPathRef.current)
      ? anchorPathRef.current
      : path
    const anchorIndex = paths.indexOf(anchor)
    const [start, end] =
      anchorIndex <= currentIndex ? [anchorIndex, currentIndex] : [currentIndex, anchorIndex]
    const range = paths.slice(start, end + 1)
    setSelectedPaths((current) => {
      if (!additive) return new Set(range)
      const next = new Set(current)
      for (const item of range) next.add(item)
      return next
    })
    anchorPathRef.current = anchor
  }

  const toggleSelected = (path: string): void => {
    anchorPathRef.current = path
    setSelectedPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const selectForClick = (event: React.MouseEvent, entry: Entry): boolean => {
    const additive = event.ctrlKey || event.metaKey
    if (event.shiftKey) {
      selectRangeTo(entry.path, additive)
      return true
    }
    if (additive) {
      toggleSelected(entry.path)
      return true
    }
    selectOnly(entry.path)
    return false
  }

  const selectedDragPaths = (entry: Entry): string[] => {
    if (!selectedPathsRef.current.has(entry.path)) return [entry.path]
    const paths = visibleEntries()
      .map((item) => item.path)
      .filter((path) => selectedPathsRef.current.has(path))
    return paths.length ? paths : [entry.path]
  }

  const clearRootDropState = (): void => {
    setRootOver(false)
    setRootDropLabel('')
  }

  const isLeavingRootDropTarget = (e: React.DragEvent<HTMLUListElement>): boolean => {
    const relatedTarget = e.relatedTarget
    if (relatedTarget instanceof Node && e.currentTarget.contains(relatedTarget)) return false

    const targetAtPoint = document.elementFromPoint(e.clientX, e.clientY)
    return !targetAtPoint || !e.currentTarget.contains(targetAtPoint)
  }

  const deleteEntries = async (targets: Entry[]): Promise<void> => {
    if (!onDelete || !targets.length) return
    const unique = uniqueStrings(targets.map((entry) => entry.path))
      .map((path) => targets.find((entry) => entry.path === path))
      .filter((entry): entry is Entry => !!entry)
    if (!unique.length) return
    const label =
      unique.length === 1
        ? `'${unique[0].name}'${unique[0].isDir ? ' 폴더' : ''}을(를) 삭제할까요?`
        : `선택한 ${unique.length}개 항목을 삭제할까요?`
    if (!window.confirm(label)) return
    await Promise.all(unique.map((entry) => onDelete(entry.path, entry.name, entry.isDir)))
    clearSelection()
  }

  const openContextForEntry = (e: React.MouseEvent, entry: Entry): void => {
    e.preventDefault()
    e.stopPropagation()
    const selected = selectedPathsRef.current
    const entries = selected.has(entry.path) ? selectedVisibleEntries() : [entry]
    if (!selected.has(entry.path)) selectOnly(entry.path)
    setMenu({
      x: e.clientX,
      y: e.clientY,
      entry,
      entries: entries.length ? entries : [entry],
      pasteDir: entry.isDir ? entry.path : parentPath(entry.path, root)
    })
  }
  const onContext = (e: React.MouseEvent, entry: Entry): void => {
    openContextForEntry(e, entry)
  }
  const onRootContext = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, pasteDir: root })
  }
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    document.addEventListener('click', close)
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [menu])

  useEffect(() => {
    clearSelection()
    setSelectRect(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, query])

  useEffect(() => {
    setEditingPath(null)
  }, [root, query])

  useEffect(() => {
    if (!rootOver) return

    const clear = (): void => clearRootDropState()
    window.addEventListener('drop', clear)
    window.addEventListener('dragend', clear)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('drop', clear)
      window.removeEventListener('dragend', clear)
      window.removeEventListener('blur', clear)
    }
  }, [rootOver])

  const commitRename = (path: string, name: string): void => {
    setEditingPath(null)
    onRename?.(path, name)
  }

  useEffect(() => {
    let alive = true
    const rootChanged = lastRoot.current !== root
    const refreshChanged = lastRefreshNonce.current !== refreshNonce
    lastRoot.current = root
    lastRefreshNonce.current = refreshNonce
    const hasEntries = entriesRef.current !== null
    if (rootChanged) setEntries(null)
    if (rootChanged) entriesRef.current = null
    if (rootChanged || !hasEntries) setErr('')
    window.lt.fs
      .list(root, { refresh: !rootChanged && refreshChanged })
      .then((e) => {
        if (!alive) return
        entriesRef.current = e
        setErr('')
        setEntries(e)
      })
      .catch((e) => {
        if (!alive) return
        if (rootChanged || entriesRef.current === null) setErr(String(e))
        else console.warn('[filetree] refresh failed', e)
      })
    return () => {
      alive = false
    }
  }, [root, refreshNonce])

  const startMarqueeSelection = (e: React.PointerEvent<HTMLUListElement>): void => {
    if (!e.isPrimary || e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('.tree-row, .ctx-menu, input, button, select, textarea')) return
    const mode: DragSelectMode = e.ctrlKey || e.metaKey ? 'add' : 'replace'
    const startX = e.clientX
    const startY = e.clientY
    const base = new Set(selectedPathsRef.current)
    let moved = false
    let latestRect: SelectRect | null = null

    const buildRect = (clientX: number, clientY: number): SelectRect => ({
      left: Math.min(startX, clientX),
      top: Math.min(startY, clientY),
      width: Math.abs(clientX - startX),
      height: Math.abs(clientY - startY)
    })

    const applyRect = (rect: SelectRect): void => {
      const hits = visibleEntries()
        .filter((entry) => intersects(entry.element.getBoundingClientRect(), rect))
        .map((entry) => entry.path)
      setSelectedPaths(() => {
        if (mode === 'replace') return new Set(hits)
        const next = new Set(base)
        for (const path of hits) next.add(path)
        return next
      })
      const lastHit = hits[hits.length - 1]
      if (lastHit) anchorPathRef.current = lastHit
    }

    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onDone)
      window.removeEventListener('pointercancel', onDone)
      window.removeEventListener('blur', onDone)
      setSelectRect(null)
    }

    const onMove = (event: PointerEvent): void => {
      if (Math.abs(event.clientX - startX) < 4 && Math.abs(event.clientY - startY) < 4) return
      moved = true
      latestRect = buildRect(event.clientX, event.clientY)
      setSelectRect(latestRect)
      applyRect(latestRect)
      event.preventDefault()
    }

    const onDone = (): void => {
      if (!moved && mode === 'replace') clearSelection()
      if (latestRect) applyRect(latestRect)
      cleanup()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onDone)
    window.addEventListener('pointercancel', onDone)
    window.addEventListener('blur', onDone)
    e.preventDefault()
  }

  const handleTreeKeyDown = (e: React.KeyboardEvent<HTMLUListElement>): void => {
    const primary = e.ctrlKey || e.metaKey
    if (primary && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      e.stopPropagation()
      selectAllVisible()
      return
    }
    if (e.key === 'Escape' && selectedPaths.size > 0) {
      e.preventDefault()
      e.stopPropagation()
      clearSelection()
      return
    }
    if (e.key === 'Delete' && onDelete && selectedPaths.size > 0) {
      e.preventDefault()
      e.stopPropagation()
      void deleteEntries(selectedVisibleEntries())
    }
  }

  useEffect(() => {
    if (!query) {
      setSearchEntries(null)
      setSearchErr('')
      return
    }
    let alive = true
    const needle = normalizeSearchText(query)
    const out: Entry[] = []

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > SEARCH_DEPTH_LIMIT || out.length >= SEARCH_RESULT_LIMIT) return
      let list: Entry[]
      try {
        list = await window.lt.fs.list(dir)
      } catch (e) {
        if (depth === 0) throw e
        return
      }
      for (const entry of list) {
        if (!entry.isDir && normalizeSearchText(entry.name).includes(needle)) out.push(entry)
        if (out.length >= SEARCH_RESULT_LIMIT) return
        if (entry.isDir) await walk(entry.path, depth + 1)
      }
    }

    setSearchEntries(null)
    setSearchErr('')
    walk(root, 0)
      .then(() => {
        if (alive) setSearchEntries(out)
      })
      .catch((e) => {
        if (!alive) return
        setSearchEntries([])
        setSearchErr(String(e))
      })
    return () => {
      alive = false
    }
  }, [root, refreshNonce, query])

  // 트리 빈 영역/루트로 드롭 → root 폴더로 이동(내부) 또는 복사(외부)
  const rootDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    clearRootDropState()
    const paths = readLtPaths(e.dataTransfer)
    if (paths.length) {
      for (const src of paths) {
        if (pathKey(src) !== pathKey(root)) onMove?.(src, root)
      }
    } else if (e.dataTransfer.files.length) onDropTo?.(root, e.dataTransfer.files)
  }
  const menuEntries = menu?.entries ?? (menu?.entry ? [menu.entry] : [])
  const singleMenuEntry = menuEntries.length === 1 ? menuEntries[0] : null

  return (
    <ul
      ref={treeRef}
      className={`tree ${rootOver ? 'drop-target-root' : ''} ${selectRect ? 'selection-dragging' : ''}`}
      data-drop-label={rootDropLabel}
      onContextMenu={onRootContext}
      onPointerDown={startMarqueeSelection}
      onKeyDown={handleTreeKeyDown}
      onDragOver={(e) => {
        // 내부 경로 또는 외부 파일일 때만 드롭 허용
        if (
          !e.dataTransfer.types.includes(LT_PATH) &&
          !e.dataTransfer.types.includes(LT_PATHS) &&
          !e.dataTransfer.types.includes('Files')
        )
          return
        e.preventDefault()
        const internal =
          e.dataTransfer.types.includes(LT_PATH) || e.dataTransfer.types.includes(LT_PATHS)
        e.dataTransfer.dropEffect = internal ? 'move' : 'copy'
        setRootDropLabel(internal ? '작성서류 루트로 이동' : '작성서류 루트에 복사')
        setRootOver(true)
      }}
      onDragLeave={(e) => {
        // 자식/손자 행에서 빠져나가는 dragleave도 버블링되므로,
        // 실제 포인터가 루트 트리 밖으로 나간 경우에만 라벨을 지운다.
        if (isLeavingRootDropTarget(e)) clearRootDropState()
      }}
      onDrop={rootDrop}
    >
      {selectRect && (
        <div
          className="tree-select-marquee"
          style={{
            left: selectRect.left,
            top: selectRect.top,
            width: selectRect.width,
            height: selectRect.height
          }}
        />
      )}
      {query ? (
        <>
          {searchErr && <li className="tree-node muted pad">검색 실패: {searchErr}</li>}
          {!searchErr && !searchEntries && <li className="tree-node muted pad">검색 중…</li>}
          {!searchErr && searchEntries && searchEntries.length === 0 && (
            <li className="tree-node muted pad">검색 결과가 없습니다.</li>
          )}
          {!searchErr &&
            searchEntries &&
            sortEntries(searchEntries, sortMode).map((e) => (
              <li key={e.path}>
                {editingPath === e.path ? (
                  <RenameEntryRow
                    entry={e}
                    depth={0}
                    onRename={(name) => commitRename(e.path, name)}
                    onCancel={() => setEditingPath(null)}
                  />
                ) : (
                  <div
                    className={`tree-row tree-search-row ${selectedPaths.has(e.path) ? 'selected' : ''}`}
                    data-entry-path={e.path}
                    data-entry-name={e.name}
                    data-entry-dir={String(e.isDir)}
                    aria-selected={selectedPaths.has(e.path)}
                    style={{ paddingLeft: 8 }}
                    title={e.path}
                    tabIndex={0}
                    draggable
                    onMouseDown={(ev) => {
                      ev.stopPropagation()
                      ev.currentTarget.focus()
                    }}
                    onClick={(ev) => {
                      const selectionOnly = selectForClick(ev, e)
                      if (!selectionOnly) onOpenFile(e.path, e.name)
                    }}
                    onContextMenu={(ev) => onContext(ev, e)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'F2' && onRename) {
                        ev.preventDefault()
                        ev.stopPropagation()
                        setEditingPath(e.path)
                      } else if (ev.key === 'Enter') {
                        ev.preventDefault()
                        onOpenFile(e.path, e.name)
                      }
                    }}
                    onDragStart={(ev) => {
                      if (cancelIfTerminalPointerDrag(ev)) return
                      ev.stopPropagation()
                      writeLtPaths(ev.dataTransfer, selectedDragPaths(e))
                      ev.dataTransfer.effectAllowed = 'copyMove'
                    }}
                  >
                    <span className="tree-icon">{fileIcon(e.name)}</span>
                    <span className="tree-name">{e.name}</span>
                    <span className="tree-path">{relativePath(root, e.path)}</span>
                  </div>
                )}
              </li>
            ))}
        </>
      ) : (
        <>
          {rootCreate && pendingCreate && (
            <CreateEntryRow
              type={pendingCreate.type}
              depth={0}
              onCreate={(name) => onCreate?.(name, pendingCreate.type, root)}
              onCancel={onCancelCreate}
            />
          )}
          {err && <li className="tree-node muted pad">불러오기 실패: {err}</li>}
          {!err && !entries && <li className="tree-node muted pad">불러오는 중…</li>}
          {!err && entries && entries.length === 0 && !rootCreate && (
            <li className="tree-node muted pad">빈 폴더</li>
          )}
          {!err &&
            entries &&
            sortEntries(entries, sortMode).map((e) => (
              <TreeNode
                key={e.path}
                entry={e}
                depth={0}
                refreshNonce={refreshNonce}
                sortMode={sortMode}
                onOpenFile={onOpenFile}
                onDropTo={onDropTo}
                onMove={onMove}
                onRename={onRename ? (path, name) => commitRename(path, name) : undefined}
                selected={selectedPaths.has(e.path)}
                isSelected={(path) => selectedPaths.has(path)}
                onSelectForClick={selectForClick}
                selectedDragPaths={selectedDragPaths}
                editingPath={editingPath}
                onStartRename={setEditingPath}
                onCancelRename={() => setEditingPath(null)}
                onContext={onContext}
                pendingCreate={pendingCreate}
                onCreate={onCreate}
                onCancelCreate={onCancelCreate}
              />
            ))}
        </>
      )}
      {menu && (
        <ul
          className="ctx-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 240),
            top: Math.min(menu.y, window.innerHeight - 120)
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {onRequestCreate && (
            <>
              <li
                className="ctx-item"
                onClick={() => {
                  const dir = menu.pasteDir
                  setMenu(null)
                  onRequestCreate(dir, 'file')
                }}
              >
                새 문서
              </li>
              <li
                className="ctx-item"
                onClick={() => {
                  const dir = menu.pasteDir
                  setMenu(null)
                  onRequestCreate(dir, 'folder')
                }}
              >
                새 폴더
              </li>
            </>
          )}
          {onPasteTo && (
            <li
              className="ctx-item"
              onClick={() => {
                const dir = menu.pasteDir
                setMenu(null)
                onPasteTo(dir)
              }}
            >
              붙여넣기
            </li>
          )}
          {onDownload &&
            ((singleMenuEntry && isRemotePath(singleMenuEntry.path)) || (!menu.entry && isRemotePath(root))) && (
            <li
              className="ctx-item"
              onClick={() => {
                const entry = singleMenuEntry
                const path = entry?.path ?? root
                const name = entry?.name ?? '현재 폴더'
                const isDir = entry?.isDir ?? true
                setMenu(null)
                onDownload(path, name, isDir)
              }}
            >
              다운로드
            </li>
          )}
          {singleMenuEntry && !singleMenuEntry.isDir && onSyncFile && (
            <li
              className="ctx-item"
              onClick={() => {
                const { path, name } = singleMenuEntry
                setMenu(null)
                onSyncFile(path, name)
              }}
            >
              이 파일만 동기화
            </li>
          )}
          {singleMenuEntry?.isDir && onOpenWorkspaceFromFolder && (
            <li
              className="ctx-item"
              onClick={() => {
                const { path, name } = singleMenuEntry
                setMenu(null)
                onOpenWorkspaceFromFolder(path, name)
              }}
            >
              이 폴더로 새 작업환경 열기
            </li>
          )}
          {singleMenuEntry && onRename && (
            <li
              className="ctx-item"
              onClick={() => {
                const { path } = singleMenuEntry
                setMenu(null)
                setEditingPath(path)
              }}
            >
              이름 변경
            </li>
          )}
          {menuEntries.length > 0 && onDelete && (
            <li
              className="ctx-item"
              onClick={() => {
                setMenu(null)
                void deleteEntries(menuEntries)
              }}
            >
              {menuEntries.length > 1 ? `삭제 (${menuEntries.length}개)` : '삭제'}
            </li>
          )}
        </ul>
      )}
    </ul>
  )
}

function TreeNode({
  entry,
  depth,
  refreshNonce,
  sortMode,
  onOpenFile,
  onDropTo,
  onMove,
  onRename,
  selected,
  isSelected,
  onSelectForClick,
  selectedDragPaths,
  editingPath,
  onStartRename,
  onCancelRename,
  onContext,
  pendingCreate,
  onCreate,
  onCancelCreate
}: {
  entry: Entry
  depth: number
  refreshNonce: number
  sortMode: SortMode
  onOpenFile: (path: string, name: string) => void
  onDropTo?: (dir: string, files: FileList) => void
  onMove?: (src: string, destDir: string) => void
  onRename?: (path: string, name: string) => void
  selected: boolean
  isSelected: (path: string) => boolean
  onSelectForClick: (event: React.MouseEvent, entry: Entry) => boolean
  selectedDragPaths: (entry: Entry) => string[]
  editingPath?: string | null
  onStartRename?: (path: string) => void
  onCancelRename?: () => void
  onContext?: (e: React.MouseEvent, entry: Entry) => void
  pendingCreate?: PendingCreateRequest | null
  onCreate?: (name: string, type: 'file' | 'folder', dir?: string) => void
  onCancelCreate?: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<Entry[] | null>(null)
  const [over, setOver] = useState(false)
  const [dropLabel, setDropLabel] = useState('')
  // spring-load: 드래그한 채 폴더 위에 머물면 자동으로 펼침
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadChildren = (opts?: { refresh?: boolean }): void => {
    window.lt.fs
      .list(entry.path, opts)
      .then(setChildren)
      .catch(() => setChildren([]))
  }

  const clearSpring = (): void => {
    if (springTimer.current) {
      clearTimeout(springTimer.current)
      springTimer.current = null
    }
  }
  // 언마운트 시 타이머 정리
  useEffect(() => clearSpring, [])

  // 이동/복사 등으로 nonce가 바뀌면 펼쳐진 폴더 내용 갱신
  useEffect(() => {
    if (entry.isDir && open) loadChildren({ refresh: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce])

  const isCreateTarget =
    !!pendingCreate && entry.isDir && pathKey(createTargetDir(pendingCreate, '')) === pathKey(entry.path)

  useEffect(() => {
    if (!isCreateTarget) return
    if (!open) setOpen(true)
    if (children === null) loadChildren()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCreateTarget, entry.path])

  const onClick = (): void => {
    if (!entry.isDir) {
      onOpenFile(entry.path, entry.name)
      return
    }
    const next = !open
    setOpen(next)
    if (next && children === null) loadChildren()
  }

  const droppable = entry.isDir && (!!onDropTo || !!onMove)
  const renaming = editingPath === entry.path

  return (
    <li>
      <div
        className={`tree-row ${over ? 'drop-target' : ''} ${selected ? 'selected' : ''}`}
        data-entry-path={entry.path}
        data-entry-name={entry.name}
        data-entry-dir={String(entry.isDir)}
        aria-selected={selected}
        data-drop-label={dropLabel}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={
          renaming
            ? undefined
            : (e) => {
                const selectionOnly = onSelectForClick(e, entry)
                if (!selectionOnly) onClick()
              }
        }
        onContextMenu={(e) => onContext?.(e, entry)}
        title={entry.name}
        tabIndex={0}
        draggable={!renaming}
        onMouseDown={(e) => {
          e.stopPropagation()
          e.currentTarget.focus()
        }}
        onKeyDown={(e) => {
          if (e.key === 'F2' && onRename) {
            e.preventDefault()
            e.stopPropagation()
            onStartRename?.(entry.path)
          } else if (e.key === 'Enter' && !renaming) {
            e.preventDefault()
            onClick()
          }
        }}
        onDragStart={(e) => {
          if (cancelIfTerminalPointerDrag(e)) return
          if (renaming) return
          e.stopPropagation()
          writeLtPaths(e.dataTransfer, selectedDragPaths(entry))
          // 폴더로 '이동'과 터미널로 '복사'를 모두 허용 (copy만/move만이면 다른 드롭존에서 '금지' 표시됨)
          e.dataTransfer.effectAllowed = 'copyMove'
        }}
        onDragOver={
          droppable
            ? (e) => {
                // 주의: dragover 중에는 보안상 getData()가 ''를 반환하므로 types로 판별
                if (
                  !e.dataTransfer.types.includes(LT_PATH) &&
                  !e.dataTransfer.types.includes(LT_PATHS) &&
                  !e.dataTransfer.types.includes('Files')
                )
                  return
                e.preventDefault()
                e.stopPropagation()
                const internal =
                  e.dataTransfer.types.includes(LT_PATH) || e.dataTransfer.types.includes(LT_PATHS)
                e.dataTransfer.dropEffect = internal ? 'move' : 'copy'
                setDropLabel(internal ? `${entry.name} 폴더로 이동` : `${entry.name} 폴더에 복사`)
                setOver(true)
                // 닫힌 폴더 위에 머물면 ~0.6초 후 자동으로 펼침
                if (!open && !springTimer.current) {
                  springTimer.current = setTimeout(() => {
                    springTimer.current = null
                    setOpen(true)
                    if (children === null) loadChildren()
                  }, 600)
                }
              }
            : undefined
        }
        onDragLeave={(e) => {
          // 자식 요소(아이콘/이름)로 옮겨갈 때 발생하는 dragleave는 무시,
          // 실제로 행 밖으로 나갔을 때만 해제 (spring-load 타이머 유지)
          if (e.currentTarget.contains(e.relatedTarget as Node)) return
          setOver(false)
          setDropLabel('')
          clearSpring()
        }}
        onDrop={
          droppable
            ? (e) => {
                e.preventDefault()
                e.stopPropagation()
                setOver(false)
                setDropLabel('')
                clearSpring()
                const paths = readLtPaths(e.dataTransfer)
                if (paths.length) {
                  for (const src of paths) {
                    if (pathKey(src) !== pathKey(entry.path)) onMove?.(src, entry.path)
                  }
                } else if (e.dataTransfer.files.length) {
                  onDropTo?.(entry.path, e.dataTransfer.files)
                }
              }
            : undefined
        }
      >
        <span className="tree-icon">
          {entry.isDir ? (open ? '📂' : '📁') : fileIcon(entry.name)}
        </span>
        {renaming && onRename ? (
          <RenameEntryInput
            entry={entry}
            onRename={(name) => onRename(entry.path, name)}
            onCancel={onCancelRename}
          />
        ) : (
          <span className="tree-name">{entry.name}</span>
        )}
      </div>
      {entry.isDir && open && (
        <ul className="tree">
          {isCreateTarget && pendingCreate && (
            <CreateEntryRow
              type={pendingCreate.type}
              depth={depth + 1}
              onCreate={(name) => onCreate?.(name, pendingCreate.type, entry.path)}
              onCancel={onCancelCreate}
            />
          )}
          {children === null ? (
            <li className="tree-node muted pad small">불러오는 중…</li>
          ) : (
            <>
              {children.length === 0 && !isCreateTarget && (
                <li className="tree-node muted pad small">빈 폴더</li>
              )}
              {sortEntries(children, sortMode).map((c) => (
                <TreeNode
                  key={c.path}
                  entry={c}
                  depth={depth + 1}
                  refreshNonce={refreshNonce}
                  sortMode={sortMode}
                  onOpenFile={onOpenFile}
                  onDropTo={onDropTo}
                  onMove={onMove}
                  onRename={onRename}
                  selected={isSelected(c.path)}
                  isSelected={isSelected}
                  onSelectForClick={onSelectForClick}
                  selectedDragPaths={selectedDragPaths}
                  editingPath={editingPath}
                  onStartRename={onStartRename}
                  onCancelRename={onCancelRename}
                  onContext={onContext}
                  pendingCreate={pendingCreate}
                  onCreate={onCreate}
                  onCancelCreate={onCancelCreate}
                />
              ))}
            </>
          )}
        </ul>
      )}
    </li>
  )
}

function RenameEntryRow({
  entry,
  depth,
  onRename,
  onCancel
}: {
  entry: Entry
  depth: number
  onRename: (name: string) => void
  onCancel?: () => void
}): JSX.Element {
  return (
    <div className="tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="tree-icon">{entry.isDir ? '📁' : fileIcon(entry.name)}</span>
      <RenameEntryInput entry={entry} onRename={onRename} onCancel={onCancel} />
    </div>
  )
}

function RenameEntryInput({
  entry,
  onRename,
  onCancel
}: {
  entry: Entry
  onRename: (name: string) => void
  onCancel?: () => void
}): JSX.Element {
  const [value, setValue] = useState(entry.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    if (entry.isDir) {
      input.select()
      return
    }
    const dot = entry.name.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : entry.name.length)
  }, [entry.isDir, entry.name])

  const cancel = (): void => {
    if (done.current) return
    done.current = true
    onCancel?.()
  }
  const commit = (): void => {
    if (done.current) return
    done.current = true
    const next = value.trim()
    if (!next || next === entry.name) {
      onCancel?.()
      return
    }
    onRename(next)
  }

  return (
    <input
      ref={inputRef}
      className="tree-input tree-rename-input"
      autoFocus
      value={value}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (isComposingKeyEvent(e)) return
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
      onBlur={commit}
    />
  )
}

function CreateEntryRow({
  type,
  depth,
  onCreate,
  onCancel
}: {
  type: 'file' | 'folder'
  depth: number
  onCreate: (name: string) => void
  onCancel?: () => void
}): JSX.Element {
  const initialName = type === 'folder' ? '새 폴더' : '새 문서.md'
  const [value, setValue] = useState(initialName)
  const inputRef = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    if (type === 'folder') {
      input.select()
      return
    }
    const dot = initialName.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : initialName.length)
  }, [initialName, type])

  const cancel = (): void => {
    if (done.current) return
    done.current = true
    onCancel?.()
  }
  const commit = (): void => {
    if (done.current) return
    const next = value.trim()
    if (!next) {
      cancel()
      return
    }
    done.current = true
    onCreate(next)
  }

  return (
    <li>
      <div className="tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
        <span className="tree-icon">{type === 'folder' ? '📁' : '📄'}</span>
        <input
          ref={inputRef}
          className="tree-input"
          autoFocus
          placeholder={type === 'folder' ? '폴더 이름' : '파일 이름 (비우면 무제)'}
          value={value}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (isComposingKeyEvent(e)) return
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
          onBlur={commit}
        />
      </div>
    </li>
  )
}
