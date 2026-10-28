import { createHash } from 'node:crypto'
import { rfsBrowserExec, rfsForwardRemotePort } from './remoteFs'

const shq = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

export async function connectRemoteBrowser(profileId: string, sessionId: string, source: string): Promise<{
  port: number
  token: string
  downloadPath: string
  tunnel: Awaited<ReturnType<typeof rfsForwardRemotePort>>
}> {
  const key = createHash('sha256').update(sessionId).digest('hex').slice(0, 32)
  const version = createHash('sha256').update(source).digest('hex')
  const script = `import os,sys,json,secrets,subprocess,time,urllib.request,base64,shutil,fcntl
os.umask(0o077)
directory=os.path.join(os.path.expanduser('~'),'.legal-terminal','browsers',${JSON.stringify(key)})
os.makedirs(directory,mode=0o700,exist_ok=True)
if os.path.islink(directory): raise RuntimeError('브라우저 폴더가 심볼릭 링크입니다.')
os.chmod(directory,0o700)
lock=open(os.path.join(directory,'launch.lock'),'a')
fcntl.flock(lock,fcntl.LOCK_EX)
config_path=os.path.join(directory,'config.json')
ready_path=os.path.join(directory,'ready.json')
def load(path):
 try:
  with open(path) as f: return json.load(f)
 except (OSError,ValueError): return {}
config=load(config_path)
ready=load(ready_path)
def alive():
 try:
  port=ready.get('port')
  if not isinstance(port,int) or not 0<port<65536 or not config.get('token'): return False
  req=urllib.request.Request('http://127.0.0.1:'+str(port)+'/state',headers={'Authorization':'Bearer '+config['token']})
  with urllib.request.urlopen(req,timeout=2) as r: return r.status==200
 except Exception: return False
if not alive():
 node=shutil.which('node')
 if not node: raise RuntimeError('원격 서버에 Node.js 22 이상이 필요합니다.')
 major=int(subprocess.check_output([node,'-p','process.versions.node.split(".")[0]'],text=True).strip())
 if major<22: raise RuntimeError('원격 서버에 Node.js 22 이상이 필요합니다.')
 runtime=os.path.join(directory,'runtime-${version.slice(0, 16)}.cjs')
 with open(runtime,'wb') as f: f.write(base64.b64decode(${JSON.stringify(Buffer.from(source).toString('base64'))}))
 config={'directory':directory,'token':config.get('token') or secrets.token_hex(32),'readyPath':ready_path}
 with open(config_path,'w') as f: json.dump(config,f)
 os.chmod(config_path,0o600)
 try: os.unlink(ready_path)
 except FileNotFoundError: pass
 log=open(os.path.join(directory,'runtime.log'),'ab',buffering=0)
 child=subprocess.Popen([node,runtime,config_path],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,close_fds=True)
 for attempt in range(160):
  ready=load(ready_path)
  if alive(): break
  if child.poll() is not None:
   with open(os.path.join(directory,'runtime.log'),'rb') as f:
    f.seek(0,2); f.seek(max(0,f.tell()-1800)); error=f.read().decode('utf-8','replace')
   raise RuntimeError(error)
  time.sleep(.25)
 else: raise RuntimeError('원격 브라우저 시작이 지연되고 있습니다. 다시 연결해 주세요.')
print(json.dumps({'port':ready['port'],'token':config['token'],'downloadPath':ready.get('downloadPath',os.path.join(directory,'downloads'))}))
`
  const result = await rfsBrowserExec(profileId, `PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH" python3 -c ${shq(script)}`)
  const config = JSON.parse(result.trim()) as { port: number; token: string; downloadPath: string }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !/^[a-f0-9]{64}$/.test(config.token) || typeof config.downloadPath !== 'string') {
    throw new Error('원격 브라우저 연결 정보를 확인할 수 없습니다.')
  }
  const tunnel = await rfsForwardRemotePort(profileId, config.port)
  return { ...config, tunnel }
}
