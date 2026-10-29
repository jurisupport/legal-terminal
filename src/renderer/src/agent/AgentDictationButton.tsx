import { useCallback, useEffect, useRef, useState } from 'react'
import { createSegmentedRecorder, type SegmentedRecorder } from '../hearing/segmentedRecorder'

type Phase = 'idle' | 'starting' | 'recording' | 'stopping' | 'transcribing' | 'error'
type Clip = { audio: Uint8Array; text?: string }

export function AgentDictationButton({ active, onText, onBusyChange }: {
  active: boolean
  onText: (text: string) => void
  onBusyChange: (busy: boolean) => void
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState('')
  const [seconds, setSeconds] = useState(0)
  const phaseRef = useRef<Phase>('idle')
  const callbacksRef = useRef({ onText, onBusyChange })
  callbacksRef.current = { onText, onBusyChange }
  const generationRef = useRef(0)
  const recorderRef = useRef<SegmentedRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const timerRef = useRef<number | null>(null)
  const clipsRef = useRef<Clip[]>([])

  const changePhase = useCallback((next: Phase): void => {
    phaseRef.current = next
    setPhase(next)
    callbacksRef.current.onBusyChange(next !== 'idle' && next !== 'error')
  }, [])

  const releaseMedia = useCallback((): void => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current)
    timerRef.current = null
    recorderRef.current?.dispose()
    recorderRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    const context = contextRef.current
    contextRef.current = null
    if (context && context.state !== 'closed') void context.close().catch(() => {})
  }, [])

  const transcribe = useCallback(async (): Promise<void> => {
    if (phaseRef.current === 'transcribing') return
    const generation = generationRef.current
    changePhase('transcribing')
    setMessage('음성을 글로 변환 중…')
    try {
      if (!clipsRef.current.length) throw new Error('녹음된 음성이 없습니다. 마이크를 확인한 뒤 다시 녹음하세요.')
      for (const clip of clipsRef.current) {
        if (clip.text !== undefined) continue
        const result = await window.lt.dictation.transcribe({ audio: clip.audio, mimeType: 'audio/wav' })
        if (generation !== generationRef.current) return
        if (!result.ok) throw new Error(result.error || '음성 변환에 실패했습니다.')
        if (!result.text?.trim()) throw new Error('인식된 말이 없습니다. 다시 시도하거나 새로 녹음하세요.')
        clip.text = result.text.trim()
      }
      callbacksRef.current.onText(clipsRef.current.map((clip) => clip.text).join(' '))
      clipsRef.current = []
      setMessage('음성을 입력했습니다. 내용을 확인한 뒤 전송하세요.')
      changePhase('idle')
    } catch (error) {
      if (generation !== generationRef.current) return
      setMessage(error instanceof Error ? error.message : String(error))
      changePhase('error')
    }
  }, [changePhase])

  const stop = useCallback(async (): Promise<void> => {
    const recorder = recorderRef.current
    if (!recorder || phaseRef.current !== 'recording') return
    const generation = generationRef.current
    changePhase('stopping')
    setMessage('녹음을 마치는 중…')
    let timeout: number | undefined
    let failure: unknown
    try {
      await Promise.race([
        recorder.stop(),
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => reject(new Error('녹음 종료가 지연되어 마이크를 해제했습니다.')), 3000)
        })
      ])
    } catch (error) {
      failure = error
    } finally {
      window.clearTimeout(timeout)
      if (generation === generationRef.current) releaseMedia()
    }
    if (generation !== generationRef.current) return
    if (failure) {
      setMessage(`${failure instanceof Error ? failure.message : String(failure)} 마지막 일부가 누락될 수 있습니다.`)
      changePhase('error')
      return
    }
    await transcribe()
  }, [changePhase, releaseMedia, transcribe])

  const start = useCallback(async (): Promise<void> => {
    if (!active || (phaseRef.current !== 'idle' && phaseRef.current !== 'error') || clipsRef.current.length) return
    const generation = ++generationRef.current
    changePhase('starting')
    setMessage('마이크 권한 확인 중…')
    try {
      const keyStatus = await window.lt.dictation.keyStatus()
      if (generation !== generationRef.current) return
      if (keyStatus !== 'ok') {
        throw new Error(keyStatus === 'missing'
          ? '설정에서 OpenAI API 키를 먼저 저장하세요.'
          : keyStatus === 'unavailable'
            ? '이 환경에서는 API 키를 안전하게 저장할 수 없습니다.'
            : '저장된 OpenAI API 키를 불러올 수 없습니다. 설정에서 다시 저장하세요.')
      }
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
        throw new Error('이 환경에서는 마이크 녹음을 지원하지 않습니다.')
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
      if (generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      const context = new AudioContext({ sampleRate: 16_000 })
      contextRef.current = context
      if (context.state === 'suspended') await context.resume()
      if (generation !== generationRef.current) return
      const source = context.createMediaStreamSource(stream)
      const recorder = await createSegmentedRecorder(context, source, 120, (segment) => {
        if (generation !== generationRef.current) return
        // Ignore silent WAV tails, which can produce invented text from transcription services.
        const samples = new DataView(segment.audio.buffer, segment.audio.byteOffset, segment.audio.byteLength)
        for (let offset = 44; offset + 1 < samples.byteLength; offset += 2) {
          if (Math.abs(samples.getInt16(offset, true)) > 128) {
            clipsRef.current.push({ audio: segment.audio })
            break
          }
        }
        if (!segment.final) void stop()
      }, (error) => {
        if (generation !== generationRef.current || phaseRef.current === 'stopping') return
        ++generationRef.current
        releaseMedia()
        setMessage(`마이크 녹음 오류: ${error.message} 마지막 일부가 누락될 수 있습니다.`)
        changePhase('error')
      })
      if (generation !== generationRef.current) {
        recorder.dispose()
        return
      }
      recorderRef.current = recorder
      setSeconds(0)
      setMessage('녹음 중 · 한 번 더 누르면 글로 변환합니다.')
      changePhase('recording')
      const startedAt = Date.now()
      timerRef.current = window.setInterval(() => {
        setSeconds(Math.floor((Date.now() - startedAt) / 1000))
        if (Date.now() - startedAt >= 120_000) void stop()
      }, 1000)
      for (const track of stream.getAudioTracks()) {
        track.addEventListener('ended', () => { void stop() }, { once: true })
      }
      if (stream.getAudioTracks().some((track) => track.readyState === 'ended')) void stop()
    } catch (error) {
      if (generation !== generationRef.current) return
      releaseMedia()
      const name = error instanceof Error ? error.name : ''
      setMessage(name === 'NotAllowedError' || name === 'PermissionDeniedError'
        ? '마이크 접근이 거부되었습니다. 시스템 설정에서 이 앱의 마이크 권한을 허용하세요.'
        : name === 'NotFoundError'
          ? '사용할 수 있는 마이크가 없습니다. 마이크 연결을 확인하세요.'
          : error instanceof Error ? error.message : String(error))
      changePhase('error')
    }
  }, [active, changePhase, releaseMedia, stop])

  useEffect(() => {
    if (active) return
    if (phaseRef.current === 'starting') {
      ++generationRef.current
      releaseMedia()
      setMessage('')
      changePhase('idle')
    } else if (phaseRef.current === 'recording') void stop()
  }, [active, changePhase, releaseMedia, stop])

  useEffect(() => () => {
    ++generationRef.current
    releaseMedia()
    clipsRef.current = []
    callbacksRef.current.onBusyChange(false)
  }, [releaseMedia])

  const recording = phase === 'recording'
  const hasRetry = phase === 'error' && clipsRef.current.length > 0
  const busy = phase !== 'idle' && phase !== 'error' && !recording
  const label = recording ? '음성 입력 녹음 종료' : '음성 입력 시작'
  return (
    <span className="agent-dictation">
      <button
        type="button"
        className={`agent-icon-btn${recording ? ' agent-dictation-recording' : ''}`}
        disabled={!active || busy || hasRetry}
        aria-label={label}
        aria-pressed={recording}
        title={`${label} (최대 2분) · 음성은 OpenAI로 전송되며 API 사용료가 발생합니다.`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => { void (recording ? stop() : start()) }}
      >
        {recording
          ? <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
          : <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="8" y="2" width="8" height="13" rx="4" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg>}
      </button>
      {message && <span className="agent-dictation-status" role="status">
        {recording ? `${message} ${seconds}초 / 120초` : message}
        {(recording || phase === 'starting') && <span>음성은 OpenAI로 전송되며 API 사용료가 발생합니다.</span>}
        {hasRetry && <span className="agent-dictation-actions">
          <span>녹음은 이 대화가 열려 있는 동안만 보관됩니다.</span>
          <button type="button" disabled={!active} onClick={() => { void transcribe() }}>다시 시도</button>
          <button type="button" onClick={() => {
            clipsRef.current = []
            setMessage('')
            changePhase('idle')
          }}>녹음 버리기</button>
        </span>}
        {!hasRetry && (phase === 'idle' || phase === 'error') && <button type="button" aria-label="음성 입력 안내 닫기" onClick={() => setMessage('')}>닫기</button>}
      </span>}
    </span>
  )
}
