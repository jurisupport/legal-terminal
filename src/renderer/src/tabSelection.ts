export function closeTab<T extends { id: string }>(
  tabs: T[],
  id: string,
  activeId: string,
  setActive: (id: string) => void,
  visibleTabs: readonly T[]
): T[] {
  return closeTabs(tabs, new Set([id]), activeId, setActive, visibleTabs)
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
