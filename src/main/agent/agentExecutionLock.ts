/** Run on the execution host so separate SSH clients and its local app share a lock. */
export const AGENT_BUSY_MESSAGE = '다른 컴퓨터에서 이 AI 대화를 실행 중입니다. 작업이 끝난 뒤 다시 보내 주세요.'

export interface AgentExecutionIdentity {
  id: string
  provider: 'claude' | 'codex'
  resumeSessionId?: string
  freshSession?: boolean
}

// File descriptors are inherited by the CLI: a lost SSH connection or killed
// supervisor cannot release the lock while its CLI is still running. Never
// unlink lock files (including session aliases), which would split their inode.
export const AGENT_EXECUTION_WRAPPER = String.raw`
import fcntl, hashlib, json, os, signal, subprocess, sys, threading, uuid
identity = json.loads(sys.argv[1])
command = sys.argv[2:]
root = os.path.join(os.path.expanduser('~'), '.legal-terminal', 'agent-execution')
os.makedirs(root, mode=0o700, exist_ok=True)
busy = ${JSON.stringify(AGENT_BUSY_MESSAGE)}
def path(kind, value):
    key = identity['provider'] + ':' + kind + ':' + value
    return os.path.join(root, hashlib.sha256(key.encode()).hexdigest())
tab = path('tab', identity['id'])
fds = []
inodes = set()
child = None
thread_requests = set()
finished = False
stopping = False
def acquire(filename):
    fd = os.open(filename, os.O_RDWR | os.O_CREAT, 0o600)
    inode = os.fstat(fd).st_ino
    if inode in inodes:
        os.close(fd)
        return
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        raise RuntimeError(busy)
    fds.append(fd)
    inodes.add(inode)
def alias(session):
    target = path('session', session)
    try:
        os.link(primary, target)
    except FileExistsError:
        if os.stat(target).st_ino not in inodes:
            raise RuntimeError(busy)
def remember(session):
    alias(session)
    temporary = tab + '.' + str(os.getpid()) + '.json'
    with open(temporary, 'w') as output:
        json.dump(session, output)
    os.replace(temporary, tab + '.json')
def terminate(signum=None, frame=None):
    global stopping
    stopping = True
    if child is None or child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    def force():
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    timer = threading.Timer(5, force)
    timer.daemon = True
    timer.start()
try:
    resume = identity.get('resumeSessionId')
    if not resume:
        acquire(tab)
    if not resume and not identity.get('freshSession'):
        try:
            with open(tab + '.json') as saved:
                resume = json.load(saved)
            if not isinstance(resume, str) or not resume:
                raise ValueError('invalid saved session')
        except FileNotFoundError:
            pass
    primary = path('session', resume) if resume else path('pending', str(uuid.uuid4()))
    acquire(primary)
    if identity['provider'] == 'claude':
        if resume:
            if not identity.get('resumeSessionId'):
                command += ['--resume', resume]
        else:
            resume = str(uuid.uuid4())
            alias(resume)
            command += ['--session-id', resume]
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, terminate)
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        pass_fds=tuple(fds), start_new_session=True)
    if stopping:
        terminate()
    def input_lines():
        buffer = b''
        while True:
            chunk = os.read(0, 65536)
            if not chunk:
                if buffer:
                    yield buffer
                return
            buffer += chunk
            lines = buffer.split(b'\n')
            buffer = lines.pop()
            for line in lines:
                yield line + b'\n'
    def input_pump():
        try:
            for line in input_lines():
                if identity['provider'] == 'codex':
                    try:
                        message = json.loads(line)
                        if message.get('method') in ('thread/start', 'thread/resume'):
                            thread_requests.add(message.get('id'))
                        if message.get('method') == 'thread/start' and resume:
                            message['method'] = 'thread/resume'
                            message.setdefault('params', {})['threadId'] = resume
                            line = (json.dumps(message) + '\n').encode()
                    except (ValueError, TypeError, AttributeError):
                        pass
                while line:
                    line = line[os.write(child.stdin.fileno(), line):]
        except (BrokenPipeError, OSError):
            pass
        finally:
            try:
                child.stdin.close()
            except (BrokenPipeError, OSError):
                pass
            if identity['provider'] == 'codex' or not finished:
                terminate()
    threading.Thread(target=input_pump, daemon=True).start()
    for line in child.stdout:
        try:
            message = json.loads(line)
            if identity['provider'] == 'claude' and message.get('type') == 'result':
                finished = True
            session = None
            if identity['provider'] == 'claude' and message.get('type') == 'system' and message.get('subtype') == 'init':
                session = message.get('session_id')
            elif identity['provider'] == 'codex' and message.get('id') in thread_requests:
                thread_requests.discard(message.get('id'))
                result = message.get('result') or {}
                thread = result.get('thread') or {}
                session = thread.get('id')
            if isinstance(session, str) and session:
                remember(session)
        except (ValueError, TypeError, AttributeError):
            pass
        # Publish the real session identity only after its alias is locked.
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()
    code = child.wait()
    sys.exit(code if code >= 0 else 128 - code)
except BaseException as error:
    if not isinstance(error, SystemExit):
        print(str(error), file=sys.stderr, flush=True)
    terminate()
    if child is not None:
        child.wait()
    if isinstance(error, SystemExit):
        raise
    sys.exit(75 if str(error) == busy else 1)
finally:
    for fd in fds:
        os.close(fd)
`

export function agentExecutionArgs(identity: AgentExecutionIdentity): string[] {
  return ['-u', '-c', AGENT_EXECUTION_WRAPPER, JSON.stringify({
    id: identity.id, provider: identity.provider, resumeSessionId: identity.resumeSessionId,
    freshSession: identity.freshSession
  })]
}

export function agentExecutionCommand(identity: AgentExecutionIdentity): string {
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
  return `python3 ${agentExecutionArgs(identity).map(quote).join(' ')}`
}
