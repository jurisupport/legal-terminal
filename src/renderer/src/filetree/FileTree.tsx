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

/** 활성 사건 폴더(root)의 파일트리. 폴더는 펼칠 때 지연 로딩. */
export default function FileTree({
  root,
  refreshNonce = 0,
  onOpenFile,
  onDropTo,
  onMove,
  onDelete,
  pendingCreate = null,
  sortMode = 'name-asc',
  onCreate,
  onCancelCreate
}: {
  root: string
  refreshNonce?: number
  onOpenFile: (path: string, name: string) => void
  onDropTo?: (dir: string, files: FileList) => void
  onMove?: (src: string, destDir: string) => void
  onDelete?: (path: string, name: string, isDir: boolean) => void
  pendingCreate?: 'file' | 'folder' | null
  sortMode?: SortMode
  onCreate?: (name: string, type: 'file' | 'folder') => void
  onCancelCreate?: () => void
}): JSX.Element {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [err, setErr] = useState<string>('')
  const [rootOver, setRootOver] = useState(false)
  const lastRoot = useRef<string | null>(null)
  const entriesRef = useRef<Entry[] | null>(null)
  // 우클릭 컨텍스트 메뉴 (삭제 등)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: Entry } | null>(null)
  const onContext = (e: React.MouseEvent, entry: Entry): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, entry })
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

  // 트리 빈 영역/루트로 드롭 → root 폴더로 이동(내부) 또는 복사(외부)
  const rootDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setRootOver(false)
    const src = e.dataTransfer.getData(LT_PATH)
    if (src) onMove?.(src, root)
    else if (e.dataTransfer.files.length) onDropTo?.(root, e.dataTransfer.files)
  }

  return (
    <ul
      className={`tree ${rootOver ? 'drop-target-root' : ''}`}
      onDragOver={(e) => {
        // 내부 경로 또는 외부 파일일 때만 드롭 허용
        if (!e.dataTransfer.types.includes(LT_PATH) && !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes(LT_PATH) ? 'move' : 'copy'
        setRootOver(true)
      }}
      onDragLeave={(e) => {
        // 자식으로 들어간 경우는 무시 (루트 밖으로 나갈 때만 해제)
        if (e.currentTarget === e.target) setRootOver(false)
      }}
      onDrop={rootDrop}
    >
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
      {menu && (
        <ul
          className="ctx-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 160),
            top: Math.min(menu.y, window.innerHeight - 80)
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <li
            className="ctx-item"
            onClick={() => {
              const { path, name, isDir } = menu.entry
              setMenu(null)
              if (window.confirm(`'${name}'${isDir ? ' 폴더' : ''}을(를) 삭제할까요?`))
                onDelete?.(path, name, isDir)
            }}
          >
            🗑 삭제
          </li>
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
                e.dataTransfer.dropEffect = e.dataTransfer.types.includes(LT_PATH)
                  ? 'move'
                  : 'copy'
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
          clearSpring()
        }}
        onDrop={
          droppable
            ? (e) => {
                e.preventDefault()
                e.stopPropagation()
                setOver(false)
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
