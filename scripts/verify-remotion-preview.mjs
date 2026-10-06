import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {spawn,execFileSync} from 'node:child_process'
import net from 'node:net'
import ssh2 from 'ssh2'
const {Server,utils}=ssh2
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {build} from 'esbuild'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const fixture=path.join(root,'.omx/remotion-fixture')
await fs.mkdir(path.join(fixture,'.legal-terminal'),{recursive:true})
await fs.mkdir(path.join(fixture,'src'),{recursive:true})
await fs.mkdir(path.join(fixture,'public'),{recursive:true})
if(process.argv.includes('--install-fixture')){
 await fs.writeFile(path.join(fixture,'package.json'),JSON.stringify({private:true,name:'legal-terminal-remotion-verification',version:'1.0.0'}))
 await new Promise((resolve,reject)=>{const child=spawn(process.platform==='win32'?'npm.cmd':'npm',['install','--prefix',fixture,'--no-audit','--no-fund','--ignore-scripts','--save-exact','remotion@4.0.409','@remotion/player@4.0.409','@remotion/bundler@4.0.409','react@18.3.1','react-dom@18.3.1'],{stdio:'inherit',shell:process.platform==='win32'});child.on('error',reject);child.on('exit',code=>code?reject(Error('Fixture install failed')):resolve())})
}
try{createRequire(path.join(fixture,'package.json')).resolve('@remotion/bundler')}catch{throw Error('Install only the synthetic fixture packages with: node scripts/verify-remotion-preview.mjs --install-fixture')}
const config={component:'src/Composition.tsx',exportName:'Fixture',compositionId:'Fixture',width:360,height:640,fps:30,durationInFrames:90,props:{label:'합성 쇼츠'}}
await fs.writeFile(path.join(fixture,'.legal-terminal/remotion.json'),JSON.stringify(config))
const wav=Buffer.alloc(44+16000*3*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);for(let i=0;i<16000*3;i++)wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/16000)*2000),44+i*2);await fs.writeFile(path.join(fixture,'public/tone.wav'),wav)
await fs.writeFile(path.join(fixture,'public/test.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#fff"/></svg>')
execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=360x640:r=30:d=1','-f','lavfi','-i','color=c=red:s=360x640:r=30:d=2','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',path.join(fixture,'public/delayed.mp4')]);
await fs.writeFile(path.join(fixture,'src/Composition.tsx'),`import React from 'react';import {AbsoluteFill,Audio,Video,Img,staticFile,useCurrentFrame} from 'remotion';export const Fixture=({label='합성 쇼츠'})=>{const frame=useCurrentFrame();return <AbsoluteFill style={{background:frame<30?'#153c75':'#802843',color:'white',alignItems:'center',justifyContent:'center',fontFamily:'Arial',fontSize:42}}><Video src={staticFile('delayed.mp4')} style={{position:'absolute',inset:0,width:'100%',height:'100%',zIndex:0}}/><Audio src={staticFile('tone.wav')}/><div style={{position:'relative',zIndex:1,textAlign:'center'}}><strong>{label}</strong><p>Frame {frame}</p><span>검증용 · Test</span><Img src={staticFile('test.svg')} style={{width:24,height:24}}/></div></AbsoluteFill>};`)
const runtimeSource=await fs.readFile(path.join(root,'src/main/remotion-preview/runtime.cjs.txt'),'utf8');const playerSource=await fs.readFile(path.join(root,'src/main/remotion-preview/player.tsx.txt'),'utf8');
const early=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',runtimeSource]);let output='';child.stdout.on('data',data=>output+=data);child.stderr.resume();child.on('error',reject);child.on('exit',code=>resolve({code,output}));child.stdin.end(JSON.stringify({projectDir:fixture,token:'early-close',playerSource})+'\n')});assert.equal(early.code,0);assert.ok(!early.output.includes('ready'));assert.ok(!(await fs.readdir(fixture)).some(name=>name.startsWith('.lt-remotion-preview-')),'Immediate runtime EOF leaves no bundle');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'lt-remotion-test-'))
const screenshot=path.join(root,'.omx/screenshots/remotion-preview.png')
await fs.mkdir(path.dirname(screenshot),{recursive:true})
// Real OpenSSH exec and forwarding against a loopback SSH server with throwaway keys/known_hosts.
for(const name of ['host','client'])execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',path.join(temp,name)],{stdio:'ignore'})
const clientKey=utils.parseKey(await fs.readFile(path.join(temp,'client')))
const connections=new Set();const remoteChildren=new Set();let execCount=0;let forwardCount=0
const sshServer=new Server({hostKeys:[await fs.readFile(path.join(temp,'host'))]},client=>{
 connections.add(client);client.on('error',()=>{});client.on('close',()=>connections.delete(client))
 client.on('authentication',ctx=>{if(ctx.method==='publickey'&&ctx.username==='test'&&ctx.key.data.equals(clientKey.getPublicSSH())&&(!ctx.signature||clientKey.verify(ctx.blob,ctx.signature,ctx.hashAlgo)===true))ctx.accept();else ctx.reject()})
 client.on('ready',()=>{
  client.on('session',(accept)=>{const session=accept();session.on('exec',(accept,_reject,info)=>{
   execCount++;const channel=accept();const child=spawn('/bin/sh',['-c',info.command],{env:process.env});remoteChildren.add(child);child.stdin.on('error',()=>{});channel.on('error',()=>{});channel.pipe(child.stdin);child.stdout.pipe(channel,{end:false});child.stderr.pipe(channel.stderr,{end:false});channel.once('close',()=>{child.stdin.end();setTimeout(()=>{if(child.exitCode===null)child.kill()},2000).unref()});child.on('close',code=>{remoteChildren.delete(child);channel.exit(code??1);channel.end()})
  })})
  client.on('tcpip',(accept,reject,info)=>{if(info.destIP!=='127.0.0.1')return reject();forwardCount++;const socket=net.connect(info.destPort,info.destIP);socket.once('error',()=>reject());socket.once('connect',()=>{const channel=accept();channel.on('error',()=>socket.destroy());socket.on('error',()=>channel.destroy());channel.pipe(socket).pipe(channel);channel.on('close',()=>socket.destroy())})})
 })
})
await new Promise(resolve=>sshServer.listen(0,'127.0.0.1',resolve))
const sshPort=sshServer.address().port
const spawnShim=`const real=require('node:child_process');export const spawn=(command,args,opts)=>{if(command==='ssh'){globalThis.sshCalls.push(args);return real.spawn(command,['-o',${JSON.stringify('UserKnownHostsFile='+path.join(temp,'known_hosts'))},...args],opts)}return real.spawn(command,args,opts)};`
await build({entryPoints:[path.join(root,'src/main/remotionPreview.ts')],outfile:path.join(temp,'preview.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],plugins:[{name:'test-dependencies',setup(b){
 b.onResolve({filter:/\?raw$/},args=>({path:path.resolve(args.resolveDir,args.path.slice(0,-4)),namespace:'raw'}));b.onLoad({filter:/.*/,namespace:'raw'},async args=>({contents:await fs.readFile(args.path,'utf8'),loader:'text'}));
 b.onResolve({filter:/^\.\/settings$/},()=>({path:'settings',namespace:'mock'}));b.onResolve({filter:/^\.\/remoteFs$/},()=>({path:'remoteFs',namespace:'mock'}));b.onResolve({filter:/^node:child_process$/},args=>args.importer.endsWith('remotionPreview.ts')?{path:'spawn',namespace:'mock'}:null);
 b.onLoad({filter:/.*/,namespace:'mock'},args=>({loader:'js',contents:args.path==='settings'?`export const getSettings=async()=>({sshProfiles:[{id:'fixture',host:'127.0.0.1',port:${sshPort},identityFile:${JSON.stringify(path.join(temp,'client'))},user:'test'}]})`:args.path==='remoteFs'?`export const isRemote=s=>s.startsWith('ssh://');export const parseRemote=s=>({profileId:s.slice(6).split('/')[0],path:s.slice(s.indexOf('/',6))})`:spawnShim}))
}}]})
await fs.writeFile(path.join(temp,'main.cjs'),`
const {app,BrowserWindow,nativeImage}=require('electron');const assert=require('assert/strict');const fs=require('fs/promises');const path=require('path');const {openRemotionPreview,closeRemotionPreview,disposeRemotionPreviews,validRemotionSelection}=require('./preview.cjs');globalThis.sshCalls=[];app.on('web-contents-created',(_event,contents)=>contents.session.webRequest.onBeforeRequest({urls:['*://*/delayed.mp4*']},(_details,callback)=>setTimeout(()=>callback({}),2500)));app.whenReady().then(async()=>{let checks=0;const check=(value,label)=>{checks++;assert.ok(value,label)};const wait=async(fn)=>{for(let n=0;n<200;n++){if(await fn())return;await new Promise(r=>setTimeout(r,50))}throw Error('Timeout '+fn)};const owner=new BrowserWindow({show:false});const selections=[];try{
 const fixture=${JSON.stringify(fixture)};
 const open=async(projectDir)=>{const result=await openRemotionPreview({projectDir,frame:37},owner,s=>selections.push(s));check(result.ok,result.error);const win=BrowserWindow.getAllWindows().find(w=>w!==owner);win.webContents.on('console-message',(_e,...args)=>console.log('PREVIEW_CONSOLE',...args));await wait(()=>win.webContents.executeJavaScript('document.querySelector(".stage")?.innerText.includes("Frame 37")'));return{result,win}};
 const local=await open(fixture);let win=local.win;
 check(await win.webContents.executeJavaScript('typeof window.lt === "undefined" && typeof require === "undefined" && typeof process === "undefined"'),'Sandbox has no Node or app preload');
 check(win.webContents.getLastWebPreferences().sandbox===true,'Sandbox preference');
 check(!win.webContents.getLastWebPreferences().preload,'No preload');
 await wait(()=>win.webContents.executeJavaScript('[...document.querySelectorAll("audio")].some(a=>a.src.includes("tone.wav") && a.readyState>=2)'));check(true,'Audio decoded from public asset');
 const localUrl=win.webContents.getURL();check(new URL(localUrl).hostname==='127.0.0.1','Loopback binding');
 check((await fetch(new URL('/',localUrl))).status===404,'Tokenless request rejected');
 check((await fetch(new URL('selection',localUrl),{method:'POST',headers:{Origin:'https://evil.invalid','X-LT-Preview':new URL(localUrl).pathname.split('/')[1]}})).status===403,'Cross-origin selection rejected');
 await win.webContents.executeJavaScript('window.location.href="https://example.invalid/escape"');await new Promise(r=>setTimeout(r,100));check(win.webContents.getURL()===localUrl,'Navigation blocked');
 await win.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(b=>b.textContent==="이 장면 AI에게 질문").click()');await wait(()=>selections.length===1);
 check(selections[0].frame===37&&selections[0].fps===30&&selections[0].startFrame===37,'Selected frame matches Player');check(selections[0].sourcePath.endsWith('/src/Composition.tsx'),'Source component retained');
 const image=nativeImage.createFromDataURL(selections[0].captureDataUrl);check(!image.isEmpty(),'Actual captured image');const bitmap=image.toBitmap();const pixel=bitmap.subarray(4*(10*image.getSize().width+10));check(pixel[2]>200&&pixel[0]<80,'Frame 37 image matches red scene (display color profile tolerated)');await fs.writeFile(${JSON.stringify(screenshot)},(await win.webContents.capturePage()).toPNG());
 const seek=async(frame)=>{await wait(()=>win.webContents.executeJavaScript('!document.querySelector("fieldset").disabled'));await win.webContents.executeJavaScript('(()=>{const input=document.querySelector("input[aria-label=프레임]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,'+frame+');input.dispatchEvent(new Event("input",{bubbles:true}))})()');await wait(()=>win.webContents.executeJavaScript('document.querySelector(".stage")?.innerText.includes("Frame '+frame+'")'))};
 await seek(5);await win.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(b=>b.textContent==="이 장면 AI에게 질문").click()');await wait(()=>selections.length===2);check(selections[1].frame===5,'Video seek selection reports frame 5');const blue=nativeImage.createFromDataURL(selections[1].captureDataUrl);const bluePixel=blue.toBitmap().subarray(4*(10*blue.getSize().width+10));check(bluePixel[0]>200&&bluePixel[2]<100,'Decoded video frame matches blue scene after seek');await seek(37);
 await win.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(b=>b.textContent==="여기부터").click()');await win.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(b=>b.textContent==="다음 프레임").click()');await wait(()=>win.webContents.executeJavaScript('document.querySelector(".stage")?.innerText.includes("Frame 38")'));await win.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(b=>b.textContent==="여기까지").click()');await win.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(b=>b.textContent==="이 장면 AI에게 질문").click()');await wait(()=>selections.length===3);check(selections[2].startFrame===37&&selections[2].endFrame===39&&selections[2].frame===38,'Frame interval uses exclusive end');
 const reused=await openRemotionPreview({projectDir:fixture},owner,s=>selections.push(s));check(reused.sessionId===local.result.sessionId&&BrowserWindow.getAllWindows().length===2,'Same owner reuses preview');
 await seek(5);
 await fs.writeFile(path.join(fixture,'.legal-terminal/remotion.json'),JSON.stringify({...${JSON.stringify(config)},props:{label:'수정한 쇼츠'}}));
 await win.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(b=>b.textContent==="소스 변경 불러오기").click()');await wait(()=>win.webContents.executeJavaScript('document.querySelector(".stage")?.innerText.includes("수정한 쇼츠")'));check(await win.webContents.executeJavaScript('document.querySelector(".stage")?.innerText.includes("Frame 5")'),'Rebuild preserves reviewed frame 5');
 await win.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(b=>b.textContent==="이 장면 AI에게 질문").click()');await wait(()=>selections.length===4);check(selections[0].version!==selections[3].version,'Bridge change gets new code version');
 closeRemotionPreview(local.result.sessionId,999999);check(!win.isDestroyed(),'Other owner cannot close');closeRemotionPreview(local.result.sessionId,owner.webContents.id);check(win.isDestroyed(),'Owning close works');
 await wait(async()=>!(await fs.readdir(fixture)).some(name=>name.startsWith('.lt-remotion-preview-')));check(true,'Local bundle removed');await wait(async()=>{try{await fetch(localUrl);return false}catch{return true}});check(true,'Local port closed');
 const remote=await open('ssh://fixture'+fixture);win=remote.win;await win.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(b=>b.textContent==="이 장면 AI에게 질문").click()');await wait(()=>selections.length===5);check(selections[4].sourcePath.startsWith('ssh://fixture/'),'Remote source preserved');check(globalThis.sshCalls.length===2,'Remote runtime plus forwarding SSH process');const tunnel=globalThis.sshCalls.find(args=>args.includes('-N'));check(/^127\\.0\\.0\\.1:\\d+:127\\.0\\.0\\.1:\\d+$/.test(tunnel[tunnel.indexOf('-L')+1]),'Both forwarding addresses loopback');check(tunnel.includes('ExitOnForwardFailure=yes')&&!tunnel.includes('StrictHostKeyChecking=no'),'Tunnel failure and host trust retained');disposeRemotionPreviews();await wait(async()=>!(await fs.readdir(fixture)).some(name=>name.startsWith('.lt-remotion-preview-')));check(true,'Remote EOF removes bundle');
 const message={config:${JSON.stringify(config)},component:'src/Composition.tsx',version:'a'.repeat(64),selection:{frame:37,startFrame:37,endFrame:38,rect:{x:0,y:0,width:300,height:500}}};check(validRemotionSelection(message),'Valid frame metadata accepted');for(const selection of [{...message.selection,frame:NaN},{...message.selection,frame:90},{...message.selection,endFrame:37},{...message.selection,rect:{x:0,y:0,width:Infinity,height:5}}])check(!validRemotionSelection({...message,selection}),'Invalid metadata rejected');
 const outside=await openRemotionPreview({projectDir:fixture,entryPoint:'../outside.json'},owner,()=>{});check(!outside.ok&&outside.error.includes('프로젝트 폴더'),'Outside bridge rejected');await wait(async()=>!(await fs.readdir(fixture)).some(name=>name.startsWith('.lt-remotion-preview-')));check(true,'Outside bridge leaves no temp folder');
 const pending=openRemotionPreview({projectDir:fixture},owner,()=>{});await wait(()=>BrowserWindow.getAllWindows().some(w=>w!==owner));BrowserWindow.getAllWindows().find(w=>w!==owner).destroy();const canceled=await pending;check(!canceled.ok,'Immediate preview close cancels startup');await wait(async()=>!(await fs.readdir(fixture)).some(name=>name.startsWith('.lt-remotion-preview-')));check(true,'Immediate close leaves no temp folder');
 const missing=await openRemotionPreview({projectDir:fixture,entryPoint:'.legal-terminal/missing.json'},owner,()=>{});check(!missing.ok&&missing.error.includes('설정'),'Missing bridge is actionable');await wait(async()=>!(await fs.readdir(fixture)).some(name=>name.startsWith('.lt-remotion-preview-')));check(true,'Failed startup cleans bundle');
 console.log('REMOTION_PREVIEW_RESULT '+JSON.stringify({checks,local:true,mockedSsh:false,realLoopbackSsh:true,platform:process.platform,screenshot:${JSON.stringify(screenshot)}}));app.exit(0)
 }catch(error){console.error(error);disposeRemotionPreviews();app.exit(1)}})
`)
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
try{
 const result=await new Promise((resolve,reject)=>{const child=spawn(createRequire(import.meta.url)('electron'),[path.join(temp,'main.cjs'),'--user-data-dir='+path.join(temp,'profile')],{env});let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.on('error',reject);child.on('exit',code=>resolve({code,output}));const timer=setTimeout(()=>{child.kill();reject(Error('Remotion UI verification timed out\n'+output))},180000);timer.unref();child.on('exit',()=>clearTimeout(timer))});assert.equal(result.code,0,result.output);assert.ok(execCount>=1&&forwardCount>=1,'Real SSH exec and forwarding were exercised');console.log(result.output.split('\n').filter(line=>line.includes('REMOTION_PREVIEW_RESULT')).join('\n'))
}finally{for(const client of connections)client.end();for(const child of remoteChildren)child.kill();await new Promise(resolve=>sshServer.close(resolve));await fs.rm(temp,{recursive:true,force:true})}
