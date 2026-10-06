import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { comparablePath, pathLeaf, searchNorm } from '../src/main/caseActivityData.ts'

const source = readFileSync(new URL('../src/main/sessions.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('sessions.ts', source, ts.ScriptTarget.Latest, true)
const names = ['pathMatchesAny', 'matchIndexedSession']
const declarations = parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
assert.equal(declarations.length, names.length)
const match = vm.runInNewContext(ts.transpileModule(
  declarations.map((node) => node.getText(parsed)).join('\n') + '\nmatchIndexedSession',
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText, { comparablePath, pathLeaf, searchNorm })

const cwd = '/project-workspaces/회수-project-1'
const context = { projectId: 'project-1', displayTitle: 'A사 회수', folderName: '회수', caseNumber: '2026가단1' }
const other = { cwd: '/project-workspaces/project-2', projectId: 'project-1', folderName: '회수', caseNumber: '2026가단1', searchText: 'A사 회수 2026가단1' }
assert.equal(match(other, cwd, context), false, 'matching project ID, title, case number and folder name cannot include another cwd')
assert.equal(match({ ...other, projectId: 'project-2' }, cwd, context), false, 'another project stays isolated')
assert.equal(match({ cwd }, cwd, context), true, 'older session metadata without projectId still matches its workspace')
assert.equal(match({ cwd: cwd.normalize('NFD') + '/' }, cwd, context), true, 'existing path normalization remains supported')
const aliases = new Set([comparablePath(cwd), comparablePath('/canonical/project-1')])
assert.equal(match({ cwd: '/canonical/project-1' }, cwd, context, aliases), true, 'canonical cwd aliases still match')
assert.equal(match(other, cwd, { caseNumber: '2026가단1' }), true, 'ordinary case history keeps cross-folder case matching')
assert.equal(match(other, cwd, { folderName: '회수' }), true, 'ordinary folder history keeps its existing matching')
assert.equal(match(other, cwd), false, 'unrelated history without a search context stays excluded')
console.log('project session scope: exact workspace and aliases only; legacy case/folder matching preserved')
