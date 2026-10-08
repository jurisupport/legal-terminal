import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { AgentExecutionIdentity } from './agentExecutionLock'

const CLIENT_HEARTBEAT_INTERVAL_MS = 5_000

export interface RemoteAgentRunInfo {
  runId: string
  provider: 'claude' | 'codex'
  sessionId?: string
  running: boolean
  metadata: Record<string, unknown>
  pendingRequestIds: Array<string | number>
  lastRequestId: number
  attached: boolean
  startedAt: number
  hasTurnInput: boolean
  interrupted?: boolean
}

export interface RemoteAgentOptions {
  sshBin: string
  sshArgs: string[]
  env?: NodeJS.ProcessEnv
  identity: AgentExecutionIdentity
  command?: string
  runId?: string
  metadata?: Record<string, unknown>
}

// SSH only tails the private journal and forwards acknowledged operations. The
// detached broker owns all three CLI pipes; disconnecting never sends CLI EOF.
export const REMOTE_AGENT_BROKER = String.raw`
import base64, fcntl, hashlib, json, os, re, shutil, signal, socket, subprocess, sys, tempfile, threading, time, queue
CLIENT_HEARTBEAT_TIMEOUT = 30
CLIENT_STOP_GRACE = 6
os.umask(0o077)
root = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == 'broker' else os.path.join(os.path.expanduser('~'), '.legal-terminal', 'agent-runs')
def save(path, value):
    temporary = path + '.' + str(threading.get_ident()) + '.tmp'
    with open(temporary, 'w') as output:
        json.dump(value, output)
    os.replace(temporary, path)
def read(path):
    try:
        with open(path) as source: return json.load(source)
    except FileNotFoundError: return None
def reference(identity, kind, value):
    key = identity['provider'] + ':' + kind + ':' + value
    return os.path.join(root, hashlib.sha256(key.encode()).hexdigest() + '.json')
def runpath(run):
    if not isinstance(run, str) or not re.fullmatch(r'[a-zA-Z0-9-]{1,80}', run):
        raise ValueError('Invalid remote run identity')
    return os.path.join(root, run)
def run_state(directory):
    state = read(os.path.join(directory, 'state.json'))
    if not state: return None
    alive = False
    try:
        with open(os.path.join(directory, 'live.lock'), 'rb') as handle:
            try: fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: alive = True
    except FileNotFoundError: pass
    state['brokerAlive'] = alive
    if state['running'] and not alive:
        state.update(running=False, interrupted=True, exitCode=1)
    if not state['running']: state['pendingRequestIds'] = []
    return state
def latest(request):
    identity = request['identity']
    if request.get('runId'): return request['runId']
    if identity.get('resumeSessionId'):
        return read(reference(identity, 'session', identity['resumeSessionId']))
    return read(reference(identity, 'tab', identity['id']))
def request_id(message, provider):
    if provider == 'claude' and message.get('type') == 'control_request': return message.get('request_id')
    if provider == 'codex' and 'method' in message and 'id' in message: return message['id']
def output(value):
    with output_lock:
        print(json.dumps(value, separators=(',', ':')), flush=True)
output_lock = threading.Lock()

def broker(request):
    identity = request['identity']
    directory = runpath(request['runId'])
    lease = open(os.path.join(directory, 'live.lock'), 'a')
    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    state = {'runId': request['runId'], 'provider': identity['provider'], 'running': True,
        'metadata': request.get('metadata') or {}, 'pendingRequestIds': [], 'lastRequestId': 0, 'hasTurnInput': False,
        'sessionId': identity.get('resumeSessionId'), 'pid': os.getpid(), 'startedAt': int(time.time() * 1000)}
    # Keep the Unix socket path below macOS's 104-byte limit, even for long homes.
    socket_directory = tempfile.mkdtemp(prefix='legal-agent-', dir='/tmp')
    state['socket'] = os.path.join(socket_directory, 'control')
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(state['socket'])
    listener.listen(8)
    lock = threading.RLock()
    input_lock = threading.Lock()
    journal = open(os.path.join(directory, 'events'), 'ab', buffering=0)
    seen = set()
    resolved_requests = set()
    thread_requests = set()
    config_requests = set()
    secrets = set()
    input_buffer = b''
    child = None
    client_required = state['metadata'].get('clientRequired') is True
    last_client_at = time.monotonic()
    def record(value):
        with lock: journal.write((json.dumps(value, separators=(',', ':')) + '\n').encode())
    def persist(): save(os.path.join(directory, 'state.json'), state)
    def remember(session):
        if not isinstance(session, str) or not session: return
        state['sessionId'] = session
        save(reference(identity, 'session', session), request['runId'])
        persist()
    def stop():
        if child is None or (not client_required and child.poll() is not None): return
        try: os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError: return
        def force():
            if client_required or child.poll() is None:
                try: os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError: pass
        timer = threading.Timer(CLIENT_STOP_GRACE, force)
        timer.daemon = not client_required
        timer.start()
    def redact(data):
        for secret in secrets: data = data.replace(secret.encode(), b'[redacted]')
        return data
    def find_secrets(value, key=''):
        if isinstance(value, dict):
            for k, v in value.items(): find_secrets(v, k)
        elif isinstance(value, list):
            for v in value: find_secrets(v)
        elif isinstance(value, str):
            if value.startswith('Bearer '): secrets.add(value[7:])
            elif any(part in key.lower() for part in ('token', 'secret', 'api_key', 'apikey', 'authorization')) and len(value) >= 12:
                secrets.add(value)
    def consume_input(data):
        nonlocal input_buffer
        has_turn = False
        accepted = []
        resolved_ids = []
        input_buffer += data
        lines = input_buffer.split(b'\n')
        input_buffer = lines.pop()
        for line in lines:
            try:
                message = json.loads(line)
                if not isinstance(message, dict):
                    accepted.append(line + b'\n')
                    continue
                find_secrets(message)
                mid = message.get('id')
                if isinstance(mid, int): state['lastRequestId'] = max(state['lastRequestId'], mid)
                if message.get('method') in ('thread/start', 'thread/resume'): thread_requests.add(mid)
                if message.get('method') == 'config/read': config_requests.add(mid)
                if message.get('type') == 'user' or message.get('method') in ('turn/start', 'review/start', 'thread/compact/start'): has_turn = True
                response = message.get('response') or {}
                resolved = None
                if identity['provider'] == 'claude' and message.get('type') == 'control_response' and isinstance(response, dict):
                    resolved = response.get('request_id')
                elif identity['provider'] == 'codex' and 'method' not in message and ('result' in message or 'error' in message):
                    resolved = mid
                if isinstance(resolved, (str, int)):
                    if resolved in resolved_requests or resolved in resolved_ids: continue
                    if resolved in state['pendingRequestIds']: resolved_ids.append(resolved)
            except (ValueError, TypeError):
                # Managed Codex reads one bearer token before its JSON protocol.
                if len(line) >= 16 and b' ' not in line: secrets.add(line.decode(errors='replace'))
            accepted.append(line + b'\n')
        persist()
        return b''.join(accepted), has_turn, resolved_ids
    def operate(operation):
        nonlocal last_client_at
        if operation.get('type') == 'heartbeat':
            if client_required:
                with lock: last_client_at = time.monotonic()
            return
        if operation.get('type') == 'stop':
            with lock:
                if operation['id'] in seen: return
                seen.add(operation['id'])
            stop()
            return
        with input_lock:
            oid = operation['id']
            if oid in seen: return
            kind = operation['type']
            if kind == 'input':
                data = base64.b64decode(operation['data'])
                if child.poll() is not None: raise RuntimeError('Remote process has finished')
                # Writes and acknowledgements are serialized: retries cannot run a prompt twice.
                with lock: data, has_turn, resolved_ids = consume_input(data)
                # Draining stdout must remain possible while a large input blocks on the pipe.
                child.stdin.write(data)
                child.stdin.flush()
                with lock:
                    if has_turn: state['hasTurnInput'] = True
                    for rid in resolved_ids:
                        resolved_requests.add(rid)
                        if rid in state['pendingRequestIds']: state['pendingRequestIds'].remove(rid)
                    persist()
            elif kind == 'end':
                if not child.stdin.closed:
                    if input_buffer: child.stdin.write(input_buffer)
                    child.stdin.close()
            else: raise ValueError('Unknown remote operation')
            seen.add(oid)
    def serve_connection(connection):
        try:
            connection.settimeout(30)
            with connection.makefile('rb') as stream:
                operation = json.loads(stream.readline())
            operate(operation)
            connection.sendall(b'{"ok":true}\n')
        except Exception as error:
            try: connection.sendall((json.dumps({'error': str(error)}) + '\n').encode())
            except OSError: pass
        finally: connection.close()
    def serve():
        while state['running']:
            try: connection, _ = listener.accept()
            except OSError: return
            # Heartbeats must not wait for a provider that has stopped reading stdin.
            threading.Thread(target=serve_connection, args=(connection,), daemon=True).start()
    def watch_client():
        while state['running']:
            time.sleep(min(1, CLIENT_HEARTBEAT_TIMEOUT / 3))
            with lock:
                if time.monotonic() - last_client_at < CLIENT_HEARTBEAT_TIMEOUT: continue
                state['interrupted'] = True
                persist()
            stop()
            return
    def pump(stream, kind):
        while True:
            line = stream.readline()
            if not line: return
            with lock:
                record_value = {'type': kind, 'data': base64.b64encode(redact(line)).decode()}
                if kind == 'stdout':
                    try:
                        message = json.loads(line)
                        if isinstance(message, dict):
                            if message.get('id') in config_requests:
                                config_requests.discard(message.get('id'))
                                servers = ((message.get('result') or {}).get('config') or {}).get('mcp_servers') or {}
                                if 'result' in message:
                                    message = {'id': message['id'], 'result': {'config': {'mcp_servers': {name: {} for name in servers}}}}
                                    record_value['data'] = base64.b64encode((json.dumps(message) + '\n').encode()).decode()
                            rid = request_id(message, identity['provider'])
                            if isinstance(rid, (str, int)):
                                if rid not in state['pendingRequestIds']: state['pendingRequestIds'].append(rid)
                                record_value['requestId'] = rid
                            if identity['provider'] == 'claude' and message.get('type') == 'system' and message.get('subtype') == 'init':
                                remember(message.get('session_id'))
                            elif identity['provider'] == 'codex' and message.get('id') in thread_requests:
                                thread_requests.discard(message.get('id'))
                                result = message.get('result') or {}
                                remember((result.get('thread') or {}).get('id'))
                            persist()
                    except (ValueError, TypeError, AttributeError): pass
                record(record_value)
    try:
        child = subprocess.Popen(['/bin/sh', '-c', request['command']], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        for sig in (signal.SIGTERM, signal.SIGINT): signal.signal(sig, lambda *_: stop())
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        save(reference(identity, 'tab', identity['id']), request['runId'])
        if identity.get('resumeSessionId'): save(reference(identity, 'session', identity['resumeSessionId']), request['runId'])
        persist()
        threading.Thread(target=serve, daemon=True).start()
        if client_required: threading.Thread(target=watch_client, daemon=True).start()
        pumps = [threading.Thread(target=pump, args=(child.stdout, 'stdout')),
                 threading.Thread(target=pump, args=(child.stderr, 'stderr'))]
        for thread in pumps: thread.start()
        code = child.wait()
        for thread in pumps: thread.join()
        with lock:
            state['running'] = False
            state['exitCode'] = code if code >= 0 else 128 - code
            persist()
            record({'type': 'exit', 'code': state['exitCode']})
    except BaseException as error:
        stop()
        if child is not None: child.wait()
        with lock:
            record({'type': 'stderr', 'data': base64.b64encode((str(error) + '\n').encode()).decode()})
            state['running'] = False
            state['exitCode'] = 1
            persist()
            record({'type': 'exit', 'code': 1})
    finally:
        listener.close()
        journal.close()
        lease.close()
        shutil.rmtree(socket_directory, ignore_errors=True)

def client(request):
    if request.get('probe'):
        run = latest(request)
        state = run_state(runpath(run)) if run else None
        output({'type': 'probe', 'info': dict(state, attached=True) if state else None})
        return
    os.makedirs(root, mode=0o700, exist_ok=True)
    os.chmod(root, 0o700)
    attached = True
    with open(os.path.join(root, 'index.lock'), 'a') as index:
        fcntl.flock(index, fcntl.LOCK_EX)
        run = latest(request)
        own = request.get('newRunId')
        if own and read(os.path.join(runpath(own), 'state.json')): run = own
        directory = runpath(run) if run else None
        state = run_state(directory) if directory else None
        if run and not state and os.path.isdir(directory):
            raise RuntimeError('원격 작업이 시작 중입니다. 잠시 뒤 다시 연결해 주세요.')
        if request.get('command') and not request.get('runId') and state and state['running'] and run != request['newRunId']:
            raise RuntimeError('다른 컴퓨터에서 이 AI 대화를 실행 중입니다. 작업이 끝난 뒤 다시 보내 주세요.')
        if request.get('command') and not request.get('runId') and run != request['newRunId']:
            attached = False
            run = request['newRunId']
            directory = runpath(run)
            # Never relaunch after losing SSH during worker creation: the first broker may still be starting.
            try: os.makedirs(directory, mode=0o700)
            except FileExistsError:
                raise RuntimeError('원격 작업이 시작 중입니다. 잠시 뒤 다시 연결해 주세요.')
            request['runId'] = run
            identity = request['identity']
            save(reference(identity, 'tab', identity['id']), run)
            if identity.get('resumeSessionId'): save(reference(identity, 'session', identity['resumeSessionId']), run)
            with open(os.path.join(directory, 'broker.log'), 'ab') as errors:
                daemon = subprocess.Popen([sys.executable, '-u', '-c', request['source'], 'broker', root],
                    stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errors, start_new_session=True,
                    close_fds=True)
            daemon.stdin.write((json.dumps(request) + '\n').encode())
            daemon.stdin.close()
            for _ in range(200):
                state = read(os.path.join(directory, 'state.json'))
                if state: break
                if daemon.poll() is not None: raise RuntimeError('Remote worker failed to start')
                time.sleep(0.05)
            if not state: raise RuntimeError('Remote worker did not become ready')
            identity = request['identity']
            save(reference(identity, 'tab', identity['id']), run)
            if identity.get('resumeSessionId'): save(reference(identity, 'session', identity['resumeSessionId']), run)
        if not state: raise RuntimeError('Remote run was not found')
    event_path = os.path.join(directory, 'events')
    replay_end = os.path.getsize(event_path)
    state = run_state(directory)
    output({'type': 'ready', 'info': dict(state, attached=attached), 'replayEnd': replay_end})
    disconnected = threading.Event()
    operations = queue.Queue()
    def forward_operation(operation):
        channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            channel.connect(state['socket'])
            channel.sendall((json.dumps(operation) + '\n').encode())
            with channel.makefile('rb') as response: result = json.loads(response.readline())
            if result.get('error'): output({'type': 'operation-error', 'id': operation['id'], 'message': result['error']})
            else: output({'type': 'ack', 'id': operation['id']})
        except OSError:
            # The final exit record owns shutdown; do not mistake it for an SSH failure.
            current = run_state(directory)
            if current and not current['running']: return
            raise
        finally: channel.close()
    def forward_operations():
        try:
            while True:
                operation = operations.get()
                if operation is None: return
                forward_operation(operation)
        except Exception: pass
        finally: disconnected.set()
    def forward():
        try:
            for line in sys.stdin.buffer:
                operation = json.loads(line)
                if operation.get('type') in ('heartbeat', 'stop'): forward_operation(operation)
                else: operations.put(operation)
        except Exception: disconnected.set()
        finally: operations.put(None)
    threading.Thread(target=forward_operations, daemon=True).start()
    threading.Thread(target=forward, daemon=True).start()
    replayed = False
    with open(event_path, 'rb') as journal:
        journal.seek(request.get('cursor', 0))
        while not disconnected.is_set():
            offset = journal.tell()
            line = journal.readline()
            incomplete = bool(line) and not line.endswith(b'\n')
            if incomplete:
                journal.seek(offset)
                line = b''
            if line:
                value = json.loads(line)
                value['cursor'] = journal.tell()
                if value['type'] == 'exit':
                    if not replayed: output({'type': 'replayComplete'})
                    output(value)
                    return
                # Only old requests already answered before this attachment are suppressed.
                if not (value.get('requestId') is not None and journal.tell() <= replay_end and value['requestId'] not in state['pendingRequestIds']):
                    output(value)
                else: output({'type': 'cursor', 'cursor': journal.tell()})
            if not replayed and journal.tell() >= replay_end:
                replayed = True
                output({'type': 'replayComplete'})
            if not line:
                current = run_state(directory)
                if current and not current['brokerAlive']:
                    if not replayed: output({'type': 'replayComplete'})
                    if current.get('interrupted') or incomplete:
                        output({'type': 'stderr', 'data': base64.b64encode('원격 작업 실행 프로세스가 예기치 않게 종료되었습니다.\n'.encode()).decode()})
                    output({'type': 'exit', 'code': 1 if incomplete else current.get('exitCode', 1)})
                    return
                time.sleep(0.05)
try:
    initial = json.loads(sys.stdin.buffer.readline())
    if len(sys.argv) > 1 and sys.argv[1] == 'broker': broker(initial)
    else: client(initial)
except (BrokenPipeError, KeyboardInterrupt): pass
except Exception as error:
    output({'type': 'fatal', 'message': str(error)})
    sys.exit(1)
`

function remoteCommand(): string {
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
  const command = `PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"; exec python3 -u -c ${quote(REMOTE_AGENT_BROKER)}`
  return `exec $SHELL -ilc ${quote(command)}`
}

function connect(options: RemoteAgentOptions): ChildProcessWithoutNullStreams {
  return spawn(options.sshBin, [...options.sshArgs, remoteCommand()], { env: options.env, windowsHide: true })
}

export async function probeRemoteAgentRun(options: RemoteAgentOptions): Promise<RemoteAgentRunInfo | null> {
  return new Promise((resolve, reject) => {
    const child = connect(options)
    let buffer = ''
    let errors = ''
    let result: RemoteAgentRunInfo | null | undefined
    const timeout = setTimeout(() => { child.kill(); reject(new Error('원격 작업 확인 시간이 초과되었습니다.')) }, 30000)
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const message = JSON.parse(line)
          if (message.type === 'probe') result = message.info
          else if (message.type === 'fatal') errors = message.message
        } catch { /* A login banner is not part of the transport. */ }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk).slice(-4000) })
    child.stdin.on('error', () => {})
    child.on('error', (error) => { clearTimeout(timeout); reject(error) })
    child.on('close', () => {
      clearTimeout(timeout)
      if (result !== undefined) resolve(result)
      else reject(new Error(errors || '원격 작업을 확인하지 못했습니다.'))
    })
    child.stdin.end(JSON.stringify({ identity: options.identity, runId: options.runId, probe: true }) + '\n')
  })
}

/** A process-shaped connection to a detached remote worker, not to its SSH lifetime. */
export class RemoteAgentTransport extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly ready: Promise<RemoteAgentRunInfo>
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  readonly stdin = {
    destroyed: false,
    writableEnded: false,
    write: (data: string | Uint8Array): boolean => {
      if (this.stdin.destroyed || this.stdin.writableEnded) throw new Error('Remote input is closed')
      this.send('input', Buffer.from(data).toString('base64'))
      return true
    },
    end: (): void => {
      if (this.stdin.destroyed || this.stdin.writableEnded) return
      this.stdin.writableEnded = true
      this.send('end')
    }
  }
  private options: RemoteAgentOptions
  private connection?: ChildProcessWithoutNullStreams
  private retry?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private closed = false
  connected = false
  private cursor = 0
  private runId?: string
  private readonly newRunId = randomUUID()
  private readonly pending = new Map<string, Record<string, unknown>>()
  private resolveReady!: (info: RemoteAgentRunInfo) => void
  private rejectReady!: (error: Error) => void
  private readyResolved = false
  private backoff = 500

  constructor(options: RemoteAgentOptions) {
    super()
    this.options = options
    this.runId = options.runId
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    // Callers may use process events instead of awaiting ready.
    void this.ready.catch(() => {})
    queueMicrotask(() => this.open())
  }

  private send(type: string, data?: string): void {
    const id = randomUUID()
    const operation = { type, id, ...(data === undefined ? {} : { data }) }
    this.pending.set(id, operation)
    if (this.connected) this.connection?.stdin.write(JSON.stringify(operation) + '\n')
  }

  private sendHeartbeat(): void {
    const input = this.connection?.stdin
    if (!this.heartbeat || !this.connected || !input?.writable || input.destroyed || input.writableLength) return
    // A lease renewal is expendable: never queue, replay or retain it as an AI operation.
    input.write(JSON.stringify({ type: 'heartbeat', id: 'heartbeat' }) + '\n')
  }

  private open(): void {
    if (this.closed) return
    const child = connect(this.options)
    this.connection = child
    let buffer = ''
    let errors = ''
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.connection !== child || this.closed) return
      buffer += chunk.toString()
      const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
      for (const line of lines) {
        let event: Record<string, any>
        try { event = JSON.parse(line) } catch { continue }
        if (typeof event.cursor === 'number') this.cursor = event.cursor
        if (event.type === 'ready') {
          this.connected = true
          this.backoff = 500
          this.runId = event.info.runId
          if (event.info.metadata?.clientRequired === true && !this.heartbeat) {
            this.heartbeat = setInterval(() => this.sendHeartbeat(), CLIENT_HEARTBEAT_INTERVAL_MS)
            this.heartbeat.unref()
          }
          this.sendHeartbeat()
          if (!this.readyResolved) {
            this.readyResolved = true
            this.resolveReady(event.info)
            this.emit('ready', event.info)
          }
          this.emit('connected', event.info)
          this.emit('connection', true)
          for (const operation of this.pending.values()) child.stdin.write(JSON.stringify(operation) + '\n')
        } else if (event.type === 'stdout' || event.type === 'stderr') {
          this[event.type as 'stdout' | 'stderr'].emit('data', Buffer.from(event.data, 'base64'))
        } else if (event.type === 'ack') this.pending.delete(event.id)
        else if (event.type === 'replayComplete') this.emit('replayComplete')
        else if (event.type === 'exit') this.finish(event.code)
        else if (event.type === 'fatal' || event.type === 'operation-error') {
          this.pending.delete(event.id)
          this.fail(new Error(event.message))
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk).slice(-4000) })
    child.on('error', (error) => this.fail(error))
    child.on('close', () => {
      if (this.connection !== child || this.closed) return
      this.connected = false
      this.connection = undefined
      this.emit('disconnected', errors)
      this.emit('connection', false)
      this.retry = setTimeout(() => this.open(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 10000)
    })
    child.stdin.write(JSON.stringify({ identity: this.options.identity, command: this.options.command,
      metadata: this.options.metadata, source: REMOTE_AGENT_BROKER, runId: this.runId,
      newRunId: this.newRunId, cursor: this.cursor }) + '\n')
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.rejectReady(error)
    this.emit('error', error)
    this.finish(1)
  }

  private finish(code: number): void {
    if (this.closed) return
    this.exitCode = code
    this.detach()
    this.emit('close', code, null)
  }

  reconnect(): void {
    if (this.closed) return
    if (this.retry) clearTimeout(this.retry)
    const previous = this.connection
    this.connection = undefined
    this.connected = false
    previous?.kill()
    this.emit('connection', false)
    this.open()
  }

  kill(_signal?: NodeJS.Signals | number): boolean {
    if (this.closed) return false
    this.killed = true
    this.send('stop')
    return true
  }

  // ponytail: one private journal per turn; add retention when remote disk usage warrants it.
  detach(): void {
    if (this.closed) return
    this.closed = true
    this.connected = false
    this.stdin.destroyed = true
    if (this.retry) clearTimeout(this.retry)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.connection?.kill()
    this.connection = undefined
    this.pending.clear()
    if (!this.readyResolved) this.rejectReady(new Error('원격 연결이 분리되었습니다.'))
    this.emit('detached')
  }
}
