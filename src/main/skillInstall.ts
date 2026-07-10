import { app, dialog, type BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { getSettings, setSettings } from './settings'

// 앱에 번들한 Claude Code 스킬(resources/skills/<이름>/SKILL.md)을
// 사용자 스킬 폴더(~/.claude/skills)에 설치할지 시작 시 물어본다.
// 이미 같은 내용이 설치돼 있으면 조용히 넘어가고, 번들 내용이 바뀌면
// (앱 업데이트로 규칙이 갱신되면) 업데이트 여부를 다시 묻는다.

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

async function promptOneSkill(win: BrowserWindow, name: string): Promise<void> {
  const bundled = await readFile(join(bundledSkillsDir(), name, 'SKILL.md'), 'utf8')
  const hash = contentHash(bundled)
  const targetPath = userSkillPath(name)
  const installed = await readFile(targetPath, 'utf8').catch(() => undefined)
  if (installed !== undefined && contentHash(installed) === hash) return

  const settings = await getSettings()
  if (settings.dismissedSkillHash?.[name] === hash) return

  const isUpdate = installed !== undefined
  const result = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Claude 스킬 설치',
    message: isUpdate
      ? `"${name}" 스킬의 업데이트가 있습니다. 적용할까요?`
      : `"${name}" 스킬을 설치할까요?`,
    detail: [
      '소송문서(준비서면·소장 등) Markdown을 Claude가 작성할 때 한/글 표준 서식(HWPX)으로',
      '정확히 변환되는 형식 규칙을 알려주는 스킬입니다.',
      '',
      `설치 위치: ${targetPath}`,
      isUpdate ? '기존 스킬 파일을 새 내용으로 덮어씁니다.' : undefined
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n'),
    buttons: [isUpdate ? '업데이트' : '설치', '나중에', '이 버전 다시 묻지 않기'],
    defaultId: 0,
    cancelId: 1
  })

  if (result.response === 0) {
    await mkdir(join(homedir(), '.claude', 'skills', name), { recursive: true })
    await writeFile(targetPath, bundled, 'utf8')
  } else if (result.response === 2) {
    await setSettings({
      dismissedSkillHash: { ...(await getSettings()).dismissedSkillHash, [name]: hash }
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
