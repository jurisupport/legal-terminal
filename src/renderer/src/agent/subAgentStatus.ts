interface ProcessGroup {
  processSteps?: readonly { id: string; status?: string; toolName?: string }[]
}

export const isSubAgentStep = (step: { id: string; toolName?: string }): boolean =>
  step.id.startsWith('codex-agent:') || step.toolName === 'Agent' || step.toolName === 'Task'

export function activeSubAgentCount(groups: readonly ProcessGroup[]): number {
  const ids = new Set<string>()
  for (const group of groups) {
    for (const step of group.processSteps ?? []) {
      if (step.status === 'running' && isSubAgentStep(step)) ids.add(step.id)
    }
  }
  return ids.size
}
