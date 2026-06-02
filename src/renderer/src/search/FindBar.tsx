import { useEffect, useRef } from 'react'

export interface FindBarProps {
  value: string
  placeholder?: string
  resultLabel?: string
  onChange: (value: string) => void
  onPrev?: () => void
  onNext?: () => void
  onClose: () => void
}

export default function FindBar({
  value,
  placeholder = '찾기',
  resultLabel = '',
  onChange,
  onPrev,
  onNext,
  onClose
}: FindBarProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [])

  return (
    <div className="find-bar" onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className="find-input"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) onPrev?.()
            else onNext?.()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span className="find-count">{resultLabel}</span>
      {(onPrev || onNext) && (
        <>
          <button className="find-btn" title="이전" onClick={onPrev}>
            ‹
          </button>
          <button className="find-btn" title="다음" onClick={onNext}>
            ›
          </button>
        </>
      )}
      <button className="find-btn" title="닫기" onClick={onClose}>
        ×
      </button>
    </div>
  )
}
