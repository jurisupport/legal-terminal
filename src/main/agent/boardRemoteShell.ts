export function quoteBoardShellWord(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

// Capture login PATH/config/auth on the server. The login shell never sees SDK stdin,
// its banners never reach SDK stdout, and credentials stay in remote process memory.
const loginEnvironment = String.raw`import os, shlex, subprocess, sys
probe = r'printf "\000legal-terminal-env\000"; exec /usr/bin/env -0'
try:
    output = subprocess.run([os.environ.get("SHELL") or "/bin/sh", "-ilc",
        "exec /bin/sh -c " + shlex.quote(probe)], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=True).stdout
    _, marker, data = output.rpartition(b"\0legal-terminal-env\0")
    if not marker or not data.endswith(b"\0"):
        raise ValueError()
    env = dict(row.split(b"=", 1) for row in data[:-1].split(b"\0"))
    os.execve("/bin/sh", ["/bin/sh", "-c", sys.argv[1]], env)
except (OSError, subprocess.SubprocessError, ValueError):
    sys.exit(126)`

export function boardRemoteShell(script: string): string {
  const launcher = 'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin"; export PATH; ' +
    'command -v python3 >/dev/null || { echo "원격 보드 실행에 Python 3가 필요합니다." >&2; exit 126; }; ' +
    'exec python3 -c ' + quoteBoardShellWord(loginEnvironment) + ' ' + quoteBoardShellWord(script)
  return 'exec /bin/sh -c ' + quoteBoardShellWord(launcher)
}
