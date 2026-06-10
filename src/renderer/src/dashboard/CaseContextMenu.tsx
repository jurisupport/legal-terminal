import type { JsCase, SshProfile } from '../env'
import { caseWebUrl, nextHearing, partyNames } from './caseUtils'

export interface CaseContextMenuState {
  x: number
  y: number
  c: JsCase
}

type MenuItem = [string, (() => void) | null]

const openExt = (url: string): void => void window.lt.app.openExternal(url)
const copy = (s: string): void => void navigator.clipboard.writeText(s)

export default function CaseContextMenu({
  menu,
  onClose,
  onOpenWorkspace,
  onOpenRemote,
  sshProfiles = [],
  defaultOpenProfileId,
  onBrief,
  onDraft,
  onHearingRecord,
  onDetail
}: {
  menu: CaseContextMenuState
  onClose: () => void
  onOpenWorkspace: (c: JsCase) => void
  onOpenRemote?: (c: JsCase, profile: SshProfile) => void
  sshProfiles?: SshProfile[]
  defaultOpenProfileId?: string
  onBrief: (c: JsCase) => void
  onDraft: (c: JsCase) => void
  onHearingRecord?: (c: JsCase) => void
  onDetail?: (c: JsCase) => void
}): JSX.Element {
  const c = menu.c
  const items: MenuItem[] = [
    ...(onHearingRecord ? ([['📝 기일 기록 시작', () => onHearingRecord(c)]] as MenuItem[]) : []),
    ['✳ Claude에 브리핑 요청', () => onBrief(c)],
    ['✍ 준비서면 초안 (/brief-protocol)', () => onDraft(c)],
    ['📁 로컬에서 열기', () => onOpenWorkspace(c)],
    ...(onOpenRemote && sshProfiles.length
      ? ([
          ...sshProfiles.map((p) => [
            `🔗 ${p.label}${p.id === defaultOpenProfileId ? ' (기본)' : ''}에서 열기`,
            () => onOpenRemote(c, p)
          ])
        ] as MenuItem[])
      : []),
    ['—', null],
    ...(c.id ? ([['🌐 JuriSupport에서 보기', () => openExt(caseWebUrl(c.id))]] as MenuItem[]) : []),
    ...(onDetail ? ([['ℹ 상세 보기', () => onDetail(c)]] as MenuItem[]) : []),
    ['—', null],
    ['📋 사건번호 복사', () => copy(c.caseNumber ?? '')],
    [
      '👤 당사자 복사',
      () => {
        const cl = partyNames(c.parties, 'client')
        const op = partyNames(c.parties, 'opponent')
        copy([cl && `의뢰인: ${cl}`, op && `상대: ${op}`].filter(Boolean).join('\n'))
      }
    ],
    [
      '📅 다음 기일 복사',
      () => {
        const nh = nextHearing(c)
        copy(nh ? `${nh.when} ${nh.note}` : '')
      }
    ]
  ]

  return (
    <ul
      className="ctx-menu"
      style={{
        left: Math.min(menu.x, window.innerWidth - 220),
        top: Math.min(menu.y, window.innerHeight - 300)
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map(([label, act], i) =>
        act === null ? (
          <li key={i} className="ctx-sep" />
        ) : (
          <li
            key={i}
            className="ctx-item"
            onClick={() => {
              act()
              onClose()
            }}
          >
            {label}
          </li>
        )
      )}
    </ul>
  )
}
