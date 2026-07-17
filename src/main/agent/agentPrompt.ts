export function prependAgentContext(context: string | undefined, prompt: string): string {
  const scoped = context?.trim()
  return scoped ? `${scoped}\n\n<legal-terminal-user-request>\n${prompt}\n</legal-terminal-user-request>` : prompt
}
