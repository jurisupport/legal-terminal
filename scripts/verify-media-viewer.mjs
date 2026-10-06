import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-media-viewer-'))
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=2:r=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(temp, 'sample.mp4')])
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', path.join(temp, 'sample.wav')])
    await fs.writeFile(path.join(temp, 'invalid.mp4'), 'not a video')
    const urls = Object.fromEntries(['sample.mp4', 'sample.wav', 'invalid.mp4'].map((name) => [name, pathToFileURL(path.join(temp, name)).href]))
    await build({
      stdin: { resolveDir: repo, loader: 'tsx', contents: `
        import React from 'react'
        import {createRoot} from 'react-dom/client'
        import MediaViewer from './src/renderer/src/viewer/MediaViewer'
        const urls = ${JSON.stringify(urls)}
        const source = 'ssh://test/shorts/movie.mp4'
        const state = window.test = { source, mode: '', openCalls: [], releases: [], cancels: [], asks: [], states: [], change: {changed:false,completed:false}, pending: null }
        const version = (id, sourcePath = source) => ({versionId:id,sourcePath,size:100,mimeType:sourcePath.endsWith('.wav')?'audio/wav':'video/mp4',mtimeMs:1,createdAt:id==='v1'?1:2})
        let token = 0
        const make = (id, sourcePath = source) => ({...version(id, sourcePath),token:'token-'+(++token),url:urls[sourcePath.endsWith('.wav')?'sample.wav':'sample.mp4']})
        window.lt = {media:{
          open: async (input) => {
            state.openCalls.push(input)
            if(input.versionId==='expired') throw new Error('인용한 리뷰 버전이 만료되었습니다.')
            if(state.mode==='fail') throw new Error('download failed')
            if(state.mode==='pending') return await new Promise(resolve => { state.pending = () => resolve(make('late', input.path)) })
            const result=make(input.versionId ?? (input.force?'v2':'v1'),input.path)
            if(state.mode==='invalid') result.url=urls['invalid.mp4']
            return result
          },
          release: async token => {state.releases.push(token)}, cancel: async id => {state.cancels.push(id)},
          versions: async path => [version('v1',path),version('v2',path),version('expired',path)],
          check: async () => state.change, onProgress: callback => {state.progress=callback;return()=>{}},
        }}
        const root = createRoot(document.getElementById('root'))
        state.render = props => root.render(<MediaViewer path={source} onAsk={request=>state.asks.push(request)} onStateChange={value=>state.states.push(value)} {...props}/>)
        state.unmount = () => root.unmount()
        state.render({})
      ` },
      bundle: true, outfile: path.join(temp, 'harness.js'), jsx: 'automatic', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' }
    })
    await fs.writeFile(path.join(temp, 'index.html'), '<html><head><link rel="stylesheet" href="harness.css"><style>:root{--bg:#1e1e1e;--bg-alt:#252526;--border:#444;--fg:#ccc;--fg-muted:#aaa;--accent:#0e639c;--accent-fg:#fff;--font-mono:monospace}*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif}</style></head><body><div id="root" style="height:760px"></div><script src="harness.js"></script></body></html>')
    const { default: electron } = await import('electron')
    const env = { ...process.env, LT_MEDIA_TEST_DIR: temp }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electron, [fileURLToPath(import.meta.url)], { cwd: repo, env, stdio: 'inherit' })
    const timeout = setTimeout(() => child.kill(), 90_000)
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    clearTimeout(timeout)
    assert.equal(code, 0, 'Electron media UI checks failed')
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
} else {
  // Let Electron finish loading its ESM entry before waiting for app readiness.
  void (async () => {
  const { app, BrowserWindow } = await import('electron')
  const temp = process.env.LT_MEDIA_TEST_DIR
  app.setPath('userData', path.join(temp, 'profile'))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1000, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const run = fn => window.webContents.executeJavaScript(`(${fn.toString()})()`)
  try {
    await window.loadFile(path.join(temp, 'index.html'))
    await run(async () => {
      window.waitFor = async condition => {
        const deadline = Date.now()+8000
        while (!condition()) { if(Date.now()>deadline) throw new Error('UI wait timed out: '+condition); await new Promise(resolve=>setTimeout(resolve,20)) }
      }
      window.button = text => [...document.querySelectorAll('button')].find(button=>button.textContent===text)
      window.check = (condition,message) => {if(!condition) throw new Error(message)}
      window.seek = async time => {const media=document.querySelector('video,audio'); media.currentTime=time; await waitFor(()=>!media.seeking&&Math.abs(media.currentTime-time)<.02)}
      await waitFor(()=>document.querySelector('video')?.readyState>=2)
      await seek(.4); button('구간 시작').click()
      await new Promise(resolve=>setTimeout(resolve,20))
      await seek(.8); button('구간 끝').click()
      await waitFor(()=>!button('이 구간 질문').disabled)
      button('이 구간 질문').click()
      await waitFor(()=>test.asks.length===1)
      const first=test.asks[0]
      check(first.selection.start===.4&&first.selection.end===.8,'selected range preserved')
      check(first.selection.sourcePath===test.source&&first.selection.versionId==='v1','source and revision preserved')
      check(first.capture[0]===255&&first.capture[1]===216&&first.selection.captureTime===.8,'decoded JPEG capture matches time')
      await waitFor(()=>!button('이 구간 질문').disabled)
      const repeat=document.querySelector('input[type="checkbox"]')
      repeat.click()
      await waitFor(()=>!document.querySelector('video').paused)
      document.querySelector('video').currentTime=1.5
      await waitFor(()=>document.querySelector('video').currentTime>=.4&&document.querySelector('video').currentTime<.8)
      repeat.click();document.querySelector('video').pause()
      const speed=document.querySelector('[aria-label="재생 속도"]')
      speed.value='1.5';speed.dispatchEvent(new Event('change',{bubbles:true}))
      await waitFor(()=>document.querySelector('video').playbackRate===1.5)
      const input=document.querySelector('[aria-label="구간 끝 초"]')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'.1')
      input.dispatchEvent(new Event('input',{bubbles:true}))
      await waitFor(()=>document.querySelector('[role="alert"]'))
      check(input.value==='0.8','backwards range rejected')
      button('선택 해제').click()
      await waitFor(()=>button('이 구간 질문').disabled)
    })
    await run(async () => {
      test.mode='fail';button('원본 다시 읽기').click()
      await waitFor(()=>document.querySelector('[role="alert"]')?.textContent.includes('download failed'))
      check(document.querySelector('video').readyState>=2,'download failure preserves current playback')
      test.mode='invalid';button('원본 다시 읽기').click()
      await waitFor(()=>document.querySelector('[role="alert"]')?.textContent.includes('재생할 수 없습니다'))
      check(document.querySelector('video').readyState>=2,'unsupported replacement preserves current playback')
      test.mode='pending';button('원본 다시 읽기').click()
      await waitFor(()=>test.pending&&button('취소'))
      const request=test.openCalls.at(-1).requestId
      test.progress({requestId:request,downloadedBytes:50,totalBytes:100})
      await waitFor(()=>document.querySelector('progress')?.value===50)
      button('취소').click()
      await waitFor(()=>test.cancels.includes(request))
      const releaseCount=test.releases.length
      test.pending()
      await waitFor(()=>test.releases.length>releaseCount)
      check(!document.querySelector('select[aria-label="리뷰 버전"]').value.includes('late'),'canceled late result cannot replace review')
      test.mode='';test.render({reveal:{selection:{sourcePath:test.source,versionId:'expired',time:.7},nonce:1}})
      await waitFor(()=>document.querySelector('[role="alert"]')?.textContent.includes('만료'))
      check(!test.openCalls.at(-1).force&&test.openCalls.at(-1).versionId==='expired','expired revision never falls back to latest')
    })
    if (process.env.LT_MEDIA_VIEWER_SCREENSHOT) await fs.writeFile(process.env.LT_MEDIA_VIEWER_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
    await run(async () => {
      test.render({reveal:{selection:{sourcePath:test.source,versionId:'v1',time:.6,start:.3,end:1.2},nonce:2}})
      await waitFor(()=>Math.abs(document.querySelector('video').currentTime-.6)<.02)
      await waitFor(()=>document.querySelector('[aria-label="구간 끝 초"]').value==='1.2')
      await seek(1.5)
      test.change={changed:true,completed:true,path:'ssh://test/shorts/v2.mp4'}
      await waitFor(()=>button('새 버전 보기'))
      check(document.querySelector('select[aria-label="리뷰 버전"]').value.includes('v1'),'new version does not automatically replace review')
      button('새 버전 보기').click()
      await waitFor(()=>test.states.at(-1)?.sourcePath==='ssh://test/shorts/v2.mp4')
      check(Math.abs(document.querySelector('video').currentTime-1.5)<.02,'explicit revision switch preserves current time')
      const choice=document.querySelector('[aria-label="리뷰 버전"]')
      choice.value=JSON.stringify([test.source,'v1']);choice.dispatchEvent(new Event('change',{bubbles:true}))
      await waitFor(()=>test.states.at(-1)?.sourcePath===test.source)
      check(test.openCalls.at(-1).versionId==='v1','previous revision explicitly requested')
      const media=document.querySelector('video'), source=media.src, releases=test.releases.length, opens=test.openCalls.length
      await media.play()
      test.render({active:false})
      await waitFor(()=>media.paused)
      check(test.releases.length===releases,'hidden media keeps snapshot capabilities')
      test.render({active:true})
      await new Promise(resolve=>setTimeout(resolve,50))
      check(document.querySelector('video').src===source&&test.openCalls.length===opens,'return to tab preserves exact snapshot without transfer')
      check(media.paused,'return does not automatically resume playback')
    })
    await run(async () => {
      test.render({path:'ssh://test/shorts/sound.wav',initialState:{time:99,start:1,end:8}})
      await waitFor(()=>document.querySelector('audio')?.readyState>=2)
      await waitFor(()=>test.states.at(-1)?.sourcePath.endsWith('.wav'))
      check(test.states.at(-1).time===2&&test.states.at(-1).end===2,'restored time/range clamped to actual duration')
      await seek(.5);button('이 시점 질문').click()
      await waitFor(()=>test.asks.length===2)
      check(!test.asks[1].capture&&test.asks[1].selection.time===.5,'audio attaches time without invented capture/transcript')
      const releases=test.releases.length
      test.unmount()
      await waitFor(()=>test.releases.length>releases)
    })
    console.log('media viewer: native playback/seek, JPEG capture, range validation, cancellation race, failed decode preservation, explicit revisions/reveal, completed update, audio, restore and release passed')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
  })()
}
