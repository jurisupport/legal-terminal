import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bulk-case-closure-'))
const screenshot = path.join(root, '.omx/screenshots/bulk-case-closure.png')
const source = `
import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import CasesDashboard from './src/renderer/src/dashboard/CasesDashboard'
import {clearCaseListCache} from './src/renderer/src/dashboard/caseListCache'
import './src/renderer/src/styles.css'
const initial=[['a','대상 사건 가'],['b','대상 사건 나'],['c','선택하지 않은 사건'],['task','남은 할일 사건'],['blocked','접근 제한 사건'],['failed','조회 실패 사건'],['missing','응답 없는 사건'],['inactive','이미 종결된 응답'],['closed','기존 종결 사건']].map(([id,caseName],index)=>({id,caseName,caseNumber:'2026가단'+(100+index),status:id==='closed'?'closed':'active',parties:[],hearings:[]}))
let rows,previewCounts,inFlight,maxInFlight
function resetData(){rows=structuredClone(initial);previewCounts={};inFlight=0;maxInFlight=0;window.calls=[];window.overrides={task:{tasks:[{id:'todo',title:'남은 할일',status:'pending'}]},blocked:{blocked:true},failed:{failure:true},missing:{missing:true},inactive:{status:'closed'}};window.failIds=[];window.pauseSave='';window.pausePreview='';window.finishSave=null;window.finishPreview=null;window.pauseList=false;window.finishList=null}
resetData()
window.lt={js:{
 tokenStatus:async()=> 'ok',
 listCases:async(params={})=>{window.calls.push(['list',params]);if(window.pauseList)await new Promise(resolve=>window.finishList=resolve);return {ok:true,cases:structuredClone(rows.filter(row=>(!params.status||row.status===params.status)&&(!params.search||row.caseName.includes(params.search))))}},
 caseClosurePreview:async(id)=>{const version=10+(previewCounts[id]=(previewCounts[id]||0)+1);window.calls.push(['preview',id,version]);if(window.pausePreview===id)await new Promise(resolve=>window.finishPreview=resolve);const override=window.overrides[id]||{};if(override.failure)return {ok:false,error:'합성 검토 조회 실패'};if(override.missing)return {ok:true};return {ok:true,preview:{id,version,status:rows.find(row=>row.id===id).status,blocked:false,tasks:[],...override}}},
 updateCaseStatus:async(...args)=>{window.calls.push(['status',...args]);inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);try{if(window.pauseSave===args[0])await new Promise(resolve=>window.finishSave=resolve);if(window.failIds.includes(args[0]))return {ok:false,error:'합성 상태 저장 실패'};rows.find(row=>row.id===args[0]).status=args[1];return {ok:true}}finally{inFlight--}}
},todo:{list:async()=>({ok:true,todos:[]})},sessions:{byCase:async()=>({}),byFolder:async()=>[]}}
function Harness(){const [generation,setGeneration]=useState(0);window.reset=()=>{resetData();clearCaseListCache();setGeneration(value=>value+1)};return <CasesDashboard key={generation} onOpenWorkspace={()=>window.calls.push(['workspace'])} onBrief={()=>{}} onChanged={()=>window.calls.push(['changed'])}/>}
createRoot(document.getElementById('root')).render(<Harness/>);
window.uiCheck=async()=>{
 let checks=0
 const check=(condition,message)=>{checks++;if(!condition)throw Error(message)}
 const pause=()=>new Promise(resolve=>setTimeout(resolve,25))
 const wait=async(fn)=>{for(let i=0;i<160;i++){if(fn())return;await pause()}throw Error('Timed out: '+fn)}
 const buttons=(label,within=document)=>[...within.querySelectorAll('button')].filter(el=>el.textContent.trim()===label)
 const click=async(label,within=document)=>{const el=buttons(label,within)[0];if(!el)throw Error('Missing button '+label);if(el.matches(':disabled'))throw Error('Disabled button '+label);el.click();await pause()}
 const input=async(el,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));await pause()}
 const box=id=>document.querySelector('input[aria-label="'+initial.find(row=>row.id===id).caseNumber+' 종결 선택"]')
 const all=()=>document.querySelector('input[aria-label="현재 목록 전체 선택"]')
 const toolbar=()=>buttons('선택 사건 일괄 종결')[0]
 const checked=()=>[...document.querySelectorAll('.case-card input[type="checkbox"]')].filter(el=>el.checked)
 const dialog=()=>document.querySelector('dialog[aria-label="선택 사건 일괄 종결"]')
 const save=()=>[...dialog().querySelectorAll('button')].find(el=>/^\\d+건 일괄 종결$/.test(el.textContent.trim()))
 const writes=()=>window.calls.filter(call=>call[0]==='status')
 const previews=()=>window.calls.filter(call=>call[0]==='preview')
 const select=async(...ids)=>{for(const id of ids){if(!box(id))throw Error('Missing case checkbox '+id);box(id).click();await pause()}}
 const open=async()=>{await click('선택 사건 일괄 종결');await wait(()=>dialog());await wait(()=>save()&&!save().disabled);return dialog()}
 const close=async()=>click('닫기',dialog())
 const reset=async()=>{window.reset();await pause();await wait(()=>box('a')&&toolbar()?.disabled)}
 await wait(()=>box('a'))
 check(toolbar().disabled,'Empty selection disables bulk action')
 await select('a');check(!toolbar().disabled&&checked().length===1,'Selecting one case enables action')
 check(!window.calls.some(call=>call[0]==='workspace'),'Checkbox does not open workspace')
 window.pauseList=true;await click('↻');await wait(()=>window.finishList);check(toolbar().disabled&&all().disabled&&box('a').disabled,'Loading disables selection and bulk action');window.pauseList=false;window.finishList();await wait(()=>!toolbar().disabled)
 await click('종결');await wait(()=>document.querySelectorAll('.case-card').length===1);check(!box('closed')&&checked().length===0,'Status change clears selection and closed cards cannot be selected')
 await click('전체');await wait(()=>document.querySelectorAll('.case-card').length===9);all().click();await pause()
 check(checked().length===8&&!box('closed'),'Select all includes only displayed active cases')
 await open();check(previews().length===8&&!previews().some(call=>call[1]==='closed'),'Preview excludes closed case')
 check(save().textContent.trim()==='3건 일괄 종결','Only active unblocked no-task valid previews count')
 check(dialog().textContent.includes('남은 할일 사건')&&dialog().textContent.includes('접근 제한 사건')&&dialog().textContent.includes('합성 검토 조회 실패'),'Excluded rows retain case names and errors')
 await close();check(writes().length===0,'Closing preview makes no writes')
 await input(document.querySelector('.dash-search'),'대상');check(checked().length===0,'Search clears selected cases immediately')
 await wait(()=>document.querySelectorAll('.case-card').length===2);all().click();await pause();check(checked().length===2,'Search select-all is limited to visible results')
 const previousPreviews=previews().length;await open();check(JSON.stringify(previews().slice(previousPreviews).map(call=>call[1]).sort())===JSON.stringify(['a','b']),'Filtered bulk preview receives only visible selected cases');await close()
 window.dispatchEvent(new Event('lt-js-token-updated'));await pause();check(checked().length===0,'Account change clears selection')
 await reset();all().click();await pause();await open();save().click();await wait(()=>writes().length===3&&inFlight===0);await pause();check(JSON.stringify(writes().map(call=>call[1]))===JSON.stringify(['a','b','c']),'Open-task, blocked, failed, missing, and inactive previews never receive writes');await close()
 await reset();await select('a','b');await open();window.pauseSave='a';const first=save();first.click();first.click();await wait(()=>window.finishSave)
 check(save().disabled&&writes().length===1,'Busy guard prevents duplicate save')
 window.pauseSave='';window.finishSave();await wait(()=>writes().length===2&&inFlight===0);await pause()
 check(maxInFlight===1,'Bulk updates run sequentially')
 check(JSON.stringify(writes().map(call=>call.slice(1)))===JSON.stringify([['a','closed',[],12],['b','closed',[],12]]),'Each save refreshes preview and uses fresh version')
 check(rows.find(row=>row.id==='c').status==='active'&&rows.find(row=>row.id==='a').status==='closed'&&rows.find(row=>row.id==='b').status==='closed','Only selected cases close')
 check(!!dialog(),'Success results remain in modal')
 await close();await wait(()=>!box('a')&&!box('b'));check(window.calls.some(call=>call[0]==='changed'),'Completed changes refresh parent')
 await reset();await select('a','b');await open();window.overrides.a={tasks:[{id:'new',title:'새 할일',status:'pending'}]};window.overrides.b={status:'closed'};save().click();await wait(()=>previews().length===4);await pause()
 check(writes().length===0,'Fresh task and non-active status prevent late closure')
 await close();await reset();await select('a','b');await open();window.failIds=['b'];save().click();await wait(()=>dialog()?.textContent.includes('합성 상태 저장 실패'))
 check(writes().length===2&&rows.find(row=>row.id==='a').status==='closed'&&rows.find(row=>row.id==='b').status==='active','Partial failure retains independent success and error')
 const oldPreviews=previews().length;window.failIds=[];await click('다시 확인',dialog());await wait(()=>save()?.textContent.trim()==='1건 일괄 종결'&&!save().disabled)
 check(!previews().slice(oldPreviews).some(call=>call[1]==='a'),'Retry does not recheck successful case')
 save().click();await wait(()=>writes().length===3&&inFlight===0);await pause();check(writes().filter(call=>call[1]==='a').length===1&&writes().filter(call=>call[1]==='b').length===2,'Retry never repeats successful closure')
 await close();await reset();await select('a','b');await open();window.pauseSave='a';save().click();await wait(()=>window.finishSave);await close();window.pauseSave='';window.finishSave();await wait(()=>inFlight===0);await pause()
 check(writes().length===1&&rows.find(row=>row.id==='b').status==='active','Closing modal stops remaining case requests');check(window.calls.some(call=>call[0]==='changed'),'In-flight completed change still refreshes parent')
 await reset();await select('a','b');await open();window.pausePreview='a';save().click();await wait(()=>window.finishPreview);window.dispatchEvent(new Event('lt-js-token-updated'));await wait(()=>!dialog());window.pausePreview='';window.finishPreview();await pause();await pause()
 check(writes().length===0&&checked().length===0,'Account change cancels queued work before any write')
 check(!window.calls.some(call=>call[0]==='workspace'),'Bulk interactions never open workspace')
 await reset();all().click();await pause();await open()
 return {checks}
}
`
try {
 await fs.mkdir(path.dirname(screenshot), { recursive: true })
 await build({ stdin: { contents: source, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: path.join(temp, 'ui.js'), platform: 'browser', loader: { '.ttf': 'file' }, jsx: 'automatic' })
 await fs.writeFile(path.join(temp, 'index.html'), '<html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>')
 await fs.writeFile(path.join(temp, 'main.cjs'), `const {app,BrowserWindow}=require('electron');const fs=require('fs');app.whenReady().then(async()=>{const w=new BrowserWindow({width:1280,height:1000,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});try{await w.loadFile(${JSON.stringify(path.join(temp,'index.html'))});for(let i=0;i<100;i++){if(await w.webContents.executeJavaScript('typeof window.uiCheck === "function"'))break;await new Promise(resolve=>setTimeout(resolve,20))}const result=await w.webContents.executeJavaScript('window.uiCheck()');fs.writeFileSync(${JSON.stringify(screenshot)},(await w.webContents.capturePage()).toPNG());w.setSize(500,900);await new Promise(resolve=>setTimeout(resolve,100));if(await w.webContents.executeJavaScript('document.documentElement.scrollWidth > window.innerWidth'))throw Error('Narrow viewport horizontal overflow');fs.writeFileSync(${JSON.stringify(screenshot.replace('.png','-narrow.png'))},(await w.webContents.capturePage()).toPNG());console.log('BULK_CASE_CLOSURE_RESULT '+JSON.stringify(result));app.exit(0)}catch(error){console.error(error);fs.writeFileSync(${JSON.stringify(screenshot.replace('.png','-failure.png'))},(await w.webContents.capturePage()).toPNG());app.exit(1)}})`)
 const electron = process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'node_modules/electron/dist/electron')
 const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
 const result = await new Promise((resolve, reject) => {
  const child=spawn(electron,[path.join(temp,'main.cjs'),`--user-data-dir=${path.join(temp,'profile')}`],{env}); let output=''
  child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.on('error',reject)
  const timeout=setTimeout(()=>{child.kill();reject(new Error('Bulk closure UI test timeout'))},30000)
  child.on('exit',code=>{clearTimeout(timeout);resolve({code,output})})
 })
 assert.equal(result.code,0,result.output)
 console.log(result.output.split('\n').filter(line=>line.includes('BULK_CASE_CLOSURE_RESULT')).join('\n'))
 console.log('Screenshots: '+screenshot+', '+screenshot.replace('.png','-narrow.png'))
} finally { await fs.rm(temp,{recursive:true,force:true}) }
