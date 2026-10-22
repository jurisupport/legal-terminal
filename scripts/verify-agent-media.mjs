import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-agent-media-'))
  try {
    await fs.copyFile(path.join(repo, 'scripts/fixtures/media-review/red.mp4'), path.join(temp, 'sample.mp4'))
    await fs.writeFile(path.join(temp, 'sample.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQyW4DAAHMARYGRxnIAAAAAElFTkSuQmCC', 'base64'))
    const urls = Object.fromEntries(['sample.mp4', 'sample.png'].map(name => [name, pathToFileURL(path.join(temp, name)).href]))
    await build({ stdin: { resolveDir: repo, loader: 'tsx', contents: `
      import React from 'react'
      import {createRoot} from 'react-dom/client'
      import {MarkdownMessage} from './src/renderer/src/agent/MarkdownMessage'
      import {AgentAttachmentMedia} from './src/renderer/src/agent/AgentMediaPreview'
      import * as resolver from './src/renderer/src/agent/mediaReferences'
      const urls = ${JSON.stringify(urls)}
      const state = window.test = { resolver, opens: [], cancels: [], releases: [], external: [], originals: [], copies: [], observers: [], mode: '', pending: null, inView: true, listeners: new Set() }
      window.IntersectionObserver = class {
        constructor(callback) { this.callback=callback; state.observers.push(this) }
        observe() { this.callback([{isIntersecting:state.inView}]) }
        disconnect() { state.observers=state.observers.filter(item=>item!==this) }
      }
      state.setInView = value => {state.inView=value;state.observers.forEach(item=>item.callback([{isIntersecting:value}]))}
      const fileSize = source => source.includes('huge') ? 30*1024*1024 : source.includes('large') ? 3*1024*1024 : 1024
      let token = 0
      const make = input => ({sourcePath:input.path,versionId:input.versionId??'v1',size:fileSize(input.path),mimeType:input.path.endsWith('.png')?'image/png':'video/mp4',mtimeMs:1,createdAt:1,token:'token-'+(++token),url:urls[input.path.endsWith('.png')?'sample.png':'sample.mp4']})
      window.lt = {
        fs:{stat:async path=>({ok:true,size:fileSize(path),isDir:false})},
        app:{openExternal:async url=>{state.external.push(url)}},
        media:{
          open:async input=>{state.opens.push(input);if(input.versionId==='expired')throw Error('인용한 리뷰 버전이 만료되었습니다.');if(state.mode==='pending')return await new Promise(resolve=>{state.pending=()=>resolve(make(input))});return make(input)},
          release:async token=>{state.releases.push(token)},cancel:async id=>{state.cancels.push(id)},
          versions:async path=>[{versionId:'v1',size:fileSize(path)}],
          onProgress:callback=>{state.listeners.add(callback);return()=>state.listeners.delete(callback)}
        }
      }
      const root=createRoot(document.getElementById('root'))
      const context={cwd:'/work',remote:true,profileId:'server'}
      state.render = props => root.render(props.attachments
        ? <AgentAttachmentMedia attachments={props.attachments} context={context} active={props.active??true} onOpenFile={(...args)=>state.originals.push(args)} onOpenSource={attachment=>state.originals.push(attachment)}/>
        : <MarkdownMessage text={props.text??state.text} streaming={props.streaming} active={props.active??true} mediaContext={context} onCopyCode={async code=>{state.copies.push(code);return true}} onOpenFile={(...args)=>state.originals.push(args)}/>)
      state.unmount = () => root.unmount()
      state.text='작업 결과를 확인해 주세요.\\n\\n![현장 사진](./sample.png)\\n\\n[검토 영상](./sample.mp4) · [공식 문서](https://example.com/docs)\\n\\n'+'\x60\x60\x60text\\n![코드 속 이미지](/ignore.png)\\n\x60\x60\x60'
      state.render({streaming:true})
    ` }, bundle: true, outfile: path.join(temp, 'harness.js'), jsx: 'automatic', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })
    await fs.writeFile(path.join(temp, 'index.html'), '<html><head><meta charset="utf-8"><link rel="stylesheet" href="harness.css"><style>:root{--bg:#1e1e1e;--bg-alt:#252526;--border:#444;--fg:#ddd;--fg-muted:#aaa}*{box-sizing:border-box}body{margin:0;background:#1e1e1e;color:#ddd;font:14px system-ui,sans-serif}#root{max-width:580px;margin:20px auto}a{color:#8dcbea}pre{padding:10px;background:#151515;white-space:pre-wrap}.agent-code-toolbar{display:flex;gap:10px;align-items:center}button{color:#ddd;background:#333;border:1px solid #555;border-radius:4px}</style></head><body><div id="root"></div><script src="harness.js"></script></body></html>')
    const { default: electron } = await import('electron')
    const env = { ...process.env, LT_AGENT_MEDIA_DIR: temp }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electron, [fileURLToPath(import.meta.url)], { cwd: repo, env, stdio: 'inherit' })
    const timeout = setTimeout(() => child.kill(), 90_000)
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    clearTimeout(timeout)
    assert.equal(code, 0, 'Agent media checks failed')
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
} else {
  void (async () => {
    const { app, BrowserWindow } = await import('electron')
    const temp = process.env.LT_AGENT_MEDIA_DIR
    app.setPath('userData', path.join(temp, 'profile'))
    await app.whenReady()
    const window = new BrowserWindow({ width: 760, height: 1060, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    const run = async fn => {
      const result = await window.webContents.executeJavaScript(`(async () => {
        try { return {ok:true,value:await (${fn.toString()})()} }
        catch(error) { return {ok:false,error:{name:error?.name,message:error?.message??String(error),stack:error?.stack}} }
      })()`)
      if (!result.ok) {
        const error = new Error(result.error.message)
        error.name = result.error.name ?? 'RendererError'
        if (result.error.stack) error.stack = result.error.stack
        throw error
      }
      return result.value
    }
    try {
      await window.loadFile(path.join(temp, 'index.html'))
      const cpuRate = Number(process.env.LT_AGENT_MEDIA_CPU_THROTTLE ?? 1)
      if (cpuRate > 1) {
        window.webContents.debugger.attach('1.3')
        await window.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: cpuRate })
      }
      await run(async () => {
        window.waitFor = async condition => { const end=Date.now()+6000;while(!condition()){if(Date.now()>end)throw Error('Timeout: '+condition);await new Promise(resolve=>setTimeout(resolve,20))} }
        window.check = (condition,message)=>{if(!condition)throw Error(message)}
        window.button = label => [...document.querySelectorAll('button')].find(item=>item.textContent===label)
        const {resolveAgentMediaPath:resolve,attachmentMediaReference:attachment}=test.resolver
        const local={cwd:'/local/work'}, remote={cwd:'/work',remote:true,profileId:'server'}
        check(resolve('../clip.mp4',remote)==='ssh://server/clip.mp4','relative remote path')
        check(resolve('/tmp/clip.mp4',remote)==='ssh://server/tmp/clip.mp4','absolute remote path')
        check(resolve('ssh://other/tmp/image.png',remote)==='ssh://other/tmp/image.png','explicit other profile preserved')
        check(resolve('./image.png',local)==='/local/work/image.png','local relative path')
        check(resolve('C:\\media\\image.png',local)==='C:/media/image.png','Windows drive')
        check(resolve('file:///C:/my%20image.png',local)==='C:/my image.png','Windows file URL')
        check(resolve('file:///tmp/my%20image.png',remote)==='ssh://server/tmp/my image.png','file URL in remote session')
        check(resolve('/tmp/my%20image.png',local,true)==='/tmp/my image.png','encoded markdown local path')
        check(resolve('ssh://server/tmp/my%20image.png',remote,true)==='ssh://server/tmp/my image.png','encoded markdown remote path')
        for(const invalid of ['https://example.com/a.png','data:image/png;base64,a','javascript:alert(1)','ftp://host/a.png','file://host/a.png','file:///tmp/%00x.png','ssh://user:pass@host/a.png','ssh:///tmp/a.png','ssh://bad profile/a.png','file:///bad%zz.png'])check(resolve(invalid,remote)===undefined,'reject unsafe source '+invalid)
        check(attachment({kind:'file',label:'local',path:'/tmp/local.png',origin:'local'},remote).path==='/tmp/local.png','local-origin attachment stays local')
        check(attachment({kind:'file',label:'remote',path:'/tmp/remote.png',origin:'remote'},remote).path==='ssh://server/tmp/remote.png','same-server attachment mapped')
        check(attachment({kind:'file',label:'literal',path:'/tmp/a%20b.png',origin:'local'},remote).path==='/tmp/a%20b.png','literal attachment name not URL decoded')
        check(attachment({kind:'file',label:'source',path:'/wrong.png',source:{path:'ssh://other/right.png'}},remote).path==='ssh://other/right.png','explicit source path preferred')
        const remotion=attachment({kind:'media-range',label:'프레임',media:{sourcePath:'ssh://server/render.mp4',versionId:'remotion-v1',time:1,compositionId:'Main'},source:{path:'ssh://server/frame.png'}},remote)
        check(remotion.path==='ssh://server/frame.png'&&remotion.kind==='image'&&!remotion.selection,'Remotion uses captured frame without passing render version as media-cache version')
        await waitFor(()=>document.querySelector('.streaming'))
        check(test.opens.length===0&&!document.querySelector('.agent-media-preview'),'streamed text does not download or remount previews')
        test.render({})
        await waitFor(()=>document.querySelector('.agent-media-preview img')?.naturalWidth>0)
        check(document.querySelectorAll('.agent-media-preview').length===2,'markdown image and link both become cards; code is ignored')
        check(test.opens.length===1&&test.opens[0].maxBytes===2*1024*1024,'only small image auto-loads with backend cap')
        check(document.querySelector('[data-media-path$="sample.mp4"]').textContent.includes('원격 파일 전체'),'remote full download notice')
        document.querySelector('a[href="https://example.com/docs"]').click()
        check(test.external[0]==='https://example.com/docs','external link preserved')
        document.querySelector('.agent-code-copy-btn').click()
        await waitFor(()=>test.copies.length===1)
        check(test.copies[0].includes('![코드 속 이미지](/ignore.png)'),'code copy remains unchanged')
        button('미리보기 불러오기').click()
        await waitFor(()=>document.querySelector('video')?.readyState>=2)
        check(document.querySelector('video').paused,'no autoplay')
        await document.querySelector('video').play()
        test.render({active:false})
        await waitFor(()=>document.querySelector('video').paused)
        const calls=test.opens.length
        test.render({active:true})
        await new Promise(resolve=>setTimeout(resolve,50))
        check(test.opens.length===calls&&document.querySelector('video').paused,'reactivation preserves snapshot without resuming playback')
      })
      const screenshot = path.join(repo, 'output/playwright/agent-media/inline-media.png')
      await fs.mkdir(path.dirname(screenshot), { recursive: true })
      await fs.writeFile(screenshot, (await window.webContents.capturePage()).toPNG())
      await run(async () => {
        test.render({text:'인용: `output/clip.mp4`와 `/tmp/my%20image.png`'})
        await waitFor(()=>document.querySelector('[data-media-path="ssh://server/tmp/my%20image.png"] img')?.naturalWidth>0)
        check(document.querySelectorAll('.agent-media-preview').length===2&&document.querySelector('[data-media-path="ssh://server/work/output/clip.mp4"]'),'inline code file references become cards')
        test.render({text:'![큰 이미지](/large.png)\\n\\n![초대형 이미지](/huge.png)'})
        await waitFor(()=>document.querySelector('[data-media-path$="huge.png"]')?.textContent.includes('30.0 MB'))
        const count=test.opens.length
        await new Promise(resolve=>setTimeout(resolve,50))
        check(test.opens.length===count,'large images do not auto-download')
        const large=document.querySelector('[data-media-path$="large.png"]')
        large.querySelector('button').click()
        await waitFor(()=>large.querySelector('img')?.naturalWidth>0)
        check(test.opens.at(-1).maxBytes===25*1024*1024,'manual image load bounded')
        check(document.querySelector('[data-media-path$="huge.png"] button').disabled,'over-limit image offers original only')
        test.setInView(false)
        test.render({text:'![화면 밖](/offscreen.png)'})
        await waitFor(()=>document.querySelector('[data-media-path$="offscreen.png"]'))
        const offscreen=test.opens.length
        await new Promise(resolve=>setTimeout(resolve,50))
        check(test.opens.length===offscreen,'offscreen image does not transfer')
        test.setInView(true)
        await waitFor(()=>document.querySelector('img')?.naturalWidth>0)
        const selection={sourcePath:'ssh://server/video.mp4',versionId:'v1',time:.5,start:.3,end:.8}
        test.quote={kind:'media-range',label:'선택한 장면',path:'/wrong.mp4',origin:'remote',media:selection,source:{path:selection.sourcePath}}
        test.render({attachments:[test.quote]})
        await waitFor(()=>document.querySelector('[data-media-path="ssh://server/video.mp4"]'))
        const quoteCalls=test.opens.length
        await new Promise(resolve=>setTimeout(resolve,50))
        check(test.opens.length===quoteCalls,'quoted video still requires click')
        button('원본 열기').click()
        check(test.originals.at(-1).media.versionId==='v1','original quote action preserved')
        button('미리보기 불러오기').click()
        await waitFor(()=>document.querySelector('video')?.readyState>=2&&Math.abs(document.querySelector('video').currentTime-.5)<.02)
        check(test.opens.at(-1).versionId==='v1'&&test.opens.at(-1).path===selection.sourcePath,'quoted version and source are exact')
        const video=document.querySelector('video')
        video.currentTime=1.5
        const playback=video.play()
        check(video.seeking,'outside-range playback begins with a pending seek')
        // A queued timeupdate may precede onPlay's reset to the selected start.
        video.dispatchEvent(new Event('timeupdate'))
        await playback
        await waitFor(()=>video.currentTime<.8)
        await waitFor(()=>video.paused)
        check(Math.abs(video.currentTime-.8)<.02,'selected range stops at quoted end')
        test.render({attachments:[{...test.quote,media:{...selection,time:1,start:.9,end:1.5}}]})
        await waitFor(()=>!document.querySelector('video'))
        button('미리보기 불러오기').click()
        await waitFor(()=>Math.abs(document.querySelector('video')?.currentTime-1)<.02)
        test.render({attachments:[{...test.quote,media:{...selection,versionId:'expired'}}]})
        await waitFor(()=>!document.querySelector('video'))
        button('미리보기 불러오기').click()
        await waitFor(()=>document.querySelector('[role="alert"]')?.textContent.includes('만료'))
        check(test.opens.at(-1).versionId==='expired'&&!document.querySelector('video'),'expired quote never switches to latest')
        test.mode='pending'
        test.render({text:'[취소할 영상](/pending.mp4)'})
        await waitFor(()=>document.querySelector('[data-media-path$="pending.mp4"]'))
        button('미리보기 불러오기').click()
        await waitFor(()=>test.pending)
        const request=test.opens.at(-1).requestId
        test.listeners.forEach(listener=>listener({requestId:request,downloadedBytes:50,totalBytes:100}))
        await waitFor(()=>document.querySelector('progress')?.value===50)
        test.render({text:'다음 메시지'})
        await waitFor(()=>test.cancels.includes(request))
        const releaseCount=test.releases.length
        test.pending()
        await waitFor(()=>test.releases.length>releaseCount)
        check(!document.querySelector('video'),'late canceled result does not mount')
        test.unmount()
        check(test.listeners.size===0,'subscriptions released')
      })
      console.log('agent media: path/origin safety, markdown images+links, streaming stability, viewport and size limits, delayed video, quote revisions/ranges, hidden pause, progress/cancel and stale-token release passed')
      app.exit(0)
    } catch (error) {
      console.error(error.stack ?? String(error))
      const failurePath = path.join(repo, 'output/playwright/agent-media/failure')
      await fs.mkdir(path.dirname(failurePath), { recursive: true })
      try {
        await fs.writeFile(`${failurePath}.png`, (await window.webContents.capturePage()).toPNG())
        const state = await run(() => ({
          text: document.body.innerText,
          opens: window.test?.opens,
          cancels: window.test?.cancels,
          releases: window.test?.releases,
          media: [...document.querySelectorAll('video,audio')].map(item => ({ src:item.src, paused:item.paused, seeking:item.seeking, time:item.currentTime, duration:item.duration, readyState:item.readyState, error:item.error?.message }))
        }))
        await fs.writeFile(`${failurePath}.json`, JSON.stringify({ error:{name:error.name,message:error.message,stack:error.stack},state }, null, 2))
        console.error(`Agent media failure evidence: ${failurePath}.{png,json}`)
      } catch (captureError) { console.error('Could not capture failure evidence:', captureError.stack ?? String(captureError)) }
      app.exit(1)
    }
  })()
}
