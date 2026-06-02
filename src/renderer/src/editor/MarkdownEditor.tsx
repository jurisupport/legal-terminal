import { useEffect, useRef, useState } from 'react'
import { Decoration, EditorView, keymap, drawSelection, dropCursor, type DecorationSet } from '@codemirror/view'
import { EditorSelection, EditorState, Compartment, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { livePreview } from './livePreview'
import { mdToPrintHtml } from './mdExport'
import FindBar from '../search/FindBar'
import { IconSearch } from '../icons/Icons'

const DEFAULT_MD_FONT = "'D2Coding', 'Cascadia Mono', Consolas, monospace"

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

/**
 * 마크다운 편집기 (CodeMirror 6). 서식(라이브 프리뷰)·원본 두 모드 모두 편집 가능.
 * path 없으면 새 문서(스크래치) — Ctrl+S로 다른 이름 저장 후 자동 저장.
 */
export default function MarkdownEditor({
  path,
  defaultDir,
  onPath,
  onAsk,
  onSendToJuriSupport,
  onDirty
}: {
  path?: string
  defaultDir?: string
  onPath?: (path: string) => void
  onAsk?: () => void
  onSendToJuriSupport?: (doc: MarkdownDocumentPayload) => void
  // 닫으면 데이터가 사라질 위험(저장 안 된 새 문서에 내용 있음)을 알린다
  onDirty?: (dirty: boolean) => void
}): JSX.Element {
  const onDirtyRef = useRef(onDirty)
  onDirtyRef.current = onDirty
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const previewComp = useRef(new Compartment())
  const pathRef = useRef<string | undefined>(path)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedRef = useRef(!!path)
  const localDirtyRef = useRef(false)
  const applyingRemoteRef = useRef(false)
  const remoteSigRef = useRef('')
  const findOpenRef = useRef(false)
  const findQueryRef = useRef('')
  const findIndexRef = useRef(-1)
  const applyFindRef = useRef<(query: string, requestedIndex: number) => void>(() => {})
  const openFindRef = useRef<() => void>(() => {})
  const [preview, setPreview] = useState(true)
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState(!!path)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findCount, setFindCount] = useState(0)
  const [findIndex, setFindIndex] = useState(-1)

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

  const saveNow = (): void => {
    const v = viewRef.current
    if (!v) return
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const content = v.state.doc.toString()
    if (pathRef.current) {
      window.lt.fs.writeText(pathRef.current, content).then((r) => {
        if (!r.ok || !pathRef.current) return
        localDirtyRef.current = false
        setSavedState(true)
        window.lt.fs.stat(pathRef.current).then((s) => {
          if (s.ok) remoteSigRef.current = `${s.size}:${s.mtimeMs ?? 0}`
        })
      })
    } else {
      window.lt.fs.saveAs(content, defaultDir).then((r) => {
        if (r.ok && r.path) {
          pathRef.current = r.path
          onPath?.(r.path)
          localDirtyRef.current = false
          setSavedState(true)
          onDirtyRef.current?.(false) // 이제 경로가 있으니 닫아도 안전
        }
      })
    }
  }
  const scheduleSave = (): void => {
    if (!pathRef.current) return // 새 문서는 Ctrl+S(다른 이름 저장) 때만
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(saveNow, 700)
  }

  useEffect(() => {
    let alive = true
    setErr('')
    const init = pathRef.current ? window.lt.fs.readText(pathRef.current) : Promise.resolve({ text: '' })
    Promise.all([init, window.lt.settings.get()])
      .then(([r, s]) => {
        if (!alive || !hostRef.current) return
        const family = s.mdFont || DEFAULT_MD_FONT
        const size = s.mdFontSize || 14
        const state = EditorState.create({
          doc: (r as { text: string }).text,
          extensions: [
            history(),
            drawSelection(),
            dropCursor(),
            keymap.of([
              ...defaultKeymap,
              ...historyKeymap,
              indentWithTab,
              { key: 'Mod-f', run: () => (openFindRef.current(), true) },
              { key: 'Mod-s', run: () => (saveNow(), true) }
            ]),
            markdown({ extensions: GFM }),
            syntaxHighlighting(defaultHighlightStyle),
            EditorView.lineWrapping,
            findHighlightField,
            makeTheme(family, size),
            previewComp.current.of(preview ? livePreview : []),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) {
                if (applyingRemoteRef.current) {
                  localDirtyRef.current = false
                  setSavedState(true)
                  return
                }
                localDirtyRef.current = true
                setSavedState(false)
                scheduleSave()
                // 경로 없는(스크래치) 문서에 내용이 있으면 닫을 때 사라짐 → dirty
                onDirtyRef.current?.(!pathRef.current && u.state.doc.length > 0)
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
        localDirtyRef.current = false
        setSavedState(!!pathRef.current)
        viewRef.current = new EditorView({ state, parent: hostRef.current })
        viewRef.current.focus()
      })
      .catch((e) => alive && setErr(String(e)))
    return () => {
      alive = false
      if (pathRef.current) saveNow()
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pathRef.current?.startsWith('ssh://')) return
    let alive = true
    const tick = (): void => {
      const currentPath = pathRef.current
      if (!currentPath) return
      window.lt.fs
        .stat(currentPath)
        .then((s) => {
          if (!alive || !s.ok) return
          const sig = `${s.size}:${s.mtimeMs ?? 0}`
          if (!remoteSigRef.current) {
            remoteSigRef.current = sig
            return
          }
          if (sig === remoteSigRef.current) return
          window.lt.fs
            .readText(currentPath)
            .then((r) => {
              if (!alive || r.kind !== 'text' || r.truncated) return
              const v = viewRef.current
              remoteSigRef.current = sig
              if (!v) return
              const next = r.text
              const current = v.state.doc.toString()
              if (next === current) {
                localDirtyRef.current = false
                setSavedState(true)
                return
              }
              if (localDirtyRef.current || !savedRef.current) return
              applyingRemoteRef.current = true
              try {
                v.dispatch({
                  changes: { from: 0, to: v.state.doc.length, insert: next }
                })
              } finally {
                applyingRemoteRef.current = false
              }
              localDirtyRef.current = false
              setSavedState(true)
            })
            .catch(() => {})
        })
        .catch(() => {})
    }
    tick()
    const timer = setInterval(tick, 2500)
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

  return (
    <div className="text-doc">
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
          title="PDF로 내보내기"
          onClick={() => {
            const v = viewRef.current
            if (!v) return
            const name = (pathRef.current?.split(/[\\/]/).pop() ?? '문서').replace(/\.[^.]+$/, '')
            const def =
              (pathRef.current?.replace(/\.[^.]+$/, '') ?? (defaultDir ? defaultDir + '\\' + name : name)) +
              '.pdf'
            window.lt.export.mdToPdf(mdToPrintHtml(v.state.doc.toString(), name), def)
          }}
        >
          PDF
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
            <button className="tb-btn" title="이 문서에 대해 Claude에 물어보기" onClick={onAsk}>
              ✳ Claude
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
        <span className="tb-sep-text">{saved ? '저장됨' : pathRef.current ? '저장 중…' : '미저장 (Ctrl+S)'}</span>
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
      <div className={`cm-host ${preview ? 'preview' : 'source'}`} ref={hostRef} />
    </div>
  )
}
