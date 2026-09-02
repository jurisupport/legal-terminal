import { safeStorage } from 'electron'
import { shouldUseDictationCorrection } from './dictationGuard'
import { getSettings, setSettings } from './settings'

export type DictationKeyStatus = 'ok' | 'missing' | 'locked' | 'unavailable'

export interface DictationContext {
  court?: string
  caseNumber?: string
  caseName?: string
  client?: string
  opponent?: string
  partyNames?: string
  speaker?: string
}

export interface DictationTranscribeInput {
  audio: Uint8Array
  mimeType: string
  context?: DictationContext
}

export interface DictationTranscribeResult {
  ok: boolean
  text?: string
  corrected?: boolean
  error?: string
}

const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions'
const RESPONSES_URL = 'https://api.openai.com/v1/responses'
const TRANSCRIPTION_MODEL = 'gpt-transcribe'
const CORRECTION_MODEL = 'gpt-5.4-mini'
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

function encodeSecret(value: string): string {
  if (!value) return ''
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('현재 플랫폼에서는 OpenAI API 키를 안전하게 저장할 수 없습니다.')
  }
  return `v1:${safeStorage.encryptString(value).toString('base64')}`
}

function decodeSecret(value?: string): string | null {
  if (!value) return null
  if (value.startsWith('v1:')) {
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(3), 'base64'))
    } catch {
      return null
    }
  }
  return null
}

export async function setKey(key: string): Promise<void> {
  await setSettings({ openaiApiKeyEnc: key ? encodeSecret(key) : undefined })
}

export async function keyStatus(): Promise<DictationKeyStatus> {
  const enc = (await getSettings()).openaiApiKeyEnc
  if (!enc) return safeStorage.isEncryptionAvailable() ? 'missing' : 'unavailable'
  if (enc.startsWith('v1:') && !safeStorage.isEncryptionAvailable()) return 'unavailable'
  return (await getKey()) ? 'ok' : 'locked'
}

async function getKey(): Promise<string | null> {
  return decodeSecret((await getSettings()).openaiApiKeyEnc)
}

function contextSummary(context?: DictationContext): string {
  const parts = [
    context?.court && `법원: ${context.court}`,
    context?.caseNumber && `사건번호: ${context.caseNumber}`,
    context?.caseName && `사건명: ${context.caseName}`,
    context?.client && `의뢰인: ${context.client}`,
    context?.opponent && `상대방: ${context.opponent}`,
    context?.partyNames && `당사자: ${context.partyNames}`,
    context?.speaker && `현재 화자: ${context.speaker}`
  ].filter((part): part is string => Boolean(part))
  return parts.join(' / ')
}

function transcriptionPrompt(context?: DictationContext): string {
  const contextText = contextSummary(context)
  return cleanPrompt(
    '대한민국 법정 기일기록 진행 메모를 전사한다.',
    '발언을 요약하지 말고 그대로 옮긴다.',
    '숫자, 날짜, 금액, 부정 표현, 고유명사는 함부로 바꾸지 않는다.',
    contextText ? `문맥: ${contextText}` : ''
  )
}

function cleanPrompt(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join(' ')
    .replace(/[<>\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_000)
}

function keywordList(context?: DictationContext): string[] {
  return [
    context?.court,
    context?.caseNumber,
    context?.caseName,
    context?.client,
    context?.opponent,
    context?.partyNames,
    context?.speaker
  ]
    .flatMap((value) =>
      (value ?? '')
        .split(/[,\n·/|]/)
        .map((part) => part.trim())
        .filter(Boolean)
    )
    .map((value) => value.replace(/[<>\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64))
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, 32)
}

function extractText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const obj = value as Record<string, unknown>
  if (typeof obj.output_text === 'string') return obj.output_text
  if (typeof obj.text === 'string') return obj.text
  if (typeof obj.transcript === 'string') return obj.transcript
  const output = obj.output
  if (!Array.isArray(output)) return ''
  const chunks: string[] = []
  const stack: unknown[] = [...output]
  while (stack.length > 0) {
    const item = stack.shift()
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    if (typeof entry.output_text === 'string') chunks.push(entry.output_text)
    if (typeof entry.text === 'string' && (entry.type === 'message' || entry.type === 'output_text')) {
      chunks.push(entry.text)
    }
    const content = entry.content
    if (Array.isArray(content)) stack.unshift(...content)
  }
  return chunks.join('').trim()
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/\s*```$/, '').trim()
}

async function callResponses(
  key: string,
  body: Record<string, unknown>
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 120_000)
  try {
    const response = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    const text = await response.text()
    if (!response.ok) return { ok: false, error: text || `HTTP ${response.status}` }
    try {
      return { ok: true, json: JSON.parse(text) as unknown }
    } catch {
      return { ok: false, error: 'OpenAI 응답 JSON 파싱 실패' }
    }
  } catch (error) {
    return {
      ok: false,
      error: ctrl.signal.aborted
        ? 'OpenAI 응답 시간 초과'
        : error instanceof Error
          ? error.message
          : String(error)
    }
  } finally {
    clearTimeout(timer)
  }
}

async function correctTranscript(
  key: string,
  rawText: string,
  context?: DictationContext
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const system = [
    '너는 법정 음성 전사문 교정기다.',
    '맞춤법, 띄어쓰기, 문장부호, 제공된 고유명사만 고친다.',
    '단어 추가·삭제·요약·순서 변경을 하지 않는다.',
    '숫자, 날짜, 금액, 인명, 긍정/부정 표현을 추정하지 않는다.',
    '불명확한 부분은 원문을 그대로 둔다.',
    '출력은 수정된 본문만 반환한다.'
  ].join(' ')
  const user = [
    contextSummary(context) ? `문맥: ${contextSummary(context)}` : '',
    `원문:\n${rawText}`,
    '반환 형식: 수정된 본문만'
  ]
    .filter(Boolean)
    .join('\n\n')
  const response = await callResponses(key, {
    model: CORRECTION_MODEL,
    store: false,
    reasoning: { effort: 'none' },
    input: [
      { role: 'system', content: [{ type: 'input_text', text: system }] },
      { role: 'user', content: [{ type: 'input_text', text: user }] }
    ]
  })
  if (!response.ok) return response
  const candidate = stripCodeFence(extractText(response.json))
  if (!shouldUseDictationCorrection(rawText, candidate)) {
    return { ok: false, error: '교정 결과가 원문 보존 규칙을 벗어났습니다.' }
  }
  return { ok: true, text: candidate }
}

function copyAudioBuffer(audio: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(audio.byteLength)
  copy.set(audio)
  return copy.buffer
}

async function transcribeAudio(
  key: string,
  input: DictationTranscribeInput
): Promise<{ ok: true; text: string; corrected: boolean } | { ok: false; error: string }> {
  if (!(input.audio instanceof Uint8Array) || input.audio.byteLength === 0) {
    return { ok: false, error: '녹음 파일이 비어 있습니다.' }
  }
  if (input.audio.byteLength > MAX_AUDIO_BYTES) {
    return { ok: false, error: '녹음 파일이 25MB를 초과했습니다.' }
  }
  const form = new FormData()
  form.append('model', TRANSCRIPTION_MODEL)
  form.append('file', new Blob([copyAudioBuffer(input.audio)], { type: input.mimeType || 'audio/webm' }), 'dictation.webm')
  form.append('languages[]', 'ko')
  form.append('prompt', transcriptionPrompt(input.context))
  const keywords = keywordList(input.context)
  for (const keyword of keywords) form.append('keywords[]', keyword)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 120_000)
  try {
    const response = await fetch(TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: ctrl.signal
    })
    const text = await response.text()
    if (!response.ok) return { ok: false, error: text || `HTTP ${response.status}` }
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      return { ok: false, error: '전사 응답 JSON 파싱 실패' }
    }
    const rawText = stripCodeFence(extractText(parsed))
    if (!rawText.trim()) return { ok: false, error: '전사 결과가 비어 있습니다.' }
    const corrected = await correctTranscript(key, rawText, input.context)
    return corrected.ok
      ? { ok: true, text: corrected.text, corrected: true }
      : { ok: true, text: rawText, corrected: false }
  } catch (error) {
    return {
      ok: false,
      error: ctrl.signal.aborted
        ? 'OpenAI 전사 시간 초과'
        : error instanceof Error
          ? error.message
          : String(error)
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function transcribe(
  input: DictationTranscribeInput
): Promise<DictationTranscribeResult> {
  const key = await getKey()
  if (!key) {
    const status = await keyStatus()
    return {
      ok: false,
      error:
        status === 'locked'
          ? 'OpenAI API 키를 복호화할 수 없습니다. 설정에서 다시 입력해 주세요.'
          : status === 'unavailable'
            ? '현재 플랫폼에서는 OpenAI API 키 보관 기능을 사용할 수 없습니다.'
            : 'OpenAI API 키가 설정되지 않았습니다.'
    }
  }
  return transcribeAudio(key, input)
}
