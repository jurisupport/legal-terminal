import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bulk-todo-closure-'))
const screenshot = path.join(root, '.omx/screenshots/bulk-todo-closure.png')
const source = `
import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import TodosDashboard from './src/renderer/src/dashboard/TodosDashboard'
import CasesDashboard from './src/renderer/src/dashboard/CasesDashboard'
import {clearCaseListCache} from './src/renderer/src/dashboard/caseListCache'
import './src/renderer/src/styles.css'
const initial=[
 {id:'a',title:'대상 완료 업무 가',status:'completed',caseId:'case-1',caseName:'합성 사건 가'},
 {id:'b',title:'대상 완료 업무 나',status:'done',caseId:'case-2',caseName:'합성 사건 나'},
 {id:'hidden',title:'검색 밖 완료 업무',status:'completed'},
 {id:'pending',title:'예정 업무',status:'pending'},{id:'progress',title:'진행중 업무',status:'in_progress'},
 {id:'memo',title:'완료된 사건 메모',status:'completed',type:'memo'},
 {id:'children',title:'남은 자식 업무',status:'completed',children:[{id:'child',title:'열린 자식',status:'pending'}]},
 {id:'stale',title:'상태가 바뀐 업무',status:'completed'},
 {id:'failed',title:'조회 실패 업무',status:'completed'},{id:'missing',title:'응답 없는 업무',status:'completed'},
 {id:'closed',title:'이미 종료한 업무',status:'closed'}
]
const cases=[{id:'case-1',caseNumber:'2026가단100',caseName:'합성 사건 가',status:'active',parties:[],hearings:[]}]
let rows,getCounts,inFlight,maxInFlight
window.forbidden=[]
const forbidden=name=>async()=>{window.forbidden.push(name);throw Error('Forbidden case/complete API: '+name)}
function resetData(){rows=structuredClone(initial);getCounts={};inFlight=0;maxInFlight=0;window.calls=[];window.overrides={stale:{status:'pending'},failed:{failure:true},missing:{missing:true}};window.failIds=[];window.pauseArchive='';window.pauseGet='';window.finishArchive=null;window.finishGet=null;window.deferLists=false;window.failList=false;window.pendingLists=[]}
resetData()
window.lt={todo:{
 capabilities:async()=>({ok:true,capabilities:{queryFields:[],createFields:[],updateFields:[],statusFields:['childDispositions'],caseClosure:false}}),
 list:async(params={})=>{window.calls.push(['list',params]);const result=window.failList?{ok:false,error:'합성 목록 조회 실패'}:{ok:true,todos:structuredClone(rows)};if(window.deferLists)await new Promise(resolve=>window.pendingLists.push({params,resolve}));return result},
 get:async(id)=>{const version=10+(getCounts[id]=(getCounts[id]||0)+1);window.calls.push(['get',id,version]);if(window.pauseGet===id)await new Promise(resolve=>window.finishGet=resolve);const override=window.overrides[id]||{};if(override.failure)return {ok:false,error:'합성 할일 조회 실패'};if(override.missing)return {ok:true};return {ok:true,todo:{...structuredClone(rows.find(row=>row.id===id)),version,...override}}},
 archive:async(id,options)=>{window.calls.push(['archive',id,options]);inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);try{if(window.pauseArchive===id)await new Promise(resolve=>window.finishArchive=resolve);if(window.failIds.includes(id))return {ok:false,error:'합성 종료 실패'};rows.find(row=>row.id===id).status='closed';return {ok:true}}finally{inFlight--}},
 complete:forbidden('todo.complete'),update:forbidden('todo.update')
},js:{tokenStatus:async()=> 'ok',listCases:async()=>({ok:true,cases:structuredClone(cases)}),caseClosurePreview:forbidden('caseClosurePreview'),updateCaseStatus:forbidden('updateCaseStatus'),updateCaseEngagement:forbidden('updateCaseEngagement')},sessions:{byCase:async()=>({}),byFolder:async()=>[]}}
function Harness(){const [generation,setGeneration]=useState(0);const [view,setView]=useState('todos');const [tick,setTick]=useState(0);window.reset=()=>{resetData();setView('todos');setGeneration(value=>value+1)};window.showCases=()=>{clearCaseListCache();setView('cases')};const snapshot={todos:structuredClone(rows.filter(row=>['pending','in_progress'].includes(row.status))),loading:false,error:'',hasToken:true,fetchedAt:'2026-09-23T00:00:00Z',refresh:()=>setTick(value=>value+1)};return <main data-refresh={tick}>{view==='todos'?<TodosDashboard key={generation} snapshot={snapshot} filterNonce={0} onOpenDefault={()=>window.calls.push(['workspace'])} onChanged={()=>window.calls.push(['changed'])}/>:<CasesDashboard onOpenWorkspace={()=>window.calls.push(['workspace'])} onBrief={()=>{}}/>}</main>}
createRoot(document.getElementById('root')).render(<Harness/>);
window.uiCheck=async()=>{
 let checks=0
 const check=(condition,message)=>{checks++;if(!condition)throw Error(message)}
 const pause=()=>new Promise(resolve=>setTimeout(resolve,25))
 const wait=async(fn)=>{for(let i=0;i<160;i++){if(fn())return;await pause()}throw Error('Timed out: '+fn)}
 const buttons=(label,within=document)=>[...within.querySelectorAll('button')].filter(el=>el.textContent.trim()===label)
 const click=async(label,within=document)=>{const el=buttons(label,within)[0];if(!el)throw Error('Missing button '+label);if(el.matches(':disabled'))throw Error('Disabled button '+label);el.click();await pause()}
 const input=async(value)=>{const el=document.querySelector('.dash-search');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));await pause()}
 const tab=async(label)=>click(label,document.querySelector('[aria-label="할일 상태"]'))
 const launch=()=>buttons('완료된 할일 일괄 종료')[0]
 const dialog=()=>document.querySelector('dialog[aria-label="완료된 할일 일괄 종료"]')
 const save=()=>[...dialog().querySelectorAll('button')].find(el=>/^\\d+건 일괄 종료$/.test(el.textContent.trim()))
 const archives=()=>window.calls.filter(call=>call[0]==='archive')
 const gets=()=>window.calls.filter(call=>call[0]==='get')
 const open=async()=>{await click('완료된 할일 일괄 종료');await wait(()=>dialog());await wait(()=>save()&&!save().disabled)}
 const close=async()=>click('닫기',dialog())
 const complete=async()=>{await tab('완료');await wait(()=>launch()&&!launch().disabled)}
 const reset=async()=>{window.reset();await pause();await wait(()=>document.querySelector('[aria-label="할일 상태"] button[aria-pressed="true"]')?.textContent==='열린 할일')}
 const targets=async()=>{await complete();await input('대상');await open()}
 await wait(()=>document.querySelector('.todo-card'))
 check(!launch(),'Open todo tab has no completed bulk action')
 window.deferLists=true;await tab('완료');await wait(()=>window.pendingLists.length===1);check(launch().disabled,'Bulk action disabled before completed history loads')
 await tab('전체');await wait(()=>window.pendingLists.length===2);await tab('완료');await wait(()=>window.pendingLists.length===3)
 window.pendingLists[1].resolve();await pause();check(launch().disabled,'Late all-history response cannot enable completed bulk action')
 window.pendingLists[0].resolve();await pause();check(launch().disabled,'Older completed response cannot enable latest pending request')
 window.deferLists=false;window.pendingLists[2].resolve();await wait(()=>!launch().disabled)
 check(document.querySelectorAll('.todo-card').length===7,'Completed history excludes pending, progress, closed, and memo rows despite mixed response')
 window.failList=true;await click('검색');await wait(()=>document.body.textContent.includes('합성 목록 조회 실패'));check(launch().disabled,'Failed refresh disables bulk action despite prior history')
 window.failList=false;await click('검색');await wait(()=>!launch().disabled)
 window.deferLists=true;await click('검색');await wait(()=>window.pendingLists.length===4);await tab('열린 할일');window.pendingLists[3].resolve();await pause();check(!launch(),'Late completed response after leaving tab exposes no bulk action');window.deferLists=false
 await reset();await targets();check(save().textContent.trim()==='2건 일괄 종료','Local search scopes one confirmation to two completed tasks across cases')
 check(JSON.stringify(gets().map(call=>call[1]))===JSON.stringify(['a','b']),'Exact displayed todo ids are read, including legacy done')
 window.pauseArchive='a';const first=save();first.click();first.click();await wait(()=>window.finishArchive)
 check(save().disabled&&archives().length===1,'Busy guard prevents duplicate bulk confirmation')
 window.pauseArchive='';window.finishArchive();await wait(()=>archives().length===2&&inFlight===0);await pause()
 check(maxInFlight===1&&JSON.stringify(archives().map(call=>call.slice(1)))===JSON.stringify([['a',{version:12}],['b',{version:12}]]),'Sequential archive calls use fresh todo versions without case/child arguments')
 check(['hidden','pending','progress','memo','children','stale','failed','missing','closed'].every(id=>rows.find(row=>row.id===id).status===initial.find(row=>row.id===id).status),'Search-hidden and other unselected items remain unchanged')
 check(!!dialog(),'Per-item success remains visible');await close();check(window.calls.some(call=>call[0]==='changed'),'Completed mutations refresh dashboard')
 await tab('종료');await wait(()=>document.querySelectorAll('.todo-card').length===2);const closedQuery=window.calls.findLast(call=>call[0]==='list')[1];check(closedQuery.status==='closed'&&closedQuery.includeArchived===true,'Closed tasks remain accessible in the closure history tab')
 await reset();await complete();await open();check(save().textContent.trim()==='3건 일괄 종료','Still-completed tasks without open children are the only eligible rows')
 check(gets().length===7&&!gets().some(call=>['memo','pending','progress','closed'].includes(call[1])),'Non-todo and non-completed rows never enter bulk preview')
 check(dialog().textContent.includes('남은 자식 업무')&&dialog().textContent.includes('합성 할일 조회 실패')&&dialog().textContent.includes('응답 없는 업무'),'Ineligible and failed rows retain visible explanations')
 save().click();await wait(()=>archives().length===3&&inFlight===0);await pause();check(JSON.stringify(archives().map(call=>call[1]))===JSON.stringify(['a','b','hidden']),'Open children, stale status, errors, and missing reads never archive');await close()
 await reset();await complete();await input('대상');window.overrides.a={id:'wrong-id'};await open();check(save().textContent.trim()==='1건 일괄 종료'&&dialog().textContent.includes('할일 조회 실패'),'Initial mismatched todo id is excluded');window.overrides.b={id:'another-id'};save().click();await wait(()=>dialog().textContent.includes('할일 재확인 실패'));check(archives().length===0,'Fresh mismatched todo id is never archived');await close()
 await reset();await targets();window.overrides.a={children:[{id:'new-child',title:'추가 자식',status:'in_progress'}]};window.overrides.b={status:'pending'};save().click();await wait(()=>gets().length===4);await pause();check(archives().length===0,'Fresh child and status changes prevent late closure');await close()
 await reset();await targets();window.failIds=['b'];save().click();await wait(()=>dialog()?.textContent.includes('합성 종료 실패'))
 check(archives().length===2&&rows.find(row=>row.id==='a').status==='closed'&&rows.find(row=>row.id==='b').status==='done','Partial failure preserves success and failed row')
 const priorGets=gets().length;window.failIds=[];await click('다시 확인',dialog());await wait(()=>save()?.textContent.trim()==='1건 일괄 종료'&&!save().disabled);check(!gets().slice(priorGets).some(call=>call[1]==='a'),'Retry skips successful todo reads')
 save().click();await wait(()=>archives().length===3&&inFlight===0);await pause();check(archives().filter(call=>call[1]==='a').length===1&&archives().filter(call=>call[1]==='b').length===2,'Retry never repeats successful archive');await close()
 await reset();await targets();window.pauseArchive='a';save().click();await wait(()=>window.finishArchive);await close();window.pauseArchive='';window.finishArchive();await wait(()=>inFlight===0);await pause();check(archives().length===1&&rows.find(row=>row.id==='b').status==='done','Cancel stops remaining queued todo archives');check(window.calls.some(call=>call[0]==='changed'),'Completed in-flight archive refreshes after modal closes')
 await reset();await targets();window.pauseGet='a';save().click();await wait(()=>window.finishGet);window.dispatchEvent(new Event('lt-js-token-updated'));await wait(()=>!dialog());window.pauseGet='';window.finishGet();await pause();await pause();check(archives().length===0&&!launch(),'Account change cancels remaining work and resets history')
 check(!window.calls.some(call=>call[0]==='workspace'),'Bulk todo interactions never open case workspace')
 window.showCases();await wait(()=>document.querySelector('.case-card'));check(!buttons('사건 종결').length&&!buttons('선택 사건 일괄 종결').length&&!document.querySelector('.case-card input[type="checkbox"]'),'Cases dashboard has no new closure buttons or selection')
 document.querySelector('.case-card').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}));await wait(()=>document.querySelector('.ctx-menu'));check(!document.querySelector('.ctx-menu').textContent.includes('사건 종결')&&!document.querySelector('.ctx-menu').textContent.includes('사건 상태 변경'),'Case context menu has no added closure action')
 check(window.forbidden.length===0,'No case mutation, case preview, todo.complete, or todo.update API used')
 await reset();await complete();await open()
 return {checks,forbiddenCalls:window.forbidden.length}
}
`
try {
 await fs.mkdir(path.dirname(screenshot), { recursive: true })
 await build({ stdin: { contents: source, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: path.join(temp, 'ui.js'), platform: 'browser', loader: { '.ttf': 'file' }, jsx: 'automatic' })
 await fs.writeFile(path.join(temp, 'index.html'), '<html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>')
 await fs.writeFile(path.join(temp, 'main.cjs'), `const {app,BrowserWindow}=require('electron');const fs=require('fs');app.whenReady().then(async()=>{const w=new BrowserWindow({width:1280,height:1000,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});try{await w.loadFile(${JSON.stringify(path.join(temp,'index.html'))});for(let i=0;i<100;i++){if(await w.webContents.executeJavaScript('typeof window.uiCheck === "function"'))break;await new Promise(resolve=>setTimeout(resolve,20))}const result=await w.webContents.executeJavaScript('window.uiCheck()');fs.writeFileSync(${JSON.stringify(screenshot)},(await w.webContents.capturePage()).toPNG());w.setSize(500,900);await new Promise(resolve=>setTimeout(resolve,100));if(await w.webContents.executeJavaScript('document.documentElement.scrollWidth > window.innerWidth'))throw Error('Narrow viewport horizontal overflow');fs.writeFileSync(${JSON.stringify(screenshot.replace('.png','-narrow.png'))},(await w.webContents.capturePage()).toPNG());console.log('BULK_TODO_CLOSURE_RESULT '+JSON.stringify(result));app.exit(0)}catch(error){console.error(error);fs.writeFileSync(${JSON.stringify(screenshot.replace('.png','-failure.png'))},(await w.webContents.capturePage()).toPNG());app.exit(1)}})`)
 const electron = process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'node_modules/electron/dist/electron')
 const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
 const result = await new Promise((resolve, reject) => {
  const child=spawn(electron,[path.join(temp,'main.cjs'),`--user-data-dir=${path.join(temp,'profile')}`],{env}); let output=''
  child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.on('error',reject)
  const timeout=setTimeout(()=>{child.kill();reject(new Error('Bulk todo closure UI test timeout'))},30000)
  child.on('exit',code=>{clearTimeout(timeout);resolve({code,output})})
 })
 assert.equal(result.code,0,result.output)
 console.log(result.output.split('\n').filter(line=>line.includes('BULK_TODO_CLOSURE_RESULT')).join('\n'))
 console.log('Screenshots: '+screenshot+', '+screenshot.replace('.png','-narrow.png'))
} finally { await fs.rm(temp,{recursive:true,force:true}) }
