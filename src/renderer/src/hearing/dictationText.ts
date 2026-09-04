export interface DictationInsertion {
  value: string
  caret: number
}

export function isDictationShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat' | 'isComposing'>
): boolean {
  return (
    (event.key.toLowerCase() === 'd' || event.code === 'KeyD') &&
    (event.ctrlKey || event.metaKey) &&
    event.shiftKey &&
    !event.altKey &&
    !event.repeat &&
    !event.isComposing
  )
}

export function insertDictationText(
  value: string,
  dictated: string,
  selectionStart: number,
  selectionEnd: number
): DictationInsertion {
  const text = dictated.trim()
  const start = Math.max(0, Math.min(value.length, selectionStart))
  const end = Math.max(start, Math.min(value.length, selectionEnd))
  if (!text) return { value, caret: start }

  const before = value.slice(0, start)
  const after = value.slice(end)
  const needsLeadingSpace =
    before.length > 0 &&
    !/\s$/.test(before) &&
    !/^[,.;:!?)}\]]/.test(text) &&
    !/[([{（［【]$/.test(before)
  const needsTrailingSpace =
    after.length > 0 &&
    !/^\s/.test(after) &&
    !/[,.!?:;)}\]]$/.test(text) &&
    !/^[,.;:!?)}\]]/.test(after)
  const inserted = `${needsLeadingSpace ? ' ' : ''}${text}${needsTrailingSpace ? ' ' : ''}`
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + inserted.length
  }
}
