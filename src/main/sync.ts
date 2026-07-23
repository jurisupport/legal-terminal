import { spawn, execFile } from 'child_process'
import type { WebContents } from 'electron'
import type { SshProfile } from './settings'

// 클라우드 경유 모델: 맥미니에서(SSH로) rclone을 실행해 맥 사건폴더 ↔ OneDrive 클라우드 동기화.
// Windows에는 rclone 불필요. 맥에 rclone + onedrive 리모트(rclone config)가 있어야 한다.
const sshBin = process.platform === 'win32' ? 'ssh.exe' : 'ssh'

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

function shellPathArg(path: string): string {
  const target = path.trim()
  if (!target || target === '~' || target === '$HOME') return '"$HOME"'
  if (target.startsWith('~/')) return `"$HOME"/${shq(target.slice(2))}`
  if (target.startsWith('$HOME/')) return `"$HOME"/${shq(target.slice(6))}`
  return shq(target)
}

function remoteRcloneBootstrap(): string {
  return [
    'PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"',
    'rclone_bin=$(command -v rclone 2>/dev/null || true)',
    'if [ -z "$rclone_bin" ]; then',
    '  for p in /opt/homebrew/bin/rclone /usr/local/bin/rclone /opt/local/bin/rclone; do',
    '    [ -x "$p" ] && rclone_bin="$p" && break',
    '  done',
    'fi',
    'if [ -z "$rclone_bin" ]; then',
    '  echo "rclone not found. Install it on the remote Mac: brew install rclone" >&2',
    '  exit 127',
    'fi'
  ].join('\n')
}

function remoteRclonePrefix(): string {
  return `${remoteRcloneBootstrap()}\n"$rclone_bin"`
}

// BatchMode(키/agent 인증) ssh 인자 — 비대화식 원격 명령 실행용
function sshBaseArgs(profile: SshProfile): string[] {
  const a: string[] = []
  if (profile.port) a.push('-p', String(profile.port))
  if (profile.identityFile) a.push('-i', profile.identityFile)
  a.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-o', 'StrictHostKeyChecking=accept-new')
  a.push(`${profile.user}@${profile.host}`)
  return a
}

// 맥의 rclone 설치 여부 + 설정된 리모트 목록(rclone listremotes). 키/agent 인증 시에만 성공.
// SSH 비대화식 명령은 Homebrew PATH를 못 읽는 경우가 있어 흔한 설치 경로를 명시적으로 찾는다.
export function remoteRcloneInfo(
  profile: SshProfile
): Promise<{ installed: boolean; remotes: string[]; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      sshBin,
      [...sshBaseArgs(profile), `${remoteRclonePrefix()} listremotes`],
      { timeout: 15000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ installed: false, remotes: [], error: (stderr || err.message || '').trim() })
          return
        }
        const remotes = stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean) // 예: "onedrive:"
        resolve({ installed: true, remotes })
      }
    )
  })
}

export interface RemoteSyncOpts {
  profile: SshProfile
  direction: 'pull' | 'push' | 'bi' // pull: 클라우드→맥, push: 맥→클라우드, bi: 양방향(bisync)
  mode?: 'full' | 'folders' | 'file' // folders: 폴더 구조만 생성, file: 단일 파일만 복사
  macFolder: string // 맥의 사건 폴더 (예: /Users/me/OneDrive/진행중사건/강상우)
  dest: string // rclone 클라우드 대상 (예: onedrive:진행중사건/강상우)
  dryRun?: boolean // 실제 복사 없이 변경될 파일 목록만 수집
  resync?: boolean // bisync 최초 실행 — 양쪽을 합쳐 기준 상태(listing)를 만든다
}

export interface RemoteSyncChange {
  path: string
  action: string // rclone dry-run 동작명 (copy, delete, ...)
}

export function cloudPathForms(dest: string): { root: string; segments: string[][] } {
  const colon = dest.indexOf(':')
  return {
    root: colon >= 0 ? dest.slice(0, colon + 1) : '',
    segments: (colon >= 0 ? dest.slice(colon + 1) : dest)
      .replace(/^\/+/, '')
      .split('/')
      .filter(Boolean)
      .map((segment) => [...new Set([segment, segment.normalize('NFC'), segment.normalize('NFD')])])
  }
}

// rclone 공통 플래그 — 재시도는 rclone 기본값(3/10) 수준으로 유지해 OneDrive API 순단을 흡수
const RCLONE_COMMON_FLAGS =
  '--transfers=4 --checkers=8 --retries=3 --low-level-retries=10 -v --stats-one-line --stats=1s'

// dry-run 출력에서 변경 예정 파일을 추출. 시간 갱신(update modification time)류는 제외.
const DRY_RUN_LINE = /NOTICE:\s+(.+?):\s+Skipped\s+(copy|update(?!\s+modification)|delete|remove directory|make directory)/
const DRY_RUN_MAX_CHANGES = 500

let active: ReturnType<typeof spawn> | null = null

// 맥에서 rclone 동기화 실행. 진행 로그를 'sync:progress'로 스트리밍.
// pull/push는 copy --update(삭제 전파 안 함), bi는 bisync(삭제 전파 포함, 충돌 보존).
export function runRemoteSync(
  opts: RemoteSyncOpts,
  wc: WebContents
): Promise<{ ok: boolean; code: number | null; error?: string; changes?: RemoteSyncChange[] }> {
  const mode = opts.mode ?? 'full'
  const cloudDest = opts.dest
  const cloudArg = shq(cloudDest)
  const macArg = shellPathArg(opts.macFolder)
  const { root: cloudRoot, segments: cloudSegments } = cloudPathForms(cloudDest)
  const rootVaultFilter =
    cloudSegments.length === 0
      ? ` --exclude ${shq('/개인 중요 보관소/**')} --exclude ${shq('/Personal Vault/**')}`
      : ''
  const commonFlags = `${RCLONE_COMMON_FLAGS}${rootVaultFilter}`
  const resolveCloudSource =
    opts.direction === 'pull'
      ? [
          `cloud=${shq(cloudRoot)}`,
          'join_cloud() { case "$1" in *:|*/) printf "%s%s\\n" "$1" "$2" ;; *) printf "%s/%s\\n" "$1" "$2" ;; esac; }',
          ...(cloudSegments.length
            ? [
                'resolve_tmp="${TMPDIR:-/tmp}/legal-terminal-rclone-resolve.$$"',
                'trap \'rm -f "$resolve_tmp"\' EXIT HUP INT TERM'
              ]
            : []),
          ...cloudSegments.flatMap((forms) => [
            'if ! "$rclone_bin" lsf "$cloud" --max-depth 1 --format p > "$resolve_tmp"; then',
            '  echo "클라우드 상위 경로를 읽지 못했습니다: $cloud" >&2',
            '  exit 1',
            'fi',
            'next=',
            'while IFS= read -r entry; do',
            '  entry=${entry%/}',
            '  case "$entry" in',
            `    ${forms.map(shq).join('|')}) next=$(join_cloud "$cloud" "$entry"); break ;;`,
            '  esac',
            'done < "$resolve_tmp"',
            'if [ -z "$next" ]; then',
            `  echo ${shq(`클라우드 경로를 찾을 수 없습니다: ${cloudDest}`)} >&2`,
            `  echo ${shq('클라우드 경로 입력을 확인하거나, 먼저 올리기(맥 → 클라우드)로 폴더를 만드세요.')} >&2`,
            '  exit 66',
            'fi',
            'cloud=$next'
          ]),
          ...(cloudSegments.length ? ['rm -f "$resolve_tmp"'] : [])
        ].join('\n')
      : ''
  const src = opts.direction === 'pull' ? '"$cloud"' : macArg
  const dst = opts.direction === 'pull' ? macArg : cloudArg
  const dryRunFlag = opts.dryRun ? ' --dry-run' : ''
  const ensureFolderDestination =
    opts.direction === 'pull' ? 'mkdir -p "$dst" || exit 1' : '"$rclone_bin" mkdir "$dst" || exit 1'
  const rcloneCmd =
    opts.direction === 'bi'
      ? [
          remoteRcloneBootstrap(),
          `mac=${macArg}`,
          `cloud=${cloudArg}`,
          'mkdir -p "$mac" || exit 1',
          '"$rclone_bin" mkdir "$cloud" || exit 1',
          // bisync: 양방향 전파(삭제 포함), 충돌 시 최신 파일 승리 + 진 쪽은 .conflict로 보존.
          // --resilient/--recover: 중단된 이전 실행에서 자동 복구. 최초 1회는 --resync 필요.
          `"$rclone_bin" bisync "$mac" "$cloud" --create-empty-src-dirs --conflict-resolve newer ` +
            `--resilient --recover ${commonFlags}${opts.resync ? ' --resync' : ''}${dryRunFlag}`
        ].join('\n')
      : mode === 'folders'
      ? [
          remoteRcloneBootstrap(),
          resolveCloudSource,
          `src=${src}`,
          `dst=${dst}`,
          ensureFolderDestination,
          'tmp="${TMPDIR:-/tmp}/legal-terminal-rclone-dirs.$$"',
          'trap \'rm -f "$tmp"\' EXIT HUP INT TERM',
          'echo "폴더 목록을 읽는 중..."',
          `if ! "$rclone_bin" lsf "$src" --dirs-only --recursive --format p${rootVaultFilter} > "$tmp"; then`,
          '  echo "폴더 목록을 읽지 못했습니다: $src" >&2',
          '  exit 1',
          'fi',
          'join_path() {',
          '  case "$1" in',
          '    *:|*/) printf "%s%s\\n" "$1" "$2" ;;',
          '    *) printf "%s/%s\\n" "$1" "$2" ;;',
          '  esac',
          '}',
          'while IFS= read -r rel; do',
          '  [ -z "$rel" ] && continue',
          '  target=$(join_path "$dst" "$rel")',
          opts.direction === 'pull'
            ? '  mkdir -p "$target" || exit 1'
            : '  "$rclone_bin" mkdir "$target" || exit 1',
          '  echo "폴더 생성: $rel"',
          'done < "$tmp"'
        ].join('\n')
      : mode === 'file'
        ? [
            remoteRcloneBootstrap(),
            resolveCloudSource,
            `src=${src}`,
            `dst=${dst}`,
            'remote_parent() {',
            '  case "$1" in',
            '    *:*) prefix="${1%%:*}:"; rest="${1#*:}" ;;',
            '    *) dirname "$1"; return ;;',
            '  esac',
            '  case "$rest" in',
            '    */*) printf "%s%s\\n" "$prefix" "${rest%/*}" ;;',
            '    *) printf "%s\\n" "$prefix" ;;',
            '  esac',
            '}',
            opts.direction === 'pull' && !opts.dryRun ? 'mkdir -p "$(dirname "$dst")" || exit 1' : '',
            opts.direction === 'push' && !opts.dryRun
              ? 'dst_dir=$(remote_parent "$dst"); "$rclone_bin" mkdir "$dst_dir" || exit 1'
              : '',
            'echo "파일 1개를 동기화하는 중..."',
            `"$rclone_bin" copyto "$src" "$dst" --update ${commonFlags}${dryRunFlag}`
          ]
            .filter(Boolean)
            .join('\n')
      : `${remoteRcloneBootstrap()}\n${resolveCloudSource}\n` +
        `"$rclone_bin" copy ${src} ${dst} --update --create-empty-src-dirs ${commonFlags}${dryRunFlag}`
  const args = [...sshBaseArgs(opts.profile), rcloneCmd]

  const send = (line: string): void => {
    if (!wc.isDestroyed()) wc.send('sync:progress', line)
  }
  send(
    `$ (맥미니에서) rclone ${mode === 'folders' ? '폴더명만 ' : mode === 'file' ? '파일 1개 ' : ''}${
      opts.direction === 'pull' ? '내리기 ⬇' : opts.direction === 'push' ? '올리기 ⬆' : '양방향 ⇅'
    }${opts.resync ? ' (기준 상태 생성)' : ''}${opts.dryRun ? ' (미리보기)' : ''}`
  )
  if (opts.direction === 'bi') {
    send(`  ${opts.macFolder} ⇄ ${cloudDest}`)
  } else {
    send(`  ${opts.direction === 'pull' ? cloudDest : opts.macFolder}`)
    send(`  → ${opts.direction === 'pull' ? opts.macFolder : cloudDest}`)
  }

  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(sshBin, args, { windowsHide: true })
    } catch (e) {
      resolve({ ok: false, code: null, error: String(e) })
      return
    }
    active = proc
    let tail = ''
    const changes: RemoteSyncChange[] = []
    let pending = ''
    const onData = (buf: Buffer): void => {
      const text = buf.toString()
      tail = (tail + text).slice(-2000)
      for (const line of text.split(/\r?\n/)) if (line.trim()) send(line)
      if (!opts.dryRun) return
      // 스트림 청크 경계에서 줄이 잘리지 않도록 버퍼링 후 완성된 줄만 파싱
      pending += text
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const m = DRY_RUN_LINE.exec(line)
        if (m && changes.length < DRY_RUN_MAX_CHANGES) changes.push({ path: m[1], action: m[2] })
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (e) => {
      active = null
      resolve({ ok: false, code: null, error: String(e) })
    })
    proc.on('close', (code) => {
      active = null
      send(code === 0 ? (opts.dryRun ? '✓ 미리보기 완료' : '✓ 완료') : `✗ 종료 코드 ${code}`)
      resolve({
        ok: code === 0,
        code,
        error: code === 0 ? undefined : tail,
        changes: opts.dryRun ? changes : undefined
      })
    })
  })
}

export function cancelSync(): void {
  if (active) {
    active.kill()
    active = null
  }
}
