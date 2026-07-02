import { Fragment, useState } from 'react'
import { visibleDiffFallbackText, type DiffView } from './diff'

export function DiffPreview({
  diff,
  fallbackText,
  alwaysExpanded = false
}: {
  diff?: DiffView
  fallbackText?: string
  alwaysExpanded?: boolean
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const isExpanded = alwaysExpanded || expanded

  if (!diff || diff.hunks.length === 0) {
    if (!fallbackText) return null
    const fallbackPreview = visibleDiffFallbackText(fallbackText)
    const isLongFallback = fallbackPreview.truncated
    const visibleText = isLongFallback && !isExpanded ? fallbackPreview.text : fallbackText

    return (
      <div className="agent-diff-fallback">
        <pre className="agent-card-text">{visibleText}</pre>
        {isLongFallback && !alwaysExpanded && (
          <button
            type="button"
            className="agent-diff-toggle"
            aria-expanded={isExpanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {isExpanded ? '접기' : '전체 펼쳐보기'}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="agent-diff-view">
      <div className="agent-diff-summary">
        <span className="agent-diff-count add">+{diff.additions}</span>
        <span className="agent-diff-count remove">-{diff.deletions}</span>
        {!alwaysExpanded && (
          <button
            type="button"
            className="agent-diff-toggle"
            aria-expanded={isExpanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {isExpanded ? '접기' : '펼쳐보기'}
          </button>
        )}
      </div>
      {isExpanded && (
        <>
          <div className="agent-diff-labels" aria-hidden="true">
            <span>변경 전</span>
            <span>변경 후</span>
          </div>
          {diff.hunks.map((hunk, hunkIndex) => (
            <div key={`${hunk.label ?? 'hunk'}-${hunkIndex}`} className="agent-diff-hunk">
              {(hunk.label || diff.hunks.length > 1) && (
                <div className="agent-diff-hunk-title">{hunk.label ?? `Hunk ${hunkIndex + 1}`}</div>
              )}
              <div className="agent-diff-grid">
                {hunk.rows.map((row, rowIndex) => (
                  <Fragment key={`${hunkIndex}-${rowIndex}`}>
                    <div className={`agent-diff-line before ${row.kind}`}>
                      <span className="agent-diff-line-no">{row.beforeNo ?? ''}</span>
                      <span className="agent-diff-line-text">{row.before ?? ''}</span>
                    </div>
                    <div className={`agent-diff-line after ${row.kind}`}>
                      <span className="agent-diff-line-no">{row.afterNo ?? ''}</span>
                      <span className="agent-diff-line-text">{row.after ?? ''}</span>
                    </div>
                  </Fragment>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
