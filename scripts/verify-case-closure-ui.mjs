import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'case-closure-'))
const screenshot = path.join(root, '.omx/screenshots/case-closure.png')
const source = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import CasesDashboard from './src/renderer/src/dashboard/CasesDashboard'
import './src/renderer/src/styles.css'
const cases=[
 {id:'empty',caseNumber:'2026가단100',caseName:'할일 없는 사건',status:'active',parties:[],hearings:[]},
 {id:'tasks',caseNumber:'2026가단200',caseName:'할일 검토 사건',status:'active',parties:[],hearings:[]}
]
const tasks=[{id:'first',title:'남은 서류 확인',status:'pending',version:3},{id:'second',title:'후속 업무 확인',status:'in_progress',version:4}]
window.calls=[];window.previewMode='ok';window.failSave=false
window.lt={
 js:{
  tokenStatus:async()=> 'ok',
  listCases:async(params={})=>{window.calls.push(['list',params]);return {ok:true,cases:structuredClone(cases.filter(row=>!params.status||row.status===params.status))}},
  caseClosurePreview:async(id)=>{window.calls.push(['preview',id]);if(window.previewMode==='defer')await new Promise(resolve=>{window.finishPreview=resolve});if(window.previewMode==='failed')return {ok:false,error:'합성 검토 조회 실패'};return {ok:true,preview:{id,version:9,status:cases.find(row=>row.id===id).status,engagementStatus:'retained',tasks:id==='tasks'?structuredClone(tasks):[],blocked:window.previewMode==='blocked'}}},
  updateCaseStatus:async(...args)=>{window.calls.push(['status',...args]);if(window.failSave)return {ok:false,error:'합성 상태 저장 실패'};cases.find(row=>row.id===args[0]).status=args[1];return {ok:true}}
 },
 todo:{list:async(params)=>{window.calls.push(['memos',params]);return {ok:true,todos:[]}}},
 sessions:{byCase:async()=>({}),byFolder:async()=>[]}
}
createRoot(document.getElementById('root')).render(<CasesDashboard onOpenWorkspace={()=>window.calls.push(['workspace'])} onBrief={()=>{}} onChanged={()=>window.calls.push(['changed'])}/>)
window.uiCheck=async()=>{
 let checks=0
 const check=(condition,message)=>{checks++;if(!condition)throw Error(message)}
 const pause=()=>new Promise(resolve=>setTimeout(resolve,30))
 const wait=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await pause()}throw Error('Timed out: '+fn)}
 const card=title=>[...document.querySelectorAll('.case-card')].find(el=>el.querySelector('.case-name')?.textContent===title)
 const button=(label,within=document)=>[...within.querySelectorAll('button')].find(el=>el.textContent.trim()===label)
 const click=async(label,within=document)=>{const el=button(label,within);if(!el)throw Error('Missing button '+label);if(el.matches(':disabled'))throw Error('Disabled button '+label);el.click();await pause()}
 const choose=async(el,value)=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('change',{bubbles:true}));await pause()}
 const updates=()=>window.calls.filter(call=>call[0]==='status')
 const saveButton=()=>button('검토 내용과 상태 저장',document.querySelector('dialog'))
 const open=async(title)=>{await click('사건 종결',card(title));await wait(()=>document.querySelector('dialog'));return document.querySelector('dialog')}
 const close=async()=>click('닫기',document.querySelector('dialog'))
 const context=async(title,label)=>{card(title).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}));await wait(()=>document.querySelector('.ctx-menu'));const item=[...document.querySelectorAll('.ctx-item')].find(el=>el.textContent.trim()===label);check(!!item,'Context menu exposes '+label);item.click();await wait(()=>document.querySelector('dialog'));check(!document.querySelector('.ctx-menu'),'Context menu closes after action');return document.querySelector('dialog')}
 await wait(()=>card('할일 없는 사건')&&card('할일 검토 사건'))
 check(!!button('사건 종결',card('할일 없는 사건')),'Case without tasks has direct closure action')
 await click('종결');await wait(()=>document.querySelectorAll('.case-card').length===0)
 await click('진행중');await wait(()=>card('할일 없는 사건'))
 window.previewMode='defer';let dialog=await open('할일 없는 사건')
 check(saveButton().disabled&&dialog.textContent.includes('열린 할일 조회가 필요합니다.'),'Closure disabled before preview resolves')
 check(updates().length===0&&!window.calls.some(call=>call[0]==='workspace'),'Opening review does not save or open workspace')
 window.previewMode='ok';window.finishPreview();await wait(()=>!saveButton().disabled)
 check(dialog.textContent.includes('열린 할일이 없습니다.'),'No-task preview allows closure')
 await close();check(updates().length===0&&!!card('할일 없는 사건'),'Cancel leaves active case unchanged')
 dialog=await open('할일 없는 사건');await wait(()=>!saveButton().disabled)
 window.failSave=true;await click('검토 내용과 상태 저장',dialog)
 check(dialog.textContent.includes('합성 상태 저장 실패')&&!!card('할일 없는 사건'),'Failed save keeps dialog and active case')
 check(!window.calls.some(call=>call[0]==='changed'),'Failed save does not notify refresh')
 window.failSave=false;await click('검토 내용과 상태 저장',dialog);await wait(()=>!document.querySelector('dialog')&&!card('할일 없는 사건'))
 check(JSON.stringify(updates().at(-1))===JSON.stringify(['status','empty','closed',[],9]),'No-task closure sends exact id, closed status, empty decisions, version')
 check(window.calls.some(call=>call[0]==='list'&&call[1].status==='active'&&call[1].refresh===true),'Successful closure forces active list refresh')
 check(window.calls.filter(call=>call[0]==='changed').length===1,'Successful closure notifies parent once')
 await click('종결');await wait(()=>card('할일 없는 사건'))
 check(!!button('사건 상태 변경',card('할일 없는 사건')),'Closed case appears despite previously cached empty closed tab')
 dialog=await context('할일 없는 사건','🗂 사건 상태 변경');await wait(()=>!saveButton().disabled)
 await choose(dialog.querySelector('fieldset select'),'active');await click('검토 내용과 상태 저장',dialog);await wait(()=>!document.querySelector('dialog')&&!card('할일 없는 사건'))
 const reopened=updates().at(-1)
 check(reopened[1]==='empty'&&reopened[2]==='active'&&reopened[3]===undefined&&reopened[4]===9,'Closed case can reopen with current version')
 check(window.calls.some(call=>call[0]==='list'&&call[1].status==='closed'&&call[1].refresh===true),'Reopening forces closed list refresh')
 await click('진행중');await wait(()=>card('할일 없는 사건')&&card('할일 검토 사건'))
 const before=updates().length
 dialog=await context('할일 검토 사건','🗂 사건 종결')
 await wait(()=>dialog.querySelectorAll('.todo-disposition select').length===2)
 check(saveButton().disabled,'Every open task requires a decision')
 await choose(dialog.querySelector('.todo-disposition select'),'keep');check(saveButton().disabled,'One decision cannot bypass remaining task')
 await close();check(updates().length===before&&!!card('할일 검토 사건'),'Cancel child review does not move case')
 window.previewMode='blocked';dialog=await open('할일 없는 사건');await wait(()=>dialog.textContent.includes('접근할 수 없는 열린 할일'))
 check(saveButton().disabled,'Blocked preview prevents closure');await close()
 window.previewMode='failed';dialog=await open('할일 없는 사건');await wait(()=>dialog.textContent.includes('합성 검토 조회 실패'))
 check(saveButton().disabled&&updates().length===before,'Failed preview prevents closure and makes no write');await close()
 window.previewMode='ok';dialog=await context('할일 검토 사건','🗂 사건 종결');await wait(()=>dialog.querySelectorAll('.todo-disposition select').length===2)
 const selections=[...dialog.querySelectorAll('.todo-disposition select')]
 await choose(selections[0],'complete');await choose(selections[1],'keep');check(!saveButton().disabled,'Explicit decisions permit closure')
 await click('검토 내용과 상태 저장',dialog);await wait(()=>!document.querySelector('dialog')&&!card('할일 검토 사건'))
 check(JSON.stringify(updates().at(-1))===JSON.stringify(['status','tasks','closed',[{id:'first',action:'complete',version:3},{id:'second',action:'keep',version:4}],9]),'Task decisions and task/case versions preserved')
 check(window.calls.filter(call=>call[0]==='changed').length===3,'All successful case changes refresh parent')
 check(!window.calls.some(call=>call[0]==='workspace'),'Card and context management never bubbles to workspace')
 await open('할일 없는 사건');await wait(()=>!saveButton().disabled)
 return {checks,statusWrites:updates().length}
}
`
try {
 await fs.mkdir(path.dirname(screenshot), { recursive: true })
 await build({ stdin: { contents: source, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: path.join(temp, 'ui.js'), platform: 'browser', loader: { '.ttf': 'file' }, jsx: 'automatic' })
 await fs.writeFile(path.join(temp, 'index.html'), '<html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>')
 await fs.writeFile(path.join(temp, 'main.cjs'), `const {app,BrowserWindow}=require('electron');const fs=require('fs');app.whenReady().then(async()=>{const w=new BrowserWindow({width:1280,height:1000,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});try{await w.loadFile(${JSON.stringify(path.join(temp,'index.html'))});for(let i=0;i<100;i++){if(await w.webContents.executeJavaScript('typeof window.uiCheck === "function"'))break;await new Promise(resolve=>setTimeout(resolve,20))}const result=await w.webContents.executeJavaScript('window.uiCheck()');fs.writeFileSync(${JSON.stringify(screenshot)},(await w.webContents.capturePage()).toPNG());w.setSize(500,900);await new Promise(resolve=>setTimeout(resolve,100));if(await w.webContents.executeJavaScript('document.documentElement.scrollWidth > window.innerWidth'))throw Error('Narrow viewport horizontal overflow');fs.writeFileSync(${JSON.stringify(screenshot.replace('.png','-narrow.png'))},(await w.webContents.capturePage()).toPNG());await w.webContents.executeJavaScript(${JSON.stringify('document.querySelector(".todo-dialog button").click()')});await new Promise(resolve=>setTimeout(resolve,100));fs.writeFileSync(${JSON.stringify(screenshot.replace('.png','-cards-narrow.png'))},(await w.webContents.capturePage()).toPNG());w.setSize(1280,1000);await new Promise(resolve=>setTimeout(resolve,100));fs.writeFileSync(${JSON.stringify(screenshot.replace('.png','-cards.png'))},(await w.webContents.capturePage()).toPNG());console.log('CASE_CLOSURE_RESULT '+JSON.stringify(result));app.exit(0)}catch(error){console.error(error);app.exit(1)}})`)
 const electron = process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'node_modules/electron/dist/electron')
 const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
 const result = await new Promise((resolve, reject) => {
  const child=spawn(electron,[path.join(temp,'main.cjs'),`--user-data-dir=${path.join(temp,'profile')}`],{env}); let output=''
  child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.on('error',reject)
  const timeout=setTimeout(()=>{child.kill();reject(new Error('Case closure UI test timeout'))},30000)
  child.on('exit',code=>{clearTimeout(timeout);resolve({code,output})})
 })
 assert.equal(result.code,0,result.output)
 console.log(result.output.split('\n').filter(line=>line.includes('CASE_CLOSURE_RESULT')).join('\n'))
 console.log('Screenshots: '+screenshot+', '+screenshot.replace('.png','-narrow.png'))
} finally { await fs.rm(temp,{recursive:true,force:true}) }
