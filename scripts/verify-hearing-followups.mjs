import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hearing-followups-'))
const screenshot = path.join(root, '.omx/screenshots/hearing-followups.png')
const source = `
import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import HearingRecordPanel from './src/renderer/src/hearing/HearingRecordPanel'
import './src/renderer/src/styles.css'
const actions=['자료 회신 확인','의견서 검토','응답 지연 조치','재시도 확인 조치','계정 전환 조치','사건 전환 조치']
const record={version:1,id:'record-1',case:{jsId:'case-1',caseNumber:'2026가단1'},speakers:[{id:'court',label:'재판부',role:'court'}],activeSpeakerId:'court',requests:[],entries:[],result:{nextActions:actions,nextDate:'2026-10-08'},createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z',jsSync:{syncedAt:'2026-10-01T00:00:00Z',todoId:'record-completed'}}
const files={'/synthetic/record.json':JSON.stringify(record),'/synthetic/other.json':JSON.stringify({...record,id:'record-2',case:{jsId:'case-2'},result:{nextActions:['다른 사건 조치']}})}
window.calls=[];window.rows=[];window.mode='ok';window.release=null;window.changed=0
window.lt={fs:{stat:async()=>({ok:true,isDir:true}),readText:async(path)=>({text:files[path]}),writeText:async(path,content)=>{window.calls.push(['write',path,JSON.parse(content)]);files[path]=content;return {ok:true}},mkdir:async()=>({ok:true,path:'/synthetic/.hearings'})},todo:{
 list:async(params)=>{window.calls.push(['list',params]);if(window.mode==='lookup-error')return {ok:false,error:'조회 장애'};return {ok:true,todos:structuredClone(window.rows)}},
 get:async(id)=>{window.calls.push(['get',id]);return {ok:true,todo:structuredClone(window.rows.find(row=>row.id===id))}},
 assignees:async(params)=>{window.calls.push(['assignees',params]);return {ok:true,assignees:[{id:'member-1',name:'담당 변호사'}]}},
 create:async(input)=>{window.calls.push(['create',structuredClone(input)]);if(window.mode==='defer')await new Promise(resolve=>window.release=resolve);if(window.mode==='lost')return {ok:false,error:'응답 없음'};const todo={...input,id:'task-'+window.calls.filter(c=>c[0]==='create').length};window.rows.push(todo);if(window.mode==='timeout')throw Error('timeout');return {ok:true,todo}}
}}
function Harness(){const [key,setKey]=useState(0);const [other,setOther]=useState(false);window.reopen=()=>setKey(k=>k+1);window.switchCase=()=>setOther(true);return <HearingRecordPanel key={key} initialPath={other?'/synthetic/other.json':'/synthetic/record.json'} onTasksChanged={()=>window.changed++}/>}
createRoot(document.getElementById('root')).render(<Harness/>);
window.uiCheck=async()=>{
 let checks=0
 const check=(condition,message)=>{checks++;if(!condition)throw Error(message)}
 const pause=()=>new Promise(resolve=>setTimeout(resolve,30))
 const wait=async(fn)=>{for(let i=0;i<180;i++){if(fn())return;await pause()}throw Error('Timed out: '+fn)}
 const dialog=()=>document.querySelector('dialog')
 const button=(label,within=document)=>[...within.querySelectorAll('button')].find(el=>el.textContent.trim()===label)
 const click=async(label,within=document)=>{const el=button(label,within);if(!el||el.matches(':disabled'))throw Error('Missing/disabled '+label);el.click();await pause()}
 const input=async(selector,value)=>{const el=dialog().querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));await pause()}
 const createCalls=()=>window.calls.filter(c=>c[0]==='create')
 const open=async(action)=>{const row=[...document.querySelectorAll('.hearing-next-action')].find(el=>el.textContent.startsWith(action));row.querySelector('button').click();await wait(()=>dialog());await pause()}
 const close=async()=>click('닫기',dialog())
 await wait(()=>document.querySelectorAll('.hearing-next-action').length===6)
 check(createCalls().length===0,'Viewing next actions never creates tasks')
 await open(actions[0]);check(dialog().querySelector('input[type=date]').value==='','No inferred deadline from next hearing date')
 await input('input:not([type])','수정한 자료 확인');await click('담당 후보 조회',dialog());dialog().querySelector('select').value='member-1';dialog().querySelector('select').dispatchEvent(new Event('change',{bubbles:true}));await pause()
 const submit=button('열린 할일 생성',dialog());submit.click();submit.click();await wait(()=>dialog().querySelector('[aria-label="연결된 할일"]'))
 const first=createCalls()[0][1];check(createCalls().length===1,'Double click posts once');check(first.title==='수정한 자료 확인'&&first.caseId==='case-1'&&first.status==='pending'&&first.type==='todo','Only selected action creates an open task for exact case');check(first.dueDate===undefined&&first.assigneeId==='member-1','Explicit assignee and no guessed due date');check(first.evidence[0].kind==='file'&&first.evidence[0].uri==='/synthetic/record.json'&&first.evidence[0].status==='candidate'&&first.evidence[0].reason==='할일 생성 출처 · 완료 근거 아님'&&!first.evidence[0].id,'Real file source is candidate, not fake event/completion evidence')
 let saved=JSON.parse(files['/synthetic/record.json']);check(saved.jsSync.todoId==='record-completed'&&saved.jsSync.followups[0].todoId==='task-1','Record sync remains and followup id persists');check(saved.result.nextActions.length===6,'All original actions preserved');check(window.changed>0,'Parent gets refresh notification')
 await close();window.reopen();await pause();await wait(()=>document.querySelectorAll('.hearing-next-action').length===6);await open(actions[0]);await wait(()=>dialog().querySelector('[aria-label="연결된 할일"]'));check(createCalls().length===1,'Reopen saved record reuses task id');await close()
 await open(actions[1]);await input('input[type=date]','2026-10-09');await click('열린 할일 생성',dialog());await wait(()=>dialog().querySelector('[aria-label="연결된 할일"]'));check(createCalls()[1][1].dueDate==='2026-10-09T14:59:00.000Z','Only confirmed date becomes dueDate');await close()
 window.mode='timeout';await open(actions[2]);await click('열린 할일 생성',dialog());await wait(()=>dialog().textContent.includes('생성 결과 확인 필요'));check(createCalls().length===3&&button('확인 후 다시 생성',dialog()).disabled,'Timeout triggers source lookup and blocks duplicate');check(window.calls.at(-1)[0]==='list','Uncertain response re-queries source');const existing=[...dialog().querySelectorAll('button')].find(el=>el.textContent.includes('기존 할일 열기'));existing.click();await wait(()=>dialog().querySelector('[aria-label="연결된 할일"]'));check(createCalls().length===3,'Recovered timeout selects existing task');await close()
 window.mode='lost';await open(actions[3]);await click('열린 할일 생성',dialog());await wait(()=>dialog().textContent.includes('생성 결과 확인 필요'));check(button('확인 후 다시 생성',dialog()).disabled,'No-match timeout requires explicit review');await close();window.reopen();await pause();await wait(()=>document.querySelectorAll('.hearing-next-action').length===6);await open(actions[3]);await wait(()=>dialog().querySelector('input[type=checkbox]'));check(button('확인 후 다시 생성',dialog()).disabled,'Pending source persists across remount and requires review');window.mode='ok';dialog().querySelector('input[type=checkbox]').click();await pause();await click('확인 후 다시 생성',dialog());await wait(()=>dialog().querySelector('[aria-label="연결된 할일"]'));check(createCalls().length===5,'Explicit reviewed retry creates only once');await close()
 window.mode='lookup-error';await open(actions[4]);await click('열린 할일 생성',dialog());await wait(()=>dialog().textContent.includes('조회 장애'));check(createCalls().length===5,'Source lookup failure blocks POST');await close()
 window.mode='defer';await open(actions[4]);await click('열린 할일 생성',dialog());await wait(()=>window.release);const changedBefore=window.changed;window.dispatchEvent(new Event('lt-js-token-updated'));await wait(()=>!dialog());window.mode='ok';window.release();window.release=null;await pause();await pause();saved=JSON.parse(files['/synthetic/record.json']);check(!saved.jsSync.followups.find(l=>l.action===actions[4]).todoId&&window.changed===changedBefore,'Late account response cannot apply task id or refresh new account')
 window.mode='defer';await open(actions[5]);await click('열린 할일 생성',dialog());await wait(()=>window.release);window.switchCase();await wait(()=>document.querySelector('.hearing-next-action')?.textContent.includes('다른 사건 조치'));window.mode='ok';window.release();await pause();await pause();check(!dialog(),'Case change closes old dialog');check(!JSON.parse(files['/synthetic/other.json']).jsSync.followups,'Late result cannot write linkage into another case')
 const pending=window.calls.findIndex(c=>c[0]==='write'&&c[2].jsSync.followups?.some(l=>l.action===actions[0]&&!l.todoId));const posted=window.calls.findIndex(c=>c[0]==='create');check(pending>=0&&pending<posted,'Source attempt is saved before network POST for crash-safe review')
 await open('다른 사건 조치')
 return {checks,creates:createCalls().length}
}
`
try {
 await fs.mkdir(path.dirname(screenshot), { recursive: true })
 await build({ stdin: { contents: source, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: path.join(temp, 'ui.js'), platform: 'browser', loader: { '.ttf': 'file' }, jsx: 'automatic' })
 await fs.writeFile(path.join(temp, 'index.html'), '<html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>')
 await fs.writeFile(path.join(temp, 'main.cjs'), `const {app,BrowserWindow}=require('electron');const fs=require('fs');app.whenReady().then(async()=>{const w=new BrowserWindow({width:1280,height:1000,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});try{await w.loadFile(${JSON.stringify(path.join(temp,'index.html'))});const result=await w.webContents.executeJavaScript('window.uiCheck()');fs.writeFileSync(${JSON.stringify(screenshot)},(await w.webContents.capturePage()).toPNG());w.setSize(500,900);await new Promise(resolve=>setTimeout(resolve,100));if(await w.webContents.executeJavaScript('document.querySelector("dialog").scrollWidth > document.querySelector("dialog").clientWidth'))throw Error('Narrow dialog overflow');console.log('HEARING_FOLLOWUPS_RESULT '+JSON.stringify(result));app.exit(0)}catch(error){console.error(error);console.error(await w.webContents.executeJavaScript('document.body.innerText'));app.exit(1)}})`)
 const electron = createRequire(import.meta.url)('electron')
 const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
 const result = await new Promise((resolve, reject) => {
  const child=spawn(electron,[path.join(temp,'main.cjs'),`--user-data-dir=${path.join(temp,'profile')}`],{env}); let output=''
  child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.on('error',reject)
  const timeout=setTimeout(()=>{child.kill();reject(new Error('Hearing followup UI test timeout'))},30000)
  child.on('exit',code=>{clearTimeout(timeout);resolve({code,output})})
 })
 assert.equal(result.code,0,result.output)
 console.log(result.output.split('\n').filter(line=>line.includes('HEARING_FOLLOWUPS_RESULT')).join('\n'))
} finally { await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100}) }
