export interface SkillGuideProfile {
  id: string
  label: string
  host: string
  user: string
}

export type SkillInstallTarget =
  | { kind: 'local' }
  | { kind: 'ssh'; profile: SkillGuideProfile }

export function resolveSkillInstallTarget(settings: {
  caseOpenTarget?: string
  sshProfiles?: SkillGuideProfile[]
}): SkillInstallTarget {
  const profileId = settings.caseOpenTarget?.startsWith('remote:')
    ? settings.caseOpenTarget.slice('remote:'.length)
    : undefined
  const profile = settings.sshProfiles?.find((item) => item.id === profileId)
  return profile ? { kind: 'ssh', profile } : { kind: 'local' }
}

export function skillSourceUrls(name: string, revision: string): { page: string; raw: string } {
  const path = `resources/skills/${encodeURIComponent(name)}/SKILL.md`
  return {
    page: `https://github.com/jurisupport/legal-terminal/blob/${revision}/${path}`,
    raw: `https://raw.githubusercontent.com/jurisupport/legal-terminal/${revision}/${path}`
  }
}

export function skillInstallCommand(
  name: string,
  rawUrl: string,
  target: SkillInstallTarget,
  platform: NodeJS.Platform
): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error(`잘못된 스킬 이름: ${name}`)
  if (target.kind === 'local' && platform === 'win32') {
    return `$d = Join-Path $HOME '.claude\\skills\\${name}'; New-Item -ItemType Directory -Force -Path $d | Out-Null; Invoke-WebRequest -Uri '${rawUrl}' -OutFile (Join-Path $d 'SKILL.md')`
  }
  return `mkdir -p "$HOME/.claude/skills/${name}" && curl -fsSL '${rawUrl}' -o "$HOME/.claude/skills/${name}/SKILL.md"`
}

export function skillDismissKey(name: string, target: SkillInstallTarget): string {
  return target.kind === 'ssh' ? `ssh:${target.profile.id}:${name}` : `local:${name}`
}
