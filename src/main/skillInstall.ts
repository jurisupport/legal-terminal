import { app, clipboard, dialog, shell, type BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join, posix } from 'path'
import { readFile, readdir } from 'fs/promises'
import { getSettings, setSettings } from './settings'
import { testSshConnection } from './ssh'
import { makeRemote, rfsReadBytes } from './remoteFs'
import {
  resolveSkillInstallTarget,
  skillDismissKey,
  skillInstallCommand,
  skillSourceUrls,
  type SkillInstallTarget
} from './skillInstallGuide'

// 앱에 번들한 Claude Code 스킬(resources/skills/<이름>/SKILL.md)을
// 기본 사건 열기 환경의 사용자 스킬 폴더에 설치할지 시작 시 안내한다.
// 앱이 직접 설치하지 않고 GitHub 링크와 터미널에 붙여넣을 명령만 제공한다.

function bundledSkillsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), 'resources', 'skills')
}

function userSkillPath(name: string): string {
  return join(homedir(), '.claude', 'skills', name, 'SKILL.md')
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

interface SkillReview {
  content?: string
  error?: string
  label: string
  path: string
}

async function reviewSkill(target: SkillInstallTarget, name: string): Promise<SkillReview> {
  if (target.kind === 'local') {
    const path = userSkillPath(name)
    try {
      return { content: await readFile(path, 'utf8'), label: '로컬', path }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return code === 'ENOENT'
        ? { label: '로컬', path }
        : { error: String(error), label: '로컬', path }
    }
  }

  const { profile } = target
  const label = `SSH · ${profile.label} (${profile.user}@${profile.host})`
  const connection = await testSshConnection(profile)
  if (!connection.ok) {
    return { error: connection.error, label, path: `~/.claude/skills/${name}/SKILL.md` }
  }

  const path = posix.join(connection.cwd, '.claude', 'skills', name, 'SKILL.md')
  try {
    return {
      content: (await rfsReadBytes(makeRemote(profile.id, path))).toString('utf8'),
      label,
      path
    }
  } catch (error) {
    const message = String(error)
    return /no such file|not found|enoent/i.test(message)
      ? { label, path }
      : { error: message, label, path }
  }
}

async function promptOneSkill(win: BrowserWindow, name: string): Promise<void> {
  const bundled = await readFile(join(bundledSkillsDir(), name, 'SKILL.md'), 'utf8')
  const hash = contentHash(bundled)
  const settings = await getSettings()
  const target = resolveSkillInstallTarget(settings)
  const dismissKey = skillDismissKey(name, target)
  if (settings.dismissedSkillHash?.[dismissKey] === hash) return

  const review = await reviewSkill(target, name)
  if (review.content !== undefined && contentHash(review.content) === hash) return

  const isUpdate = review.content !== undefined
  const revision = app.isPackaged ? `v${app.getVersion()}` : 'main'
  const urls = skillSourceUrls(name, revision)
  const command = skillInstallCommand(name, urls.raw, target, process.platform)
  const result = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Claude 스킬 설치',
    message: isUpdate
      ? `"${name}" 스킬의 업데이트가 있습니다.`
      : `"${name}" 스킬 설치가 필요합니다.`,
    detail: [
      '소송문서(준비서면·소장 등) Markdown을 Claude가 작성할 때 한/글 표준 서식(HWPX)으로',
      '정확히 변환되는 형식 규칙을 알려주는 스킬입니다.',
      '',
      `확인 환경: ${review.label}`,
      `확인 위치: ${review.path}`,
      review.error ? `설치 상태 확인 실패: ${review.error}` : undefined,
      '',
      '아래 명령을 복사한 뒤 이 환경의 터미널에 직접 붙여넣으세요.',
      command
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n'),
    buttons: [
      'GitHub 열고 명령 복사',
      '명령만 복사',
      '나중에',
      '이 버전 다시 묻지 않기'
    ],
    defaultId: 0,
    cancelId: 2
  })

  if (result.response === 0 || result.response === 1) clipboard.writeText(command)
  if (result.response === 0) await shell.openExternal(urls.page)
  if (result.response === 3) {
    await setSettings({
      dismissedSkillHash: { ...(await getSettings()).dismissedSkillHash, [dismissKey]: hash }
    })
  }
}

export async function promptBundledSkillInstall(win: BrowserWindow): Promise<void> {
  try {
    const names = await readdir(bundledSkillsDir()).catch(() => [] as string[])
    for (const name of names) {
      if (name.startsWith('.')) continue
      if (win.isDestroyed()) return
      await promptOneSkill(win, name).catch((error) =>
        console.warn(`[skill] "${name}" 스킬 설치 확인 실패`, error)
      )
    }
  } catch (error) {
    console.warn('[skill] 번들 스킬 설치 확인 실패', error)
  }
}
