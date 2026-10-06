import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-ui-'))
const screenshot = path.join(root, '.omx/screenshots/todo-ui.png')
await fs.mkdir(path.dirname(screenshot), { recursive: true })
const fileCases = [
 ['파일 URI', 'file:///synthetic/call%20note.md', '/synthetic/call note.md'],
 ['로컬호스트 URI', 'file://localhost/synthetic/%EC%A6%9D%EA%B1%B0.pdf', '/synthetic/증거.pdf'],
 ['윈도 드라이브 URI', 'file:///C:/synthetic/call%20note.md', 'C:/synthetic/call note.md'],
 ['네트워크 URI', 'file://server/share/call%20note.md', '\\\\server\\share\\call note.md'],
 ['인증 정보 URI', 'file://user:password@server/share/call.md', null],
 ['제어 문자 URI', 'file:///synthetic/call%0Anote.md', null],
 ['원문 제어 문자 URI', 'file:///synthetic/call\nnote.md', null],
 ['잘못된 인코딩 URI', 'file:///synthetic/call%ZZ.md', null]
]
const source = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import TodosDashboard from './src/renderer/src/dashboard/TodosDashboard'
import TodoSummary from './src/renderer/src/dashboard/TodoSummary'
import {ToolRow,toolDisplayName,toolStepDisplay} from './src/renderer/src/agent/ToolRow'
import './src/renderer/src/styles.css'
const fileCases = ${JSON.stringify(fileCases)}
const rows = [
 { id:'parent', title:'준비서면 제출 확인', status:'pending', caseId:'case-1', caseName:'합성 사건', dueDate:'2020-01-01T05:30:45.123Z', createdAt:'2019-01-01', version:1, children:[{id:'child',title:'첨부서류 확인',status:'pending'}] },
 { id:'undated', title:'기한 없는 오래된 업무', status:'in_progress', createdAt:'2020-01-01', updatedAt:'2020-01-01' },
 { id:'child', title:'첨부서류 확인', status:'pending', caseId:'case-1', caseName:'합성 사건', parentId:'parent', dueDate:'2020-02-01', createdAt:'2020-01-01' }
]
let memos = [{id:'memo',type:'memo',title:'기존 사건 메모',version:7,status:'pending',caseId:'case-1'}]
window.calls=[]; window.handoffs=[]; window.failUpdate=false
const capabilities={queryFields:[],createFields:['priority','parentId','reviewAt'],updateFields:['priority','reviewAt','evidence'],statusFields:['childDispositions'],evidenceSuggestions:true,caseClosure:true}
window.lt = {
 todo:{
 capabilities:async()=>({ok:true,capabilities}),
 list:async(params)=>{window.calls.push(['list',params]);return {ok:true,todos:params.type==='memo'?memos:rows}},
 get:async(id)=>({ok:true,todo:rows.find(r=>r.id===id)}),
 update:async(id,patch)=>{window.calls.push(['update',id,patch]); if(window.failUpdate)return {ok:false,error:'합성 저장 실패'}; const todo=[...rows,...memos].find(r=>r.id===id); Object.assign(todo,patch);return {ok:true,todo}},
 complete:async(id,text,context,options)=>{window.calls.push(['complete',id,options]);return {ok:true,todo:{...rows.find(r=>r.id===id),status:'completed'}}},
 archive:async(id,options)=>{window.calls.push(['archive',id,options]);memos=memos.filter(r=>r.id!==id);return {ok:true}},
 create:async(input)=>{window.calls.push(['create',input]); const todo={...input,id:'new-'+window.calls.length,status:'pending'}; if(input.type==='memo')memos.push(todo);return {ok:true,todo}},
 appendProgress:async()=>({ok:true}),
 evidenceSuggestions:async()=>({ok:true,error:'일부 자료 조회 실패 · 확인 가능한 후보 표시',candidates:[{kind:'document',id:'doc',uri:'https://example.invalid/doc',label:'제출 전 초안',reason:'작성됨, 제출 확인 필요',status:'candidate'},{kind:'file',uri:'/synthetic/cases/준비서면.pdf',label:'사건 폴더 문서',status:'candidate'},{kind:'file',uri:'ssh://test-host/cases/증거.pdf',label:'원격 사건 문서',status:'candidate'},...fileCases.map(([label,uri])=>({kind:'file',uri,label,status:'candidate'}))]})
 },
 js:{listCases:async()=>({ok:true,cases:[{id:'case-2',caseName:'이관 대상 사건',status:'active'}]}),caseClosurePreview:async()=>({ok:true,preview:{id:'case-1',version:3,status:'active',engagementStatus:'unknown',tasks:rows.filter(r=>r.caseId),blocked:false}}),updateCaseStatus:async(...args)=>{window.calls.push(['caseStatus',...args]);return {ok:true}},updateCaseEngagement:async(...args)=>{window.calls.push(['engagement',...args]);return {ok:true}}},
 app:{openExternal:async(uri)=>window.calls.push(['open',uri])}
}
function Harness(){const [toolExpanded,setToolExpanded]=useState(false);const [tick,setTick]=useState(0);const [filter,setFilter]=useState('open');const [hearingState,setHearingState]=useState({summary:{todayCount:27,weekCount:42,fetchedAt:'2026-09-12T00:00:00Z'},error:''});window.setHearingState=setHearingState;const snapshot={todos:[...rows],loading:false,error:'',hasToken:true,fetchedAt:'2026-09-12T00:00:00Z',refresh:()=>setTick(t=>t+1)};return <div style={{height:'100vh',overflow:'auto'}}><TodoSummary snapshot={snapshot} onFilter={setFilter} hearingSummary={hearingState.summary} hearingsError={hearingState.error}/><TodosDashboard onManageTodos={(items)=>window.handoffs.push(items)} onOpenDefault={()=>window.calls.push(['workspace'])} onOpenEvidenceFile={(file,label)=>window.calls.push(['openFile',file,label])} snapshot={snapshot} initialFilter={filter} filterNonce={tick}/><ToolRow step={{id:'managed-tool',title:'',toolName:'mcp__legal_terminal_jurisupport__update_task',input:JSON.stringify({id:'opaque-task-id',title:'제출 확인'}),status:'done'}} expanded={toolExpanded} onToggle={()=>setToolExpanded(v=>!v)}/></div>}
createRoot(document.getElementById('root')).render(<Harness/>);
window.uiCheck = async () => {
 const wait=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,20))}throw Error('Timed out: '+fn)};
 const buttons=(label,within=document)=>[...within.querySelectorAll('button')].filter(b=>b.textContent.trim()===label);
 const click=async(label,within=document)=>{const b=buttons(label,within)[0];if(!b)throw Error('Missing button '+label);if(b.disabled)throw Error('Disabled button '+label);b.click();await new Promise(r=>setTimeout(r,30))};
 const input=async(el,value)=>{const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));await new Promise(r=>setTimeout(r,30))};
 let checks=0; const check=(condition,message)=>{checks++;if(!condition)throw Error(message)};
 await wait(()=>document.querySelectorAll('.todo-card').length===3);
 const prefix='mcp__legal_terminal_jurisupport__';
 for(const [tool,label] of Object.entries({list_tasks:'할일 목록 확인',get_task:'할일 상세 확인',create_task:'할일 추가',create_task_from_source:'원문에서 할일 추가',update_task:'할일 수정',update_task_from_source:'원문에서 할일 수정',update_task_status:'할일 상태 변경',get_task_evidence_suggestions:'완료 근거 확인',get_case_closure_preview:'사건 종결 전 할일 검토'}))check(toolDisplayName(prefix+tool)===label,'Managed tool label '+tool);
 check(!toolStepDisplay({id:'x',title:'',toolName:prefix+'get_task',input:JSON.stringify({id:'opaque-task-id',caseId:'opaque-case-id'}),text:'opaque-task-id'}).arg,'Opaque identifiers stay out of collapsed tool row');
 check(toolStepDisplay({id:'x',title:'',toolName:prefix+'update_task_status',input:JSON.stringify({id:'opaque-task-id',status:'completed'})}).arg==='완료','Friendly status argument');
 const toolRow=document.querySelector('.agent-tool-row');check(toolRow.textContent.includes('할일 수정')&&!toolRow.textContent.includes('opaque-task-id'),'Friendly collapsed managed tool');toolRow.querySelector('button').click();await wait(()=>toolRow.querySelector('.agent-tool-details'));check(toolRow.textContent.includes('opaque-task-id')&&toolRow.textContent.includes('mcp__legal_terminal_jurisupport__update_task'),'Raw input remains expandable');toolRow.querySelector('button').click();
 check(!document.querySelector('.todo-patch-panel')&&!document.body.textContent.includes('패치 적용')&&!document.body.textContent.includes('할일 다시 만들기'),'Legacy JSON workflow removed');
 await click('오른쪽 에이전트로 정리');check(window.handoffs.at(-1).length===3&&window.handoffs.at(-1).every(row=>rows.includes(row)),'Full list passes exact source rows');

 const hearingMetric=(label)=>[...document.querySelectorAll('.todo-metric')].find(e=>e.querySelector('span').textContent===label).querySelector('strong').textContent;
 check(hearingMetric('오늘 기일')==='27','Complete today aggregate exceeds twenty');check(hearingMetric('앞으로 7일 기일')==='42','Complete seven-day aggregate exceeds twenty');
 window.setHearingState({summary:{todayCount:27,weekCount:42,fetchedAt:'2026-09-12T00:00:00Z'},error:'합성 기일 조회 실패'});await wait(()=>document.querySelector('.todo-summary').textContent.includes('이전 조회 결과입니다.'));check(hearingMetric('오늘 기일')==='27','Failed hearing refresh retains aggregate with stale warning');
 window.setHearingState({summary:null,error:'합성 기일 조회 실패'});await wait(()=>hearingMetric('오늘 기일')==='—');check(hearingMetric('앞으로 7일 기일')==='—','Missing hearing aggregate is not zero');
 window.setHearingState({summary:{todayCount:27,weekCount:42,fetchedAt:'2026-09-12T00:00:00Z'},error:''});await wait(()=>hearingMetric('오늘 기일')==='27');
 check(!window.calls.some(c=>c[0]==='list'),'Open snapshot must not be independently fetched');
 await click('기한 없음'); check(document.querySelectorAll('.todo-card').length===1,'Undated filter');await click('오른쪽 에이전트로 정리');check(window.handoffs.at(-1).length===1&&window.handoffs.at(-1)[0]===rows[1]&&!window.handoffs.at(-1)[0].caseId,'Filtered list handoff does not infer a case');
 await click('전체 열린 할일');
 const toggle=document.querySelector('.todo-group-toggle');toggle.click();await new Promise(r=>setTimeout(r,30));check(toggle.getAttribute('aria-expanded')==='false','Group collapse');toggle.click();await new Promise(r=>setTimeout(r,30));
 await input(document.querySelector('.dash-search'),'준비서면');check(document.querySelectorAll('.todo-card').length===1,'Local search');await input(document.querySelector('.dash-search'),'');
 let card=[...document.querySelectorAll('.todo-card')].find(c=>c.textContent.includes('준비서면 제출 확인'));await click('에이전트로 정리',card);check(window.handoffs.at(-1).length===1&&window.handoffs.at(-1)[0]===rows[0],'Per-row handoff passes only selected task');check(window.calls.length===0,'Handoff does not mutate tasks or open case workspace');await input(document.querySelector('.dash-search'),'없는 합성 항목');check(buttons('오른쪽 에이전트로 정리')[0].disabled,'Empty filtered list cannot hand off');await input(document.querySelector('.dash-search'),'');card=[...document.querySelectorAll('.todo-card')].find(c=>c.textContent.includes('준비서면 제출 확인'));await input(card.querySelector('input[placeholder="같은 산출물의 자식 할일"]'),'새 자식 단계');await click('자식 추가',card);check(window.calls.findLast(c=>c[0]==='create')[1].parentId==='parent'&&window.calls.findLast(c=>c[0]==='create')[1].caseId==='case-1','Direct child creation retains exact parent and case after legacy cleanup');
 await click('기한·재확인 변경',card);await input(card.querySelector('input[type=date]'),'2026-10-01');window.failUpdate=true;await click('저장',card);check(card.textContent.includes('합성 저장 실패'),'Mutation failure remains visible');window.failUpdate=false;await click('저장',card);
 check(window.calls.findLast(c=>c[0]==='update')[2].dueDate==='2026-10-01T05:30:45.123Z','KST time preserved');
 await click('완료',card);await wait(()=>document.querySelector('dialog select'));let dialog=document.querySelector('dialog');check(buttons('완료 확인',dialog)[0].disabled,'Must choose child disposition');await input(dialog.querySelector('select'),'keep');await click('완료 확인',dialog);check(window.calls.findLast(c=>c[0]==='complete')[2].childDispositions[0].action==='keep','Explicit child keep');
 const completed=window.calls.filter(c=>c[0]==='complete').length;await click('완료 근거 확인',card);await wait(()=>card.textContent.includes('제출 전 초안'));check(window.calls.filter(c=>c[0]==='complete').length===completed,'Evidence cannot auto complete');check(card.textContent.includes('일부 자료 조회 실패'),'Partial evidence warning remains visible');await click('원본 열기',card);check(window.calls.findLast(c=>c[0]==='open')[1]==='https://example.invalid/doc','Exact evidence source');await click('근거 확인',card);check(window.calls.findLast(c=>c[0]==='update')[2].evidence[0].status==='confirmed','Explicit evidence confirmation');check(window.calls.findLast(c=>c[0]==='update')[2].version===1,'Evidence merge sends its read version');check(window.calls.filter(c=>c[0]==='complete').length===completed,'Confirm evidence retains status');const localEvidence=[...card.querySelectorAll('.todo-evidence')].find(e=>e.textContent.includes('사건 폴더 문서'));await click('원본 열기',localEvidence);check(window.calls.findLast(c=>c[0]==='openFile')[1]==='/synthetic/cases/준비서면.pdf','Local evidence opens unchanged in viewer');const remoteEvidence=[...card.querySelectorAll('.todo-evidence')].find(e=>e.textContent.includes('원격 사건 문서'));await click('원본 열기',remoteEvidence);check(window.calls.findLast(c=>c[0]==='openFile')[1]==='ssh://test-host/cases/증거.pdf','SSH evidence opens unchanged in viewer');for(const [label,uri,expected] of fileCases){const evidence=[...card.querySelectorAll('.todo-evidence')].find(e=>e.querySelector('strong')?.textContent===label);const previous=window.calls.filter(c=>c[0]==='openFile').length;await click('원본 열기',evidence);if(expected===null)check(window.calls.filter(c=>c[0]==='openFile').length===previous,'Reject '+label);else check(window.calls.findLast(c=>c[0]==='openFile')[1]===expected,'Normalize '+label)}check(window.calls.filter(c=>c[0]==='open').length===1,'File evidence never opens as web URL');check(window.calls.filter(c=>c[0]==='complete').length===completed,'Opening file evidence retains status');
 await click('사건 관리·메모');await wait(()=>document.querySelector('dialog'));dialog=document.querySelector('dialog');await click('사건 메모',dialog);await wait(()=>dialog.querySelector('textarea'));await input(dialog.querySelector('textarea'),'수정한 사건 메모');await click('저장',dialog);check(window.calls.findLast(c=>c[0]==='update')[2].title==='수정한 사건 메모','Memo update');check(window.calls.findLast(c=>c[0]==='update')[2].version===7,'Memo update preserves version');await click('종결·수임 상태',dialog);check(buttons('검토 내용과 상태 저장',dialog)[0].disabled,'Case closure requires every disposition');let choice=dialog.querySelector('.todo-disposition select');await input(choice,'transfer');await input(dialog.querySelector('.todo-case-task label:nth-child(2) select'),'case-2');await input(choice,'keep');for(const select of [...dialog.querySelectorAll('.todo-disposition select')])await input(select,'keep');await click('검토 내용과 상태 저장',dialog);check(window.calls.findLast(c=>c[0]==='caseStatus')[4]===3,'Case version preserved');check(!window.calls.findLast(c=>c[0]==='caseStatus')[3][0].targetCaseId,'Transfer target cleared on keep');await click('사건 관리·메모');await wait(()=>document.querySelector('dialog'));window.dispatchEvent(new Event('lt-js-token-updated'));await wait(()=>!document.querySelector('dialog'));check(!document.querySelector('dialog'),'Account reset closes old review');
 return {checks,calls:window.calls.length};
};
`
await build({ stdin: { contents: source, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: path.join(temp, 'ui.js'), platform: 'browser', loader: { '.ttf': 'file' }, jsx: 'automatic' })
await fs.writeFile(path.join(temp, 'index.html'), '<html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>')
await fs.writeFile(path.join(temp, 'main.cjs'), `const {app,BrowserWindow}=require('electron');const fs=require('fs');app.whenReady().then(async()=>{const w=new BrowserWindow({width:1280,height:1000,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});try{await w.loadFile(${JSON.stringify(path.join(temp,'index.html'))});let result;for(let i=0;i<100;i++){if(await w.webContents.executeJavaScript('typeof window.uiCheck === "function"'))break;await new Promise(r=>setTimeout(r,20))}result=await w.webContents.executeJavaScript('window.uiCheck()');fs.writeFileSync(${JSON.stringify(screenshot)},(await w.webContents.capturePage()).toPNG());w.setSize(500,900);await new Promise(r=>setTimeout(r,150));if(await w.webContents.executeJavaScript('document.documentElement.scrollWidth > window.innerWidth'))throw Error('Narrow viewport horizontal overflow');fs.writeFileSync(${JSON.stringify(screenshot.replace('.png','-narrow.png'))},(await w.webContents.capturePage()).toPNG());console.log('TODO_UI_RESULT '+JSON.stringify(result));app.exit(0)}catch(e){console.error(e);fs.writeFileSync(${JSON.stringify(screenshot)},(await w.webContents.capturePage()).toPNG());app.exit(1)}})`)
const electron = process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'node_modules/electron/dist/electron')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
try {
 const result = await new Promise((resolve, reject) => {const child=spawn(electron,[path.join(temp,'main.cjs'),`--user-data-dir=${path.join(temp,'profile')}`],{env});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);child.on('error',reject);child.on('exit',code=>resolve({code,output}));setTimeout(()=>{child.kill();reject(new Error('UI test timeout'))},30000).unref()})
 assert.equal(result.code,0,result.output)
 console.log(result.output.split('\n').filter(line=>line.includes('TODO_UI_RESULT')).join('\n'))
 console.log(`Screenshot: ${screenshot}`)
} finally { await fs.rm(temp,{recursive:true,force:true}) }
