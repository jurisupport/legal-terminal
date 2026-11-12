export function closeTab<T extends { id: string }>(
  tabs: T[],
  id: string,
  activeId: string,
  setActive: (id: string) => void,
  visibleTabs: readonly T[]
): T[] {
  if (id === activeId) {
    const idx = visibleTabs.findIndex((tab) => tab.id === id)
    const next = visibleTabs[idx - 1] ?? visibleTabs[idx + 1]
    setActive(next?.id ?? '')
  }
  return tabs.filter((tab) => tab.id !== id)
}

export function closeTabs<T extends { id: string }>(
  tabs: T[],
  ids: ReadonlySet<string>,
  activeId: string,
  setActive: (id: string) => void,
  visibleTabs: readonly T[]
): T[] {
  if (ids.has(activeId)) {
    const idx = visibleTabs.findIndex((tab) => tab.id === activeId)
    const next = visibleTabs.slice(idx + 1).find((tab) => !ids.has(tab.id)) ??
      visibleTabs.slice(0, Math.max(idx, 0)).reverse().find((tab) => !ids.has(tab.id))
    setActive(next?.id ?? '')
  }
  return tabs.filter((tab) => !ids.has(tab.id))
}
