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

export function IconCaseTabs({ size = 22 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M4 5h7l2 2h7v11a2 2 0 0 1-2 2H4z" />
      <path d="M4 10h16" />
      <path d="M8 14h8" />
      <path d="M8 17h5" />
      <path d="M7 5V3h8v4" />
    </svg>
  )
}

export function IconTodos({ size = 22 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M5 5h14" />
      <path d="M5 12h14" />
      <path d="M5 19h14" />
      <path d="M4 5l1 1 2-3" />
      <path d="M4 12l1 1 2-3" />
      <path d="M4 19l1 1 2-3" />
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

export function IconParentFolder({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M4 18V6h16v12" />
      <path d="M8 10l4-4 4 4" />
      <path d="M12 6v10" />
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

export function IconHistory({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M4 12a8 8 0 1 0 2.3-5.7" />
      <path d="M4 4v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

export function IconSave({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M5 4h13l1 1v15H5z" />
      <path d="M8 4v6h8V4" />
      <path d="M8 20v-6h8v6" />
    </svg>
  )
}

export function IconSaveAs({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M4 4h11l4 4v6" />
      <path d="M4 4v16h9" />
      <path d="M15 4v5h5" />
      <path d="M8 14h5" />
      <path d="M15.5 19.5l4.5-4.5 1.5 1.5-4.5 4.5-2 .5z" />
    </svg>
  )
}

export function IconFork({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <circle cx="7" cy="6" r="2.4" />
      <circle cx="17" cy="6" r="2.4" />
      <circle cx="12" cy="18" r="2.4" />
      <path d="M7 8.4v1.6a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3V8.4" />
      <path d="M12 13v2.6" />
    </svg>
  )
}

export function IconWorktree({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <circle cx="9.5" cy="12" r="1.6" />
      <circle cx="15.5" cy="16" r="1.6" />
      <path d="M9.5 13.6c0 1.6 1.4 2.4 4.4 2.4" />
    </svg>
  )
}

export function IconTerminal({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M7 9l3.5 3L7 15" />
      <path d="M12.5 15.5H17" />
    </svg>
  )
}

export function IconSend({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M4 11.5L20 4l-4.5 16-3.6-6.4L4 11.5z" />
      <path d="M11.9 13.6L20 4" />
    </svg>
  )
}

export function IconStop({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.6" />
    </svg>
  )
}

export function IconMention({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="3.4" />
      <path d="M20.5 12a8.5 8.5 0 1 0-3.2 6.6" />
      <path d="M15.4 8.6V13a2.4 2.4 0 0 0 4.8 0V12" />
    </svg>
  )
}

export function IconAlignCenter({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M6 5h12" />
      <path d="M4 9h16" />
      <path d="M7 13h10" />
      <path d="M5 17h14" />
    </svg>
  )
}

export function IconAlignLeft({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M4 5h12" />
      <path d="M4 9h16" />
      <path d="M4 13h10" />
      <path d="M4 17h14" />
    </svg>
  )
}

export function IconAlignRight({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M8 5h12" />
      <path d="M4 9h16" />
      <path d="M10 13h10" />
      <path d="M6 17h14" />
    </svg>
  )
}
