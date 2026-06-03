import { useEffect, useRef, useState } from 'react'

export interface Entry {
  name: string
  path: string
  isDir: boolean
  mtimeMs?: number
}

export type SortMode = 'name-asc' | 'name-desc' | 'mtime-desc' | 'mtime-asc'

// 트리 내부 드래그 식별용 MIME (외부 OS 파일 드롭과 구분)
export const LT_PATH = 'application/x-lt-path'

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
  if (n.endsWith('.md')) return '📝'
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

/** 활성 사건 폴더(root)의 파일트리. 폴더는 펼칠 때 지연 로딩. */
export default function FileTree({
  root,
  refreshNonce = 0,
  onOpenFile,
  onDropTo,
  onMove,
  onDelete,
  onPasteTo,
  onDownload,
  pendingCreate = null,
  sortMode = 'name-asc',
  onCreate,
  onCancelCreate,
  filter = ''
}: {
  root: string
  refreshNonce?: number
  onOpenFile: (path: string, name: string) => void
  onDropTo?: (dir: string, files: FileList) => void
  onMove?: (src: string, destDir: string) => void
  onDelete?: (path: string, name: string, isDir: boolean) => void
  onPasteTo?: (dir: string) => void
  onDownload?: (path: string, name: string, isDir: boolean) => void
  pendingCreate?: 'file' | 'folder' | null
  sortMode?: SortMode
  onCreate?: (name: string, type: 'file' | 'folder') => void
  onCancelCreate?: () => void
  filter?: string
}): JSX.Element {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [searchEntries, setSearchEntries] = useState<Entry[] | null>(null)
  const [searchErr, setSearchErr] = useState('')
  const [err, setErr] = useState<string>('')
  const [rootOver, setRootOver] = useState(false)
  const [rootDropLabel, setRootDropLabel] = useState('')
  const lastRoot = useRef<string | null>(null)
  const entriesRef = useRef<Entry[] | null>(null)
  const query = filter.trim()
  // 우클릭 컨텍스트 메뉴 (붙여넣기/다운로드/삭제 등)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    entry?: Entry
    pasteDir: string
  } | null>(null)
  const onContext = (e: React.MouseEvent, entry: Entry): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      entry,
      pasteDir: entry.isDir ? entry.path : parentPath(entry.path, root)
    })
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
    let alive = true
    const rootChanged = lastRoot.current !== root
    lastRoot.current = root
    const hasEntries = entriesRef.current !== null
    if (rootChanged) setEntries(null)
    if (rootChanged) entriesRef.current = null
    if (rootChanged || !hasEntries) setErr('')
    window.lt.fs
      .list(root)
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
    setRootOver(false)
    setRootDropLabel('')
    const src = e.dataTransfer.getData(LT_PATH)
    if (src) onMove?.(src, root)
    else if (e.dataTransfer.files.length) onDropTo?.(root, e.dataTransfer.files)
  }

  return (
    <ul
      className={`tree ${rootOver ? 'drop-target-root' : ''}`}
      data-drop-label={rootDropLabel}
      onContextMenu={onRootContext}
      onDragOver={(e) => {
        // 내부 경로 또는 외부 파일일 때만 드롭 허용
        if (!e.dataTransfer.types.includes(LT_PATH) && !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        const internal = e.dataTransfer.types.includes(LT_PATH)
        e.dataTransfer.dropEffect = internal ? 'move' : 'copy'
        setRootDropLabel(internal ? '작성서류 루트로 이동' : '작성서류 루트에 복사')
        setRootOver(true)
      }}
      onDragLeave={(e) => {
        // 자식으로 들어간 경우는 무시 (루트 밖으로 나갈 때만 해제)
        if (e.currentTarget === e.target) {
          setRootOver(false)
          setRootDropLabel('')
        }
      }}
      onDrop={rootDrop}
    >
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
                <div
                  className="tree-row tree-search-row"
                  style={{ paddingLeft: 8 }}
                  title={e.path}
                  draggable
                  onClick={() => onOpenFile(e.path, e.name)}
                  onContextMenu={(ev) => onContext(ev, e)}
                  onDragStart={(ev) => {
                    ev.stopPropagation()
                    ev.dataTransfer.setData(LT_PATH, e.path)
                    ev.dataTransfer.effectAllowed = 'copyMove'
                  }}
                >
                  <span className="tree-icon">{fileIcon(e.name)}</span>
                  <span className="tree-name">{e.name}</span>
                  <span className="tree-path">{relativePath(root, e.path)}</span>
                </div>
              </li>
            ))}
        </>
      ) : (
        <>
      {pendingCreate && (
        <li>
          <div className="tree-row" style={{ paddingLeft: 8 }}>
            <span className="tree-icon">{pendingCreate === 'folder' ? '📁' : '📄'}</span>
            <input
              className="tree-input"
              autoFocus
              placeholder={pendingCreate === 'folder' ? '폴더 이름' : '파일 이름 (비우면 무제)'}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onCreate?.((e.target as HTMLInputElement).value, pendingCreate)
                else if (e.key === 'Escape') onCancelCreate?.()
              }}
              onBlur={(e) =>
                e.target.value.trim() ? onCreate?.(e.target.value, pendingCreate) : onCancelCreate?.()
              }
            />
          </div>
        </li>
      )}
      {err && <li className="tree-node muted pad">불러오기 실패: {err}</li>}
      {!err && !entries && <li className="tree-node muted pad">불러오는 중…</li>}
      {!err && entries && entries.length === 0 && !pendingCreate && (
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
            onContext={onContext}
          />
        ))}
        </>
      )}
      {menu && (
        <ul
          className="ctx-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 180),
            top: Math.min(menu.y, window.innerHeight - 120)
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
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
            ((menu.entry && isRemotePath(menu.entry.path)) || (!menu.entry && isRemotePath(root))) && (
            <li
              className="ctx-item"
              onClick={() => {
                const entry = menu.entry
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
          {menu.entry && onDelete && (
            <li
              className="ctx-item"
              onClick={() => {
                const { path, name, isDir } = menu.entry as Entry
                setMenu(null)
                if (window.confirm(`'${name}'${isDir ? ' 폴더' : ''}을(를) 삭제할까요?`))
                  onDelete(path, name, isDir)
              }}
            >
              삭제
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
  onContext
}: {
  entry: Entry
  depth: number
  refreshNonce: number
  sortMode: SortMode
  onOpenFile: (path: string, name: string) => void
  onDropTo?: (dir: string, files: FileList) => void
  onMove?: (src: string, destDir: string) => void
  onContext?: (e: React.MouseEvent, entry: Entry) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<Entry[] | null>(null)
  const [over, setOver] = useState(false)
  const [dropLabel, setDropLabel] = useState('')
  // spring-load: 드래그한 채 폴더 위에 머물면 자동으로 펼침
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadChildren = (): void => {
    window.lt.fs
      .list(entry.path)
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
    if (entry.isDir && open) loadChildren()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce])

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

  return (
    <li>
      <div
        className={`tree-row ${over ? 'drop-target' : ''}`}
        data-drop-label={dropLabel}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={onClick}
        onContextMenu={(e) => onContext?.(e, entry)}
        title={entry.name}
        draggable
        onDragStart={(e) => {
          e.stopPropagation()
          e.dataTransfer.setData(LT_PATH, entry.path)
          // 폴더로 '이동'과 터미널로 '복사'를 모두 허용 (copy만/move만이면 다른 드롭존에서 '금지' 표시됨)
          e.dataTransfer.effectAllowed = 'copyMove'
        }}
        onDragOver={
          droppable
            ? (e) => {
                // 주의: dragover 중에는 보안상 getData()가 ''를 반환하므로 types로 판별
                if (
                  !e.dataTransfer.types.includes(LT_PATH) &&
                  !e.dataTransfer.types.includes('Files')
                )
                  return
                e.preventDefault()
                e.stopPropagation()
                const internal = e.dataTransfer.types.includes(LT_PATH)
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
                const src = e.dataTransfer.getData(LT_PATH)
                if (src) {
                  if (src !== entry.path) onMove?.(src, entry.path)
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
        <span className="tree-name">{entry.name}</span>
      </div>
      {entry.isDir && open && children && (
        <ul className="tree">
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
              onContext={onContext}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
