import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (!process.versions.electron) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-agent-links-'))
  try {
    const { build } = await import('esbuild')
    await build({ stdin: { resolveDir: repo, loader: 'tsx', contents: `
      import React from 'react'
      import {createRoot} from 'react-dom/client'
      import {MarkdownMessage} from './src/renderer/src/agent/MarkdownMessage'
      const root = createRoot(document.getElementById('root'))
      window.test = {files: [], external: [], render(text, context = {cwd:'/work/case'}) {
        root.render(<MarkdownMessage text={text} mediaContext={context} streaming={true}
          onCopyCode={async()=>true} onOpenFile={(...args)=>test.files.push(args)}/>)
      }}
      window.lt = {app:{openExternal:async url=>{test.external.push(url);if(url.includes('fail.example'))throw Error('연결 실패')}}}
    ` }, bundle: true, outfile: path.join(temp, 'harness.js'), jsx: 'automatic', platform: 'browser' })
    await fs.writeFile(path.join(temp, 'index.html'), '<meta charset="utf-8"><div id="root"></div><script src="harness.js"></script>')
    const { default: electron } = await import('electron')
    const env = { ...process.env, LT_AGENT_LINKS_DIR: temp }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electron, [fileURLToPath(import.meta.url)], { cwd: repo, env, stdio: 'inherit' })
    const timeout = setTimeout(() => child.kill(), 30_000)
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    clearTimeout(timeout)
    assert.equal(code, 0, 'Agent link checks failed')
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
} else {
  void (async () => {
  const { app, BrowserWindow } = await import('electron')
  const temp = process.env.LT_AGENT_LINKS_DIR
  app.setPath('userData', path.join(temp, 'profile'))
  await app.whenReady()
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  try {
    await win.loadFile(path.join(temp, 'index.html'))
    await win.webContents.executeJavaScript(`(async () => {
      const check = (ok, label) => {if(!ok)throw Error(label)}
      const render = async (href, context) => {
        test.render('[문서 **열기**](<'+href+'>)', context)
        await new Promise(resolve=>setTimeout(resolve,30))
        const link=document.querySelector('a')
        check(link, 'link rendered: '+href)
        link.click()
        await new Promise(resolve=>setTimeout(resolve,10))
      }
      const cases = [
        ['/tmp/준비 서면.md','/tmp/준비 서면.md'],
        ['./docs/의견서.pdf','/work/case/docs/의견서.pdf'],
        ['../답변서.hwpx','/work/답변서.hwpx'],
        ['판결문.hwp','/work/case/판결문.hwp'],
        ['file:///tmp/한글%20문서.docx','/tmp/한글 문서.docx'],
        ['/tmp/자료%23첨부.md','/tmp/자료#첨부.md'],
        ['/tmp/100%.md','/tmp/100%.md'],
        ['file:///tmp/100%.md','/tmp/100%.md'],
        ['/tmp/review.md:12:3','/tmp/review.md'],
        ['./review.md#L12','/work/case/review.md'],
        ['file:///C:/자료/문서%20파일.pdf','C:/자료/문서 파일.pdf'],
        ['C:/자료/문서.md','C:/자료/문서.md'],
        ['ssh://server/home/기록.pdf','ssh://server/home/기록.pdf']
      ]
      for(const [href, expected] of cases) {
        const count=test.files.length
        await render(href)
        check(test.files.length===count+1 && test.files.at(-1)[0]===expected, 'file routing: '+href+' => '+JSON.stringify(test.files.at(-1)))
        check(test.files.at(-1)[1]===expected.split('/').pop(), 'tab title must preserve the extension')
      }
      await render('../서면.md',{cwd:'/home/work',remote:true,profileId:'office'})
      check(test.files.at(-1)[0]==='ssh://office/home/서면.md','remote session path')
      await render('./서면.md',{cwd:'ssh://office/home/work'})
      check(test.files.at(-1)[0]==='ssh://office/home/work/서면.md','remote cwd path')
      check(test.external.length===0,'files never reach external URL opener')
      test.render('<a href="./raw.md">HTML 경로</a>')
      await new Promise(resolve=>setTimeout(resolve,30))
      document.querySelector('a').click()
      check(test.files.at(-1)[0]==='/work/case/raw.md','HTML relative file link')
      const tick = () => new Promise(resolve=>setTimeout(resolve,30))
      const backtick = String.fromCharCode(96)
      const inlinePaths = [
        ['/Users/haheebong/Downloads/x_2114703261160575103/분석_gemini-3.8-flash.md', undefined, '/Users/haheebong/Downloads/x_2114703261160575103/분석_gemini-3.8-flash.md'],
        ['./자료/검토 결과.pdf', undefined, '/work/case/자료/검토 결과.pdf'],
        ['docs/답변서.hwpx', undefined, '/work/case/docs/답변서.hwpx'],
        ['/tmp/100%20 #1.md', undefined, '/tmp/100%20 #1.md'],
        ['/tmp/분석.md', {cwd:'/work',remote:true,profileId:'office'}, 'ssh://office/tmp/분석.md'],
        ['C:'+String.fromCharCode(92)+'자료'+String.fromCharCode(92)+'의견.docx', undefined, 'C:/자료/의견.docx']
      ]
      for(const [source, context, expected] of inlinePaths) {
        test.render('결과 파일: '+backtick+source+backtick, context)
        await tick()
        const link=document.querySelector('a[data-agent-file]')
        check(link?.querySelector('code')?.textContent===source,'inline file keeps code text: '+source)
        link.querySelector('code').click()
        check(test.files.at(-1)[0]===expected,'inline file routing: '+source)
      }
      for(const source of ['gemini-3.8-flash','MEDIA_RESOLUTION_LOW','report.md','python /tmp/report.md','/api/v1/users']) {
        test.render(backtick+source+backtick)
        await tick()
        check(!document.querySelector('a'),'ordinary code remains text: '+source)
      }
      test.render(backtick.repeat(3)+'text\\n/tmp/report.md\\n'+backtick.repeat(3))
      await tick()
      check(!document.querySelector('a') && document.querySelector('pre code'),'code blocks stay unchanged')
      test.render('['+backtick+'/tmp/label.md'+backtick+'](https://example.com/label)')
      await tick()
      check(document.querySelectorAll('a').length===1 && !document.querySelector('[data-agent-file]'),'code inside existing links is not relinked')
      for(const href of ['https://example.com/docs?q=1#part','http://localhost:3000','ftp://example.com/docs','mailto:lawyer@example.com','tel:+821012345678','//example.com/docs']) {
        await render(href)
        check(test.external.at(-1)===(href.startsWith('//')?'https:'+href:href),'external routing: '+href)
      }
      await render('https://fail.example/')
      check(document.querySelector('[role=alert]')?.textContent.includes('연결 실패'),'open failure must be visible')
      const count=test.external.length
      for(const href of ['javascript:alert(1)','data:text/html,test','file:///tmp/%00bad.md'])await render(href)
      check(test.external.length===count,'unsafe schemes are never launched')
      console.log('Agent links passed')
    })()`)
    console.log('agent links: document paths, URL encoding, line suffixes, Windows, SSH, external links and error feedback passed')
    app.exit(0)
  } catch (error) { console.error(error); app.exit(1) }
  })()
}
