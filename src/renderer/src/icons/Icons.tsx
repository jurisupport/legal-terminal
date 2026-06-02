// VS Code(codicon/feather) 스타일 단색 라인 아이콘. currentColor로 색상 제어.
interface IconProps {
  size?: number
}
const base = (size: number): React.SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
})

export function IconExplorer({ size = 22 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  )
}

export function IconCases({ size = 22 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M12 4v16" />
      <path d="M6 20h12" />
      <path d="M5 7l7-2 7 2" />
      <path d="M5 7l-2.2 4.5a2.6 2.6 0 0 0 4.4 0L5 7z" />
      <path d="M19 7l-2.2 4.5a2.6 2.6 0 0 0 4.4 0L19 7z" />
    </svg>
  )
}

export function IconViewer({ size = 22 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M7 3h7l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v4h4" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </svg>
  )
}

export function IconClaude({ size = 22 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
      <path d="M18.5 14.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9z" />
    </svg>
  )
}

export function IconSettings({ size = 22 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V15z" />
    </svg>
  )
}

export function IconNewFile({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v5h5" />
      <path d="M12 11v6" />
      <path d="M9 14h6" />
    </svg>
  )
}

export function IconNewFolder({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 10v6" />
      <path d="M9 13h6" />
    </svg>
  )
}

export function IconSync({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M20 7h-5a5 5 0 0 0-8.4-2.6L5 6" />
      <path d="M4 17h5a5 5 0 0 0 8.4 2.6L19 18" />
      <path d="M17 4l3 3-3 3" />
      <path d="M7 20l-3-3 3-3" />
    </svg>
  )
}

export function IconWorkspace({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M4 5h6l2 2h8v11a2 2 0 0 1-2 2H4z" />
      <path d="M4 10h16" />
      <path d="M16 13v4" />
      <path d="M14 15h4" />
    </svg>
  )
}

export function IconSearch({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="M15 15l5 5" />
    </svg>
  )
}
