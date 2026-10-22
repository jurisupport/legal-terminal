import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'

const run=promisify(execFile)
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const fixture=path.join(root,'.omx/remotion-fixture')
const projectRequire=createRequire(path.join(fixture,'package.json'))
let bundle,selectComposition,renderMedia,config
try {
 ;({bundle}=projectRequire('@remotion/bundler'))
 ;({selectComposition,renderMedia}=projectRequire('@remotion/renderer'))
 config=JSON.parse(await fs.readFile(path.join(fixture,'.legal-terminal/remotion.json'),'utf8'))
} catch {throw Error('Prepare the synthetic fixture first: node scripts/verify-remotion-preview.mjs --install-fixture')}
const browsers=[process.env.REMOTION_BROWSER_EXECUTABLE,
 '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
 '/Applications/Chromium.app/Contents/MacOS/Chromium',
 '/usr/bin/google-chrome','/usr/bin/chromium',
 process.env.PROGRAMFILES&&path.join(process.env.PROGRAMFILES,'Google/Chrome/Application/chrome.exe'),
 process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'Google/Chrome/Application/chrome.exe')].filter(Boolean)
let browserExecutable
for(const candidate of browsers){try{await fs.access(candidate);browserExecutable=candidate;break}catch{}}
if(!browserExecutable)throw Error('Install Chrome or set REMOTION_BROWSER_EXECUTABLE to a compatible browser executable. This check does not download a browser.')
const temp=await fs.mkdtemp(path.join(fixture,'.lt-remotion-render-'))
const outputDir=path.join(root,'.omx/media-verification')
await fs.mkdir(outputDir,{recursive:true})
const outputLocation=path.join(outputDir,'remotion-final.mp4')
const metadata={id:config.compositionId,width:config.width,height:config.height,fps:config.fps,durationInFrames:config.durationInFrames,defaultProps:config.props || {}}
try {
 const entryPoint=path.join(temp,'entry.tsx')
 await fs.writeFile(entryPoint,`import React from 'react';import {registerRoot,Composition} from 'remotion';import * as source from ${JSON.stringify(path.join(fixture,config.component).replace(/\\/g,'/'))};const Component=source[${JSON.stringify(config.exportName || 'default')}];registerRoot(()=>React.createElement(Composition,{component:Component,...${JSON.stringify(metadata)}}));`)
 const serveUrl=await bundle({entryPoint,rootDir:fixture,outDir:path.join(temp,'bundle'),publicDir:path.join(fixture,'public')})
 const composition=await selectComposition({serveUrl,id:config.compositionId,inputProps:config.props,browserExecutable,logLevel:'error'})
 assert.equal(composition.fps,30)
 assert.equal(composition.durationInFrames,90)
 await renderMedia({serveUrl,composition,inputProps:config.props,codec:'h264',audioCodec:'aac',outputLocation,browserExecutable,concurrency:2,logLevel:'error'})
 const {stdout}=await run('ffprobe',['-v','error','-show_entries','stream=codec_name,codec_type,width,height,avg_frame_rate,nb_frames,duration:format=duration','-of','json',outputLocation])
 const probe=JSON.parse(stdout)
 const video=probe.streams.find(stream=>stream.codec_type==='video')
 const audio=probe.streams.find(stream=>stream.codec_type==='audio')
 assert.equal(video.codec_name,'h264');assert.equal(audio.codec_name,'aac')
 assert.equal(video.width,360);assert.equal(video.height,640);assert.equal(video.avg_frame_rate,'30/1');assert.equal(Number(video.nb_frames),90)
 assert.ok(Math.abs(Number(video.duration)-3)<1/30,'Three-second video stream')
 assert.ok(Number(probe.format.duration)>=3&&Number(probe.format.duration)<3.1,'Container duration includes bounded AAC padding')
 const {stdout:pcm}=await run('ffmpeg',['-hide_banner','-loglevel','error','-ss','0.5','-i',outputLocation,'-t','1','-vn','-ac','1','-ar','16000','-f','f32le','pipe:1'],{encoding:'buffer',maxBuffer:128*1024})
 let energy=0, crossings=0, previous=0
 for(let i=0;i<pcm.length;i+=4){const sample=pcm.readFloatLE(i);energy+=sample*sample;if(previous<=0&&sample>0)crossings++;previous=sample}
 const rms=Math.sqrt(energy/(pcm.length/4))
 const toneHz=crossings/(pcm.length/4/16000)
 assert.ok(rms>.02&&rms<.08,'The rendered audio contains the fixture tone at the expected level')
 assert.ok(toneHz>435&&toneHz<445,'The rendered audio preserves the 440Hz fixture tone')
 const colors={}
 for(const frame of [5,37]){
  const filter=`select=eq(n\\,${frame})`
  const {stdout:pixels}=await run('ffmpeg',['-hide_banner','-loglevel','error','-i',outputLocation,'-vf',filter,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{encoding:'buffer',maxBuffer:2*1024*1024})
  assert.equal(pixels.length,360*640*3)
  const pixel=Array.from(pixels.subarray(3*(10*360+10),3*(10*360+10)+3))
  colors[frame]=pixel
  if(frame===5)assert.ok(pixel[2]>200&&pixel[0]<100,'Final frame5 is blue, matching Player capture')
  else assert.ok(pixel[0]>200&&pixel[2]<80,'Final frame37 is red, matching Player capture')
  await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',outputLocation,'-vf',filter,'-frames:v','1',path.join(outputDir,`remotion-final-frame-${frame}.png`)])
 }
 const result={codec:video.codec_name,audioCodec:audio.codec_name,toneHz,rms,durationSeconds:Number(probe.format.duration),videoDurationSeconds:Number(video.duration),audioDurationSeconds:Number(audio.duration),frames:Number(video.nb_frames),fps:30,colors,outputLocation,platform:process.platform,browser:browserExecutable}
 await fs.writeFile(path.join(outputDir,'remotion-final-result.json'),JSON.stringify(result,null,2)+'\n')
 console.log('REMOTION_RENDER_RESULT '+JSON.stringify(result))
} finally {await fs.rm(temp,{recursive:true,force:true})}
