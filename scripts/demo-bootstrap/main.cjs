// README 데모 캡처 전용 부트스트랩.
// - userData를 임시 폴더로 분리해 실사용 설정·프로젝트·SSH 프로필이 화면에 나오지 않게 한다.
// - JuriSupport·할일·최근 사건처럼 홈 폴더/계정에서 읽는 실데이터 IPC는 가상 데이터로 대체한다.
// - 그 밖의 기능(파일, Agent, 내보내기)은 실제 앱 코드를 그대로 사용한다.
const { app, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const repo = process.env.LT_DEMO_REPO
const profile = process.env.LT_DEMO_PROFILE
if (!repo || !profile) throw new Error('LT_DEMO_REPO / LT_DEMO_PROFILE 필요')
fs.mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
app.getVersion = () => pkg.version

const demoCases = JSON.parse(process.env.LT_DEMO_CASES || '[]')
let history = demoCases.map((c, i) => ({ ...c, ts: Date.now() - i * 60_000 }))

const stub = {
  'case:history': () => history,
  'case:addHistory': (_e, entry) => {
    history = [{ ...entry, ts: Date.now() }, ...history.filter((h) => h.drafts !== entry.drafts)]
    return history
  },
  'js:hasToken': () => false,
  'js:tokenStatus': () => 'missing',
  'js:setToken': () => ({ ok: false, error: '데모 환경' }),
  'js:upcomingHearings': () => ({ ok: true, hearings: [], complete: true, fetchedAt: new Date().toISOString() }),
  'js:hearingSummary': () => ({ ok: true, summary: { todayCount: 0, weekCount: 0 } }),
  'js:listCases': () => ({ ok: true, cases: [] }),
  'todo:list': () => ({ ok: true, todos: [] }),
  'todo:capabilities': () => ({ ok: true, capabilities: {} }),
  'sessions:workLog': () => []
}
// 원래 처리 결과에서 데모 사건(demo-fixtures) 외 항목을 걸러낸다.
const demoMarker = process.env.LT_DEMO_MARKER || path.join(repo, 'scripts', 'demo-fixtures') + path.sep
const isDemo = (value) => JSON.stringify(value ?? null).includes(JSON.stringify(demoMarker).slice(1, -1))
const wrap = {
  'workspace:autoList': (orig) => async (...args) => {
    const result = await orig(...args)
    return result && Array.isArray(result.snapshots) ? { ...result, snapshots: result.snapshots.filter(isDemo) } : result
  }
}
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, handler) => {
  if (stub[channel]) return handle(channel, stub[channel])
  if (wrap[channel]) return handle(channel, wrap[channel](handler))
  if (channel.startsWith('js:') || channel.startsWith('todo:')) {
    return handle(channel, () => ({ ok: false, error: '데모 환경에서는 JuriSupport를 연결하지 않습니다.' }))
  }
  return handle(channel, handler)
}

require(path.join(repo, 'out/main/index.js'))
