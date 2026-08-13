import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  rankCaseFolders,
  pathBelongsToCaseFolder,
  rebaseCaseFolderToRoot,
  trustedCaseFolder
} from '../src/renderer/src/caseFolderMatch.ts'

const caseInfo = {
  caseNumber: '2025느합1050',
  caseName: '[전자]재산분할',
  partyNames: ['하정웅']
}
const ranked = rankCaseFolders(
  [
    { path: '/drafts/하정웅_대여금_남원', name: '하정웅_대여금_남원' },
    { path: '/drafts/하정웅_재산분할', name: '하정웅_재산분할' }
  ],
  caseInfo
)

assert.equal(ranked[0]?.path, '/drafts/하정웅_재산분할')
assert.equal(trustedCaseFolder(ranked, caseInfo), '/drafts/하정웅_재산분할')

const ambiguous = rankCaseFolders(
  [
    { path: '/drafts/하정웅_대여금_남원', name: '하정웅_대여금_남원' },
    { path: '/drafts/하정웅_형사', name: '하정웅_형사' }
  ],
  { caseName: '[전자]기타', partyNames: ['하정웅'] }
)
assert.equal(trustedCaseFolder(ambiguous, { caseName: '[전자]기타', partyNames: ['하정웅'] }), undefined)

assert.equal(
  rebaseCaseFolderToRoot(
    '/Volumes/M2SSD/OneDrive-work/작성서류/하정웅_재산분할',
    '/Users/user/Library/CloudStorage/OneDrive-개인/작성서류'
  ),
  '/Users/user/Library/CloudStorage/OneDrive-개인/작성서류/하정웅_재산분할'
)
assert.equal(
  pathBelongsToCaseFolder(
    '/Volumes/M2SSD/OneDrive-work/작성서류/하정웅_재산분할/재산조사.md',
    '/Users/user/Library/CloudStorage/OneDrive-개인/작성서류/하정웅_재산분할'
  ),
  true
)
assert.equal(
  pathBelongsToCaseFolder(
    '/Volumes/M2SSD/OneDrive-work/작성서류/하정웅_대여금_남원/차용증.md',
    '/Users/user/Library/CloudStorage/OneDrive-개인/작성서류/하정웅_재산분할'
  ),
  false
)

const app = await readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
assert.match(
  app,
  /onResume\(p\.sessionId, p\.cwd \?\? filterCwd,/,
  'resume must use the cwd recorded in the transcript instead of the current filter cwd'
)
assert.match(
  app,
  /const existing = termTabs\.find\(\(t\) => !t\.ssh && t\.cwd === drafts\)/,
  'a case id alone must not relabel an agent tab that belongs to another folder'
)
assert.match(
  app,
  /matched && !pathBelongsToCaseFolder\(drafts, matched\)/,
  'a trusted exact case match must replace a stale pairing to another case folder'
)
const openSync = app.match(/const openSync = \(\): void => \{([\s\S]*?)\n  \}\n\n  const openFileSync/)?.[1]
assert.ok(openSync, 'openSync implementation must exist')
assert.match(
  openSync,
  /parseRemoteUri\(activeDraftsFolder \?\? ''\)/,
  'sync must preserve the remote folder shown in the explorer when no terminal is active'
)
assert.doesNotMatch(
  openSync,
  /cur\?\.ssh/,
  'sync must not decide whether a folder is remote from terminal presence alone'
)

console.log('case folder and session safety ok')
