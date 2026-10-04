import { useCallback, useEffect, useState } from 'react'
import type { SetupAction, SetupItem, SetupStatus } from '../env'
import { JS_TOKEN_UPDATED_EVENT } from '../dashboard/CasesDashboard'

// 시작하기 탭의 "준비 상태": Claude Code·플러그인·연결 키·선택 도구를 한 번에 보여 주고,
// 빠진 것은 설치기나 연결 명령을 복사해 이 컴퓨터의 터미널에 붙여넣게 안내한다.
// 앱이 직접 설치하지 않는 점은 번들 스킬 안내(skillInstall.ts)와 같다.

const STATE_ICON: Record<SetupItem['state'], string> = {
  ok: '✓',
  warn: '!',
  missing: '✕',
  off: '○'
}

function localTerminalName(): string {
  return navigator.userAgent.includes('Windows') ? 'PowerShell' : '터미널 앱'
}

export default function SetupChecklist(): JSX.Element | null {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      setStatus(await window.lt.js.setupStatus())
    } catch (error) {
      console.warn('[setup] 준비 상태 확인 실패', error)
    } finally {
      setChecking(false)
    }
  }, [])

  // 터미널에서 명령을 실행하고 돌아오면 다시 확인한다.
  useEffect(() => {
    void refresh()
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    window.addEventListener(JS_TOKEN_UPDATED_EVENT, onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(JS_TOKEN_UPDATED_EVENT, onFocus)
    }
  }, [refresh])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(null), 4000)
    return () => window.clearTimeout(timer)
  }, [copied])

  if (!status) return null

  const required = status.items.filter((item) => !item.optional)
  const readyCount = required.filter((item) => item.state === 'ok').length
  const open = expanded ?? !status.ready

  // 필수 항목 중 설치기로 해결되는 것이 있으면 맨 위에 설치 명령 하나만 크게 보여 준다.
  const installAction = required
    .flatMap((item) => (item.state === 'ok' ? [] : item.actions))
    .find((action) => action.kind === 'install')
  const installCommand = installAction?.command

  const runAction = async (action: SetupAction): Promise<void> => {
    if (action.url) {
      await window.lt.app.openExternal(action.url)
      return
    }
    if (!action.command) return
    try {
      await navigator.clipboard.writeText(action.command)
      setCopied(action.command)
    } catch (error) {
      console.warn('[setup] 명령 복사 실패', error)
    }
  }

  const rowActions = (item: SetupItem): SetupAction[] =>
    installAction ? item.actions.filter((action) => action.kind !== 'install') : item.actions

  return (
    <section className={`setup${status.ready ? ' setup-ready' : ''}`}>
      <div className="setup-head">
        <h2 className="recent-title">준비 상태</h2>
        <span className="setup-summary">
          {status.ready ? '✓ 바로 쓸 수 있습니다' : `필수 ${required.length}개 중 ${readyCount}개 준비됨`}
        </span>
        <button className="setup-link" type="button" disabled={checking} onClick={() => void refresh()}>
          {checking ? '확인 중…' : '다시 확인'}
        </button>
        <button className="setup-link" type="button" onClick={() => setExpanded(!open)}>
          {open ? '접기' : '자세히'}
        </button>
      </div>

      {open && installAction && installCommand && (
        <div className="setup-install">
          <p>
            설치기 한 번으로 Claude Code, JuriSupport 플러그인, 연결 키 등록까지 이어서 진행합니다.
            명령을 복사해 이 컴퓨터의 {localTerminalName()}에 붙여넣고 Enter를 누르세요.
          </p>
          <code className="setup-command">{installCommand}</code>
          <button
            className="setup-primary"
            type="button"
            onClick={() => void runAction(installAction)}
          >
            {copied === installCommand ? '복사했습니다' : '설치 명령 복사'}
          </button>
        </div>
      )}

      {open && (
        <ul className="setup-list">
          {status.items.map((item) => (
            <li key={item.id} className={`setup-item setup-${item.state}`}>
              <span className="setup-icon" aria-hidden>
                {STATE_ICON[item.state]}
              </span>
              <div className="setup-body">
                <div className="setup-label">
                  {item.label}
                  {item.optional && <span className="recent-tag">선택</span>}
                </div>
                <div className="setup-detail">{item.detail}</div>
                {rowActions(item).length > 0 && (
                  <div className="setup-actions">
                    {rowActions(item).map((action) => (
                      <button
                        key={action.label}
                        className="recent-more"
                        type="button"
                        title={action.command ?? action.url}
                        onClick={() => void runAction(action)}
                      >
                        {action.command && copied === action.command ? '복사했습니다' : action.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {open && copied && (
        <p className="setup-hint">
          복사했습니다. 이 컴퓨터의 {localTerminalName()}에 붙여넣고 Enter를 누른 뒤, 끝나면 이 화면으로
          돌아오세요. 상태가 자동으로 다시 확인됩니다.
        </p>
      )}
    </section>
  )
}
