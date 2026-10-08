import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'filetree-state-'))
const source = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import FileTree from './src/renderer/src/filetree/FileTree'
const folder = path => ({path, name:path.split('/').pop(), isDir:true})
const file = path => ({...folder(path), isDir:false})
const roots = ['/cases/a', '/cases/b', 'ssh://office/cases/a']
const directories = Object.fromEntries(roots.flatMap(root => [
  [root, [folder(root+'/evidence')]],
  [root+'/evidence', [folder(root+'/evidence/nested')]],
  [root+'/evidence/nested', [file(root+'/evidence/nested/brief.md')]]
]))
let failPath = '', deferredPath = '', pending = []
window.lt = {fs:{
  onDragError:()=>()=>{},
  list:async path => {
    if (path === failPath) throw Error('temporary connection failure')
    if (path === deferredPath) return new Promise((resolve,reject)=>pending.push({resolve,reject}))
    return structuredClone(directories[path] || [])
  }
}}
function Harness() {
  const [root,setRoot] = useState(roots[0])
  const [visible,setVisible] = useState(true)
  const [filter,setFilter] = useState('')
  const [nonce,setNonce] = useState(0)
  window.change = {setRoot,setVisible,setFilter,refresh:()=>setNonce(n=>n+1)}
  return visible && <FileTree root={root} filter={filter} refreshNonce={nonce} onOpenFile={()=>{}} />
}
createRoot(document.getElementById('root')).render(<Harness />)
window.uiCheck = async (only = '') => {
  let checks = 0
  const pause = () => new Promise(resolve=>setTimeout(resolve,25))
  const wait = async (test,label) => {for(let i=0;i<160;i++){if(test())return;await pause()}throw Error('Timed out: '+label)}
  const row = path => [...document.querySelectorAll('.tree-row')].find(el=>el.dataset.entryPath===path)
  const check = (ok,label) => {checks++;if(!ok)throw Error(label)}
  const change = async (action) => {action();await pause();await pause()}
  const click = async path => {await wait(()=>row(path),path);await change(()=>row(path).click())}
  const a=roots[0], evidence=a+'/evidence', nested=evidence+'/nested', brief=nested+'/brief.md'
  await click(evidence);await click(nested);await wait(()=>row(brief),'initial expanded folders')
  if (!only || only==='refresh') {
    failPath=evidence
    await change(()=>window.change.refresh())
    check(!!row(brief),'A failed folder refresh must preserve visible descendants')
    check(document.body.textContent.includes('temporary connection failure'),'The read failure must be visible')
    failPath=''
    await change(()=>window.change.refresh())
    check(!!row(brief),'Folder expansion survives recovery')
    check(!document.body.textContent.includes('temporary connection failure'),'Successful refresh clears the error')
  }
  if (!only || only==='navigation') {
    await click(evidence);check(!row(nested),'Parent folder collapses')
    await click(evidence);await wait(()=>row(nested),'parent reopens')
    check(!!row(brief),'Reopening a parent must restore expanded descendants')
    await change(()=>window.change.setFilter('brief'))
    await wait(()=>document.querySelector('.tree-search-row'),'search results')
    await change(()=>window.change.setFilter(''))
    await wait(()=>row(brief),'search preserves expansion')
    await change(()=>window.change.setVisible(false))
    await change(()=>window.change.setVisible(true))
    await wait(()=>row(brief),'sidebar remount preserves expansion')
    for (const other of roots.slice(1)) {
      await change(()=>window.change.setRoot(other))
      await wait(()=>row(other+'/evidence'),'another root')
      check(!row(other+'/evidence/nested'),'Different local and SSH roots have independent expansion')
      await change(()=>window.change.setRoot(a))
      await wait(()=>row(brief),'return to original root')
    }
    await click(nested)
    await change(()=>window.change.setVisible(false))
    await change(()=>window.change.setVisible(true))
    await wait(()=>row(nested),'collapsed child restored')
    check(!row(brief),'An explicitly collapsed child stays collapsed after remount')
    await click(nested);await wait(()=>row(brief),'reopen child')
  }
  if (!only || only==='race') {
    deferredPath=evidence
    await change(()=>window.change.refresh())
    await wait(()=>pending.length===1,'first delayed refresh')
    await change(()=>window.change.refresh())
    await wait(()=>pending.length===2,'second delayed refresh')
    await change(()=>pending[1].resolve(directories[evidence]))
    await change(()=>pending[0].resolve([]))
    check(!!row(brief),'An older response must not erase newer directory contents')
    deferredPath='';pending=[]
    await change(()=>window.change.refresh())
    await wait(()=>row(brief),'latest directory listing')
  }
  if (!only || only==='initial-error') {
    const other=roots[1]
    failPath=other+'/evidence'
    await change(()=>window.change.setRoot(other))
    await click(failPath)
    check(document.body.textContent.includes('temporary connection failure'),'Initial child failure is shown')
    check(!document.body.textContent.includes('빈 폴더'),'A failed read must not claim the folder is empty')
    failPath=''
    await change(()=>window.change.refresh())
    await wait(()=>row(other+'/evidence/nested'),'retry successful')
    await change(()=>window.change.setRoot(a))
    await wait(()=>row(brief),'original tree restored')
  }
  return {checks}
}
window.checkRestored = async () => {
  const path=roots[0]+'/evidence/nested/brief.md'
  for(let i=0;i<160;i++) {
    if([...document.querySelectorAll('.tree-row')].some(el=>el.dataset.entryPath===path))return
    await new Promise(resolve=>setTimeout(resolve,25))
  }
  throw Error('Reload must restore expanded folders')
}
`
function runApp({ temp, only }) {
  const { app, BrowserWindow } = require('electron')
  const path = require('node:path')
  app.setPath('userData', path.join(temp, 'profile'))
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
    try {
      await win.loadFile(path.join(temp, 'index.html'))
      const result = await win.webContents.executeJavaScript(`window.uiCheck(${JSON.stringify(only)})`)
      if (!only) {
        const reloaded = new Promise(resolve=>win.webContents.once('did-finish-load', resolve))
        win.reload()
        await reloaded
        await win.webContents.executeJavaScript('window.checkRestored()')
      }
      console.log('FILETREE_STATE_OK '+JSON.stringify(result))
      app.exit(0)
    } catch (error) {
      console.error(error)
      app.exit(1)
    }
  })
}
try {
  await build({ stdin: { contents: source, resolveDir: root, loader: 'tsx' }, bundle: true,
    outfile: path.join(temp, 'ui.js'), platform: 'browser', jsx: 'automatic' })
  await fs.writeFile(path.join(temp, 'index.html'), '<html><body><div id="root"></div><script src="ui.js"></script></body></html>')
  await fs.writeFile(path.join(temp, 'main.cjs'), `(${runApp.toString()})(${JSON.stringify({ temp, only: process.argv[2] || '' })})`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [path.join(temp, 'main.cjs')], { env })
    let output = ''
    child.stdout.on('data', data=>{output+=data})
    child.stderr.on('data', data=>{output+=data})
    child.on('error', reject)
    const timeout = setTimeout(()=>{child.kill();reject(Error('File tree check timed out'))}, 30_000)
    child.on('exit', code=>{clearTimeout(timeout);resolve({ code, output })})
  })
  assert.equal(result.code, 0, result.output)
  console.log(result.output.split('\n').filter(line=>line.includes('FILETREE_STATE_OK')).join('\n'))
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
