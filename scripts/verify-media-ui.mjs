// Run after npm run build; real App/preload/main/media protocol, isolated user data, synthetic files.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-media-integration-'))
const output = process.env.LT_MEDIA_UI_OUTPUT ?? path.join(root, 'output/media-review')
await fs.mkdir(output, { recursive: true })

async function electronCheck({ root, temp, output }) {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const fs = require('node:fs/promises')
  const path = require('node:path')
  const assert = require('node:assert/strict')
  app.setPath('userData', path.join(temp, 'profile'))
  require(path.join(root, 'out/main/index.js'))
  // No provider process or model request is created by the UI fixture.
  ipcMain.removeHandler('agent:create')
  let agentCreated = false
  ipcMain.handle('agent:create', () => { agentCreated = true; return { ok: true } })
  await app.whenReady()
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  let win
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; if (!win) await pause(30) }
  assert.ok(win, 'Application window created')
  const run = body => win.webContents.executeJavaScript(`(async () => { ${body} })()`)
  const wait = async (condition, label, attempts = 200) => {
    for (let i = 0; i < attempts; i++) {
      if (await run(`return (${condition})`).catch(() => false)) return
      await pause(50)
    }
    throw new Error(`Timed out: ${label}\n${await run('return document.body.innerText.slice(-4000)')}`)
  }
  const sample = path.join(temp, 'project', 'movie.mp4')
  const audio = path.join(temp, 'project', 'sound.wav')
  const open = (file, id, state) => win.webContents.send('tabs:receive', { kind: 'doc', tab: { kind: 'media', path: file, title: path.basename(file), id, side: 'left', mediaState: state } })
  const screenshot = async name => {
    await pause(200)
    await fs.writeFile(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  const checks = []
  try {
    await wait("!!document.querySelector('.case-tabs-trigger')", 'App ready')
    await run(`window.testButton = label => [...document.querySelectorAll('.media-viewer button')].find(item=>item.textContent.trim()===label && item.checkVisibility({checkVisibilityCSS:true})); window.testMedia = () => [...document.querySelectorAll('.media-viewer video,.media-viewer audio')].find(item=>item.checkVisibility({checkVisibilityCSS:true}));`)
    win.webContents.send('tabs:receive', { kind: 'terminal', tab: { id: 'media-fixture-agent', kind: 'agent', agentProvider: 'claude', title: '미디어 검토', cwd: path.dirname(sample), side: 'right', createdAt: Date.now() } })
    for (let i = 0; i < 200 && !agentCreated; i++) await pause(50)
    assert.ok(agentCreated, 'Fixture agent mounted')
    open(sample, 'media-fixture-video')
    await wait("testMedia()?.tagName==='VIDEO' && testMedia().readyState>=2", 'MP4 decode over real lt-media protocol')
    const original = await run('return {url:testMedia().src,duration:testMedia().duration}')
    assert.ok(original.url.startsWith('lt-media://snapshot/'))
    assert.equal(original.duration, 2)
    await run('await testMedia().play()')
    await wait('testMedia().currentTime>.15', 'Native MP4 playback advances')
    await run('testMedia().pause()')
    const ranges = await run(`
      const good=await fetch(testMedia().src,{headers:{Range:'bytes=0-31'}});
      const invalid=await fetch(testMedia().src,{headers:{Range:'bytes=999999999-'}});
      return {status:good.status,length:(await good.arrayBuffer()).byteLength,range:good.headers.get('content-range'),invalid:invalid.status};
    `)
    assert.equal(ranges.status, 206)
    assert.equal(ranges.length, 32)
    assert.equal(ranges.invalid, 416)
    checks.push('Actual MP4 decoding and HTTP byte ranges')

    const foreign = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    await foreign.loadURL('data:text/html,<html>Token isolation check</html>')
    const crossed = await foreign.webContents.executeJavaScript(`fetch(${JSON.stringify(original.url)}).then(r=>r.ok).catch(()=>false)`)
    foreign.destroy()
    assert.equal(crossed, false, 'Other webContents cannot read a media token')
    checks.push('Cross-window media capability rejection')

    await run("testMedia().currentTime=.4")
    await wait('!testMedia().seeking && Math.abs(testMedia().currentTime-.4)<.02', 'Video seek')
    await run("testButton('구간 시작').click()")
    await run("testMedia().currentTime=.9")
    await wait('!testMedia().seeking && Math.abs(testMedia().currentTime-.9)<.02', 'Video seek end')
    await run("testButton('구간 끝').click()")
    await wait("!testButton('이 구간 질문').disabled", 'Range selected')
    await run("testButton('이 구간 질문').click()")
    await wait("document.querySelectorAll('.agent-attachments.pending .agent-attachment-chip').length>=2", 'Media range and actual captured image reach Agent input')
    const labels = await run("return [...document.querySelectorAll('.agent-attachments.pending .agent-attachment-chip')].map(item=>({text:item.textContent,title:item.title}))")
    assert.ok(labels.some(item => item.text.includes('0:00.400–0:00.900')))
    assert.ok(labels.some(item => item.text.includes('화면 캡처')))
    const captures = await fs.readdir(path.join(path.dirname(sample), '.legal-terminal/media-context'))
    assert.equal(captures.length, 1)
    const capture = await fs.readFile(path.join(path.dirname(sample), '.legal-terminal/media-context', captures[0]))
    assert.equal(capture[0], 255)
    assert.equal(capture[1], 216)
    checks.push('Canvas capture with real protocol CORS and saved JPEG attachment in Agent input')

    win.unmaximize()
    win.setSize(1280, 800)
    await pause(150)
    await wait('testMedia()?.readyState>=3 && !testMedia().seeking', 'Paused frame is fully buffered')
    const layout = await run(`
      const viewer=[...document.querySelectorAll('.media-viewer')].find(item=>item.checkVisibility({checkVisibilityCSS:true}));
      const rect=viewer.getBoundingClientRect();
      return {rect:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},width:innerWidth,height:innerHeight,overflow:viewer.scrollWidth-viewer.clientWidth};
    `)
    assert.ok(layout.rect.left>=0 && layout.rect.right<=layout.width+1 && layout.rect.top>=0 && layout.rect.bottom<=layout.height+1)
    assert.ok(layout.overflow<=1, 'Media controls fit minimum window width')
    await screenshot('media-review-min-window')
    checks.push('Minimum main-window layout without horizontal clipping')

    await fs.copyFile(path.join(temp, 'replacement.mp4'), sample)
    await wait("document.querySelector('.media-viewer')?.textContent.includes('원본이 변경되었습니다')", 'Changed file candidate detection')
    assert.equal(await run('return testMedia().src'), original.url, 'Candidate change must not auto-replace review')
    await run("testButton('원본 다시 읽기').click()")
    await wait(`testMedia()?.src!==${JSON.stringify(original.url)} && testMedia()?.readyState>=2`, 'Explicit revision refresh')
    const newer = await run('return testMedia().src')
    await run(`const select=document.querySelector('.media-viewer [aria-label="리뷰 버전"]');const choices=[...select.options].filter(option=>option.value!==select.value);select.value=choices[0].value;select.dispatchEvent(new Event('change',{bubbles:true}));`)
    await wait(`testMedia()?.src!==${JSON.stringify(newer)} && testMedia()?.readyState>=2`, 'Previous revision selection')
    checks.push('Candidate detection without auto-replacement, forced refresh, previous revision')

    await run("testMedia().currentTime=1.6")
    await wait('!testMedia().seeking', 'Move away before attachment reveal')
    await run("[...document.querySelectorAll('.agent-attachments.pending .agent-attachment-chip')].find(item=>item.textContent.includes('0:00.400–0:00.900')).click()")
    await wait('testMedia()?.readyState>=2 && Math.abs(testMedia().currentTime-.9)<.02', 'Attachment restores quoted version and time')
    checks.push('Media attachment click restores quoted revision/time')

    open(audio, 'media-fixture-audio')
    await wait("testMedia()?.tagName==='AUDIO' && testMedia().readyState>=2", 'Native WAV playback')
    await run('testMedia().muted=true; await testMedia().play()')
    await wait('testMedia().currentTime>.1', 'Native WAV playback advances')
    await run('testMedia().pause()')
    await run("testMedia().currentTime=.5")
    await wait('!testMedia().seeking', 'Audio seek')
    await run("testButton('이 시점 질문').click()")
    await wait("[...document.querySelectorAll('.agent-attachments.pending .agent-attachment-chip')].some(item=>item.textContent.includes('sound.wav'))", 'Audio reference reaches Agent')
    assert.equal((await fs.readdir(path.join(path.dirname(sample), '.legal-terminal/media-context'))).length, 1, 'Audio creates no fake frame capture')
    checks.push('WAV playback/seek and time-only attachment')
    const videoSnapshot = await run('return document.querySelector(".media-viewer video")?.src')
    assert.ok(videoSnapshot, 'Inactive video remains mounted')
    assert.equal(await run('return document.querySelector(".media-viewer video").paused'), true)
    await run("[...document.querySelectorAll('.tab-title')].find(item=>item.textContent==='movie.mp4').click()")
    await wait("testMedia()?.tagName==='VIDEO'", 'Return to inactive video tab')
    assert.equal(await run('return testMedia().src'), videoSnapshot, 'Tab return keeps existing snapshot token')
    assert.equal(await run('return testMedia().paused'), true, 'Tab return does not resume playback')
    checks.push('Tab switching pauses and retains exact media snapshot')
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ checks, platform: process.platform, screenshots: ['media-review-min-window.png'] }, null, 2))
    console.log('MEDIA_UI_RESULT '+JSON.stringify({checks,output}))
    app.exit(0)
  } catch (error) {
    await screenshot('media-review-failure').catch(()=>{})
    console.error(error)
    app.exit(1)
  }
}

try {
  await fs.mkdir(path.join(temp, 'project'), { recursive: true })
  for (const [name, color] of [['project/movie.mp4', 'red'], ['replacement.mp4', 'blue']]) execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:d=2:r=25`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(temp, name)])
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', path.join(temp, 'project/sound.wav')])
  const launcher = path.join(temp, 'run.cjs')
  await fs.writeFile(launcher, `(${electronCheck.toString()})(${JSON.stringify({root,temp,output})}).catch(error=>{console.error(error);require('electron').app.exit(1)})`)
  const { default: electron } = await import('electron')
  const env = {...process.env}
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [`--user-data-dir=${path.join(temp,'profile')}`, launcher], { cwd: root, env, stdio: 'inherit' })
  const timeout = setTimeout(()=>child.kill(), 120_000)
  const code = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
  clearTimeout(timeout)
  assert.equal(code,0,'Integrated media UI checks failed')
} finally { await fs.rm(temp,{recursive:true,force:true}) }
