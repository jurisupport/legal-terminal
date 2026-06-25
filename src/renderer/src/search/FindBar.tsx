import { useEffect, useRef } from 'react'

export interface FindBarProps {
  value: string
  placeholder?: string
  resultLabel?: string
  replaceOpen?: boolean
  replaceValue?: string
  replacePlaceholder?: string
  onChange: (value: string) => void
  onReplaceOpenChange?: (value: boolean) => void
  onReplaceChange?: (value: string) => void
  onReplace?: () => void
  onReplaceAll?: () => void
  onPrev?: () => void
  onNext?: () => void
  onClose: () => void
}

export default function FindBar({
  value,
  placeholder = '찾기',
  resultLabel = '',
  replaceOpen = false,
  replaceValue = '',
  replacePlaceholder = '바꿀 내용',
  onChange,
  onReplaceOpenChange,
  onReplaceChange,
  onReplace,
  onReplaceAll,
  onPrev,
  onNext,
  onClose
}: FindBarProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const canReplace = !!onReplaceOpenChange

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [])

  useEffect(() => {
    if (!replaceOpen) return
    replaceInputRef.current?.focus()
    replaceInputRef.current?.select()
  }, [replaceOpen])

  return (
    <div className="find-bar" onMouseDown={(e) => e.stopPropagation()}>
      <div className="find-row">
        {canReplace && (
          <button
            className="find-btn find-toggle"
            title={replaceOpen ? '찾아바꾸기 접기' : '찾아바꾸기 펼치기'}
            onClick={() => onReplaceOpenChange?.(!replaceOpen)}
          >
            {replaceOpen ? '▴' : '▾'}
          </button>
        )}
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
      {canReplace && replaceOpen && (
        <div className="find-row find-replace-row">
          <span className="find-toggle-spacer" />
          <input
            ref={replaceInputRef}
            className="find-input"
            value={replaceValue}
            placeholder={replacePlaceholder}
            spellCheck={false}
            onChange={(e) => onReplaceChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onReplace?.()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              }
            }}
          />
          <button className="find-btn find-replace-btn" title="현재 항목 바꾸기" onClick={onReplace}>
            바꾸기
          </button>
          <button className="find-btn find-replace-btn" title="모두 바꾸기" onClick={onReplaceAll}>
            모두
          </button>
        </div>
      )}
    </div>
  )
}
