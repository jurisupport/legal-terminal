export interface ModelDisplayOption {
  model: string
  displayName: string
  resolvedModel?: string
  isDefault?: boolean
  supportedReasoningEfforts?: unknown[]
  defaultReasoningEffort?: string
}

export function currentAgentModel(
  options: ModelDisplayOption[],
  selectedModel?: string,
  selectedReasoningEffort?: string
): { model?: string; modelLabel: string; effort?: string; buttonLabel: string } {
  const option = selectedModel
    ? options.find((item) => item.model === selectedModel)
    : options.find((item) => item.isDefault)
  const modelLabel = option?.resolvedModel ?? option?.displayName ?? selectedModel ?? '기본 모델'
  const effort = selectedReasoningEffort
    ?? option?.defaultReasoningEffort
    ?? (option?.supportedReasoningEfforts?.length ? '기본값' : undefined)
  return {
    model: selectedModel ?? option?.model,
    modelLabel,
    effort,
    buttonLabel: effort ? `${modelLabel} · ${effort}` : modelLabel
  }
}
