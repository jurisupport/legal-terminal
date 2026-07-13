export function closeTab<T extends { id: string }>(
  tabs: T[],
  id: string,
  activeId: string,
  setActive: (id: string) => void,
  visibleTabs: readonly T[]
): T[] {
  const idx = visibleTabs.findIndex((tab) => tab.id === id)
  const nextVisible = visibleTabs.filter((tab) => tab.id !== id)
  if (id === activeId) {
    setActive(
      nextVisible.length > 0
        ? nextVisible[Math.min(Math.max(idx, 0), nextVisible.length - 1)].id
        : ''
    )
  }
  return tabs.filter((tab) => tab.id !== id)
}
