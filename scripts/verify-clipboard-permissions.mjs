import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const policy = source.match(/  const isAppWindow =[\s\S]*?(?=\n  createWindow\(\))/)?.[0]
assert.ok(policy, 'the app permission handlers must be registered before creating a window')

const handlers = {}
const appWindow = { id: 1 }
const detachedWindow = { id: 2 }
runInNewContext(ts.transpileModule(policy, {}).outputText, {
  BrowserWindow: { getAllWindows: () => [{ webContents: appWindow }, { webContents: detachedWindow }] },
  session: {
    defaultSession: {
      setPermissionCheckHandler: (handler) => { handlers.check = handler },
      setPermissionRequestHandler: (handler) => { handlers.request = handler }
    }
  }
})

const check = (permission, contents = appWindow, details = {}) =>
  handlers.check(contents, permission, 'file://', { isMainFrame: true, ...details })
const request = (permission, contents = appWindow, details = {}) => {
  let result
  handlers.request(contents, permission, (allowed) => { result = allowed }, { isMainFrame: true, ...details })
  return result
}

for (const handler of [check, request]) {
  assert.equal(handler('clipboard-sanitized-write'), true, 'copy buttons must be allowed to write')
  assert.equal(handler('clipboard-sanitized-write', detachedWindow), true, 'detached panels must also copy')
  assert.equal(handler('clipboard-sanitized-write', appWindow, { isMainFrame: false }), false)
  assert.equal(handler('clipboard-sanitized-write', { id: 99 }), false)
  assert.equal(handler('clipboard-sanitized-write', null), false)
  for (const permission of ['clipboard-read', 'deprecated-sync-clipboard-read', 'geolocation', 'notifications']) {
    assert.equal(handler(permission), false, `${permission} must remain denied`)
  }
}
assert.equal(check('media', appWindow, { mediaType: 'audio' }), true)
assert.equal(check('media', appWindow, { mediaType: 'video' }), false)
assert.equal(check('media', appWindow, { mediaType: 'audio', isMainFrame: false }), false)
assert.equal(check('media', null, { mediaType: 'audio' }), false)
assert.equal(request('media', appWindow, { mediaTypes: ['audio'] }), true)
assert.equal(request('media', appWindow, { mediaTypes: ['audio', 'video'] }), false)
assert.equal(request('media', appWindow, { mediaTypes: [] }), false)
assert.equal(request('media', appWindow), false)
assert.equal(request('media', { id: 99 }, { mediaTypes: ['audio'] }), false)

console.log('clipboard writes work in app windows; read, subframe, and microphone restrictions are preserved')
