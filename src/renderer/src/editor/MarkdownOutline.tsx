import { useId, useRef, useState } from 'react'
import { parser, GFM } from '@lezer/markdown'
import DOMPurify from 'dompurify'
import { parseMarkdown } from './markdownCompat'
import './MarkdownOutline.css'

export interface MarkdownHeading {
  from: number
  level: number
  title: string
}

const markdownParser = parser.configure(GFM)

export function markdownHeadings(text: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = []
  markdownParser.parse(text).iterate({
    enter(node) {
      const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name)
      if (!match) return
      const label = document.createElement('span')
      label.innerHTML = DOMPurify.sanitize(parseMarkdown(text.slice(node.from, node.to)), {
        ALLOWED_TAGS: [], ALLOWED_ATTR: []
      })
      headings.push({
        from: node.from,
        level: Number(match[1]),
        title: label.textContent?.replace(/\s+/g, ' ').trim() || '제목 없음'
      })
      return false
    }
  })
  return headings
}

export default function MarkdownOutline({ headings, active, onNavigate }: {
  headings: MarkdownHeading[]
  active: number | null
  onNavigate: (heading: MarkdownHeading) => void
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  if (!headings.length) return null

  return (
    <div
      className="md-outline"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) setOpen(false)
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="md-outline-trigger"
        title="문서 개요"
        aria-label="문서 개요"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(true)}
      >
        {headings.map((heading) => (
          <span
            key={heading.from}
            className={`md-outline-mark${heading.from === active ? ' active' : ''}`}
            style={{ width: `${18 - (heading.level - 1) * 2}px` }}
          />
        ))}
      </button>
      {open && (
        <nav id={panelId} className="md-outline-panel" aria-label="문서 개요">
          <div className="md-outline-title">문서 개요</div>
          <div className="md-outline-items">
            {headings.map((heading) => (
              <button
                key={heading.from}
                type="button"
                className={`md-outline-item${heading.from === active ? ' active' : ''}`}
                style={{ paddingLeft: `${10 + (heading.level - 1) * 12}px` }}
                title={heading.title}
                aria-current={heading.from === active ? 'location' : undefined}
                onClick={() => {
                  setOpen(false)
                  onNavigate(heading)
                }}
              >
                <span className="md-outline-item-mark" aria-hidden="true" />
                <span className="md-outline-label">{heading.title}</span>
              </button>
            ))}
          </div>
        </nav>
      )}
    </div>
  )
}
