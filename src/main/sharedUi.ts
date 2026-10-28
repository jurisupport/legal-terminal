import { execFile, spawn } from 'child_process'
import { buildSshArgs, type SshProfileLike } from './sshOptions'
import { applySharedUiOperation, emptySharedUiState, isSharedUiOperation, isSharedUiState,
  type SharedUiOperation, type SharedUiResult, type SharedUiState } from '../shared/sharedUiState'

const sshBin = process.platform === 'win32' ? 'ssh.exe' : 'ssh'
const timeout = 12_000
const maxBytes = 16 * 1024 * 1024
const file = '"$HOME/.claude/legal-terminal-shared-ui.json"'
const lock = '"$HOME/.claude/legal-terminal-shared-ui.json.lock"'

function command(ssh: SshProfileLike, script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(sshBin, [...buildSshArgs(ssh, { usage: 'oneshot' }), script],
      { timeout, windowsHide: true, maxBuffer: maxBytes },
      (error, stdout) => error ? reject(error) : resolve(stdout))
  })
}

async function readState(ssh: SshProfileLike): Promise<SharedUiState> {
  const output = await command(ssh, `if [ -e ${file} ]; then cat ${file}; else printf '%s' '{"version":1,"revision":0,"selection":{"caseKey":null,"tab":null},"cases":{},"appliedOperationIds":[]}'; fi`)
  const value: unknown = JSON.parse(output)
  if (!isSharedUiState(value)) throw new Error('공유 화면 상태 파일 형식이 올바르지 않습니다.')
  return value
}

const transactionScript = [
  'umask 077', `file=${file}`, `lock=${lock}`, 'mkdir -p "$HOME/.claude" || exit 1', 'attempt=0',
  'until mkdir "$lock" 2>/dev/null; do', '  [ -d "$lock" ] || exit 1',
  '  attempt=$((attempt + 1))',
  '  [ "$attempt" -lt 80 ] || { echo "공유 상태 잠금을 얻지 못했습니다." >&2; exit 1; }',
  '  sleep 0.1', 'done', 'tmp="$file.$$.tmp"',
  'trap \'rm -f "$tmp"; rmdir "$lock" 2>/dev/null\' EXIT',
  'trap \'exit 1\' HUP INT TERM',
  'if [ -e "$file" ]; then',
  '  size=$(wc -c < "$file") || exit 1',
  `  [ "$size" -le ${maxBytes} ] || exit 1`,
  '  printf "%s\\n" "$size"; cat "$file" || exit 1',
  'else printf "%s\\n" -1; fi',
  'IFS= read -r header || exit 1',
  '[ "$header" = ABORT ] && exit 0',
  'case "$header" in "COMMIT "*) size=${header#COMMIT } ;; *) exit 1 ;; esac',
  'case "$size" in ""|*[!0-9]*) exit 1 ;; esac',
  ` [ "$size" -le ${maxBytes} ] || exit 1`,
  'head -c "$((size + 1))" > "$tmp" || exit 1',
  '[ "$(wc -c < "$tmp")" -eq "$size" ] || exit 1',
  'mv "$tmp" "$file"'
].join('\n')

function transact(ssh: SshProfileLike, operation: SharedUiOperation): Promise<SharedUiState> {
  return new Promise((resolve, reject) => {
    const proc = spawn(sshBin, [...buildSshArgs(ssh, { usage: 'oneshot' }), transactionScript], { windowsHide: true })
    let stderr = ''
    let received = Buffer.alloc(0)
    let expected: number | undefined
    let state: SharedUiState | undefined
    let failure: Error | undefined
    const abort = (error: unknown): void => {
      failure = error instanceof Error ? error : new Error(String(error))
      proc.stdin?.end('ABORT\n')
    }
    const timer = setTimeout(() => { failure = new Error('공유 화면 상태 저장 시간이 초과되었습니다.'); proc.kill() }, timeout)
    proc.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString('utf8') })
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (failure || state) return
      received = Buffer.concat([received, chunk])
      if (expected === undefined) {
        const newline = received.indexOf(10)
        if (newline < 0) {
          if (received.length > 32) abort(new Error('공유 화면 상태 응답 형식이 올바르지 않습니다.'))
          return
        }
        const length = received.subarray(0, newline).toString('ascii').trim()
        if (!/^(?:-1|[0-9]+)$/.test(length) || Number(length) > maxBytes) {
          abort(new Error('공유 화면 상태 응답 크기가 올바르지 않습니다.'))
          return
        }
        expected = Number(length)
        received = received.subarray(newline + 1)
      }
      if (received.length < Math.max(expected, 0)) return
      try {
        if (received.length !== Math.max(expected, 0)) throw new Error('공유 화면 상태 응답 형식이 올바르지 않습니다.')
        const value: unknown = expected === -1 ? emptySharedUiState() : JSON.parse(received.toString('utf8'))
        if (!isSharedUiState(value)) throw new Error('공유 화면 상태 파일 형식이 올바르지 않습니다.')
        state = value
        if (state.appliedOperationIds.includes(operation.id)) proc.stdin?.end('ABORT\n')
        else {
          const data = Buffer.from(JSON.stringify(applySharedUiOperation(state, operation)), 'utf8')
          if (data.length > maxBytes) throw new Error('공유 화면 상태 파일이 너무 큽니다.')
          proc.stdin?.end(Buffer.concat([Buffer.from(`COMMIT ${data.length}\n`), data]))
        }
      } catch (error) { abort(error) }
    })
    proc.stdin?.on('error', () => {})
    proc.on('error', (error) => { clearTimeout(timer); reject(error) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (failure) reject(failure)
      else if (code === 0 && state) resolve(state)
      else reject(new Error(stderr.trim() || `공유 화면 상태 저장 실패 (${code ?? 'unknown'})`))
    })
  })
}

export async function readSharedUi(ssh: SshProfileLike): Promise<SharedUiResult> {
  try {
    if (!ssh?.host || !ssh.user) throw new Error('SSH 연결이 필요합니다.')
    return { ok: true, state: await readState(ssh) }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

export async function applySharedUi(ssh: SshProfileLike, operation: SharedUiOperation): Promise<SharedUiResult> {
  try {
    if (!ssh?.host || !ssh.user) throw new Error('SSH 연결이 필요합니다.')
    if (!isSharedUiOperation(operation) || Buffer.byteLength(JSON.stringify(operation)) > 65536) {
      throw new Error('공유 화면 상태 요청 형식이 올바르지 않습니다.')
    }
    return { ok: true, state: await transact(ssh, operation) }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}
