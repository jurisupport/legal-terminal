import { app } from 'electron'
import { randomUUID } from 'crypto'
import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink } from 'fs/promises'
import { join } from 'path'
import { transcribe, type DictationContext, type DictationTranscribeInput, type DictationTranscribeResult } from './dictation'
import type { DictationBackup, DictationBackupQuery } from '../shared/dictationRecovery'

const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const MAX_TEXT_BYTES = 8 * 1024 * 1024
const MAX_FILE_BYTES = 48 * 1024 * 1024
const operations = new Map<string, Promise<unknown>>()
const transcriptions = new Map<string, { promise: Promise<DictationTranscribeResult>; controller: AbortController }>()
type StoredBackup = { backup: DictationBackup; result?: DictationTranscribeResult }

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('전사 복구 자료가 올바르지 않습니다.')
}

function text(value: unknown, max: number, empty = false): string {
  requireValid(typeof value === 'string' && (empty || value.length > 0) && Buffer.byteLength(value) <= max)
  return value
}

function validId(id: unknown): string {
  requireValid(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))
  return id
}

function root(): string { return join(app.getPath('userData'), 'dictation-recovery') }
function file(id: string): string { return join(root(), `${validId(id)}.json`) }

function serialize<T>(id: string, action: () => Promise<T>): Promise<T> {
  validId(id)
  const run = (operations.get(id) ?? Promise.resolve()).catch(() => undefined).then(action)
  operations.set(id, run)
  void run.finally(() => { if (operations.get(id) === run) operations.delete(id) }).catch(() => undefined)
  return run
}

function cleanContext(value: DictationContext | undefined): DictationContext | undefined {
  if (value === undefined) return undefined
  requireValid(value && typeof value === 'object' && !Array.isArray(value))
  const context: DictationContext = {}
  for (const key of ['court', 'caseNumber', 'caseName', 'client', 'opponent', 'partyNames', 'speaker'] as const) {
    if (value[key] !== undefined) context[key] = text(value[key], 16_384, true)
  }
  if (value.participants !== undefined) {
    requireValid(Array.isArray(value.participants) && value.participants.length <= 32)
    context.participants = value.participants.map((item) => {
      requireValid(item && typeof item === 'object')
      return { id: text(item.id, 512), label: text(item.label, 512) }
    })
  }
  if (value.recentDialogue !== undefined) {
    requireValid(Array.isArray(value.recentDialogue) && value.recentDialogue.length <= 100)
    context.recentDialogue = value.recentDialogue.map((item) => {
      requireValid(item && typeof item === 'object')
      return { speakerId: text(item.speakerId, 512), text: text(item.text, 32_768, true) }
    })
  }
  return context
}

function cleanInput(input: DictationTranscribeInput): DictationTranscribeInput {
  requireValid(input && input.audio instanceof Uint8Array && input.audio.byteLength > 0 && input.audio.byteLength <= MAX_AUDIO_BYTES)
  requireValid(input.diarize === undefined || typeof input.diarize === 'boolean')
  const result: DictationTranscribeInput = {
    audio: new Uint8Array(input.audio), mimeType: text(input.mimeType, 256, true),
    context: cleanContext(input.context), diarize: input.diarize
  }
  if (input.knownSpeakers !== undefined) {
    requireValid(Array.isArray(input.knownSpeakers) && input.knownSpeakers.length <= 4)
    result.knownSpeakers = input.knownSpeakers.map((item) => {
      requireValid(item && item.audio instanceof Uint8Array && item.audio.byteLength > 0 && item.audio.byteLength <= 320_044)
      return { name: text(item.name, 128), audio: new Uint8Array(item.audio),
        ...(item.participantId === undefined ? {} : { participantId: text(item.participantId, 512) }) }
    })
  }
  return result
}

function cleanBackup(backup: DictationBackup): DictationBackup {
  requireValid(backup && typeof backup === 'object')
  const recordJson = text(backup.recordJson, MAX_TEXT_BYTES)
  const record: unknown = JSON.parse(recordJson)
  requireValid(record && typeof record === 'object' && 'id' in record && record.id === backup.recordId)
  const selection = backup.selection
  requireValid(selection && typeof selection === 'object')
  const value = text(selection.value, MAX_TEXT_BYTES, true)
  requireValid(Number.isInteger(selection.start) && Number.isInteger(selection.end) &&
    selection.start >= 0 && selection.end >= selection.start && selection.end <= value.length)
  requireValid(Number.isFinite(backup.startedAt) && backup.startedAt >= 0)
  return {
    id: validId(backup.id), recordId: text(backup.recordId, 512), caseKey: text(backup.caseKey, 8192),
    ...(backup.recordPath === undefined ? {} : { recordPath: text(backup.recordPath, 8192) }),
    recordJson, selection: { value, start: selection.start, end: selection.end, message: text(selection.message, 32_768, true) },
    startedAt: backup.startedAt, input: cleanInput(backup.input)
  }
}

function cleanResult(result: DictationTranscribeResult): DictationTranscribeResult {
  requireValid(result && result.ok === true && (result.corrected === undefined || typeof result.corrected === 'boolean'))
  const clean: DictationTranscribeResult = { ok: true, text: text(result.text, MAX_TEXT_BYTES), corrected: result.corrected }
  if (result.fallback !== undefined) {
    requireValid(result.fallback === 'whisper-1')
    clean.fallback = result.fallback
  }
  if (result.segments !== undefined) {
    requireValid(Array.isArray(result.segments) && result.segments.length <= 100_000)
    clean.segments = result.segments.map((segment) => {
      requireValid(segment && Number.isFinite(segment.start) && segment.start >= 0 && Number.isFinite(segment.end) && segment.end >= segment.start)
      requireValid(segment.participantSource === undefined || segment.participantSource === 'voice' || segment.participantSource === 'context')
      return { speaker: text(segment.speaker, 512), text: text(segment.text, MAX_TEXT_BYTES), start: segment.start, end: segment.end,
        ...(segment.participantId === undefined ? {} : { participantId: text(segment.participantId, 512) }),
        ...(segment.participantSource === undefined ? {} : { participantSource: segment.participantSource }) }
    })
  }
  return clean
}

function decodeAudio(value: unknown, max: number): Uint8Array {
  requireValid(typeof value === 'string' && value.length > 0 && value.length <= Math.ceil(max / 3) * 4)
  const audio = Buffer.from(value, 'base64')
  requireValid(audio.byteLength > 0 && audio.byteLength <= max && audio.toString('base64') === value)
  return audio
}

async function read(id: string): Promise<StoredBackup | null> {
  const path = file(id)
  let info
  try { info = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  requireValid(info.isFile() && info.size <= MAX_FILE_BYTES)
  const stored = JSON.parse(await readFile(path, 'utf8'))
  requireValid(stored?.version === 1 && stored.backup?.id === id && stored.backup.input)
  const input = stored.backup.input
  requireValid(input.knownSpeakers === undefined || Array.isArray(input.knownSpeakers))
  const backup = cleanBackup({ ...stored.backup, input: {
    ...input, audio: decodeAudio(input.audio, MAX_AUDIO_BYTES),
    knownSpeakers: input.knownSpeakers?.map((item: Record<string, unknown>) => ({
      ...item, audio: decodeAudio(item?.audio, 320_044)
    }))
  } })
  return { backup, ...(stored.result === undefined ? {} : { result: cleanResult(stored.result) }) }
}

async function write(stored: StoredBackup): Promise<void> {
  await mkdir(root(), { recursive: true, mode: 0o700 })
  requireValid((await lstat(root())).isDirectory())
  await chmod(root(), 0o700)
  const { backup } = stored
  const contents = JSON.stringify({ version: 1, backup: { ...backup, input: {
    ...backup.input, audio: Buffer.from(backup.input.audio).toString('base64'),
    knownSpeakers: backup.input.knownSpeakers?.map((item) => ({ ...item, audio: Buffer.from(item.audio).toString('base64') }))
  } }, result: stored.result })
  requireValid(Buffer.byteLength(contents) <= MAX_FILE_BYTES)
  const temporary = join(root(), `${backup.id}.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(contents); await handle.sync() } finally { await handle.close() }
    await rename(temporary, file(backup.id))
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
  }
}

export async function saveDictationBackup(value: DictationBackup): Promise<void> {
  const backup = cleanBackup(value)
  await serialize(backup.id, async () => {
    const existing = await read(backup.id)
    if (existing) {
      requireValid(existing.backup.caseKey === backup.caseKey && existing.backup.recordId === backup.recordId)
      return
    }
    await write({ backup })
  })
}

export async function listDictationBackups(query: DictationBackupQuery): Promise<DictationBackup[]> {
  const caseKey = text(query?.caseKey, 8192)
  let names: string[]
  try { names = await readdir(root()) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const backups: DictationBackup[] = []
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/.test(name)) continue
    try {
      const stored = await serialize(name.slice(0, -5), () => read(name.slice(0, -5)))
      if (stored?.backup.caseKey === caseKey) backups.push(stored.backup)
    } catch { /* Keep damaged backups on disk without hiding the other recoverable recordings. */ }
  }
  return backups.sort((a, b) => a.startedAt - b.startedAt)
}

export async function removeDictationBackup(id: string): Promise<void> {
  transcriptions.get(id)?.controller.abort()
  await serialize(id, async () => {
    await unlink(file(id)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
  })
}

export async function transcribeWithBackup(input: DictationTranscribeInput & { backupId?: string }): Promise<DictationTranscribeResult> {
  if (input.backupId === undefined) return transcribe(input)
  const id = validId(input.backupId)
  const running = transcriptions.get(id)
  if (running) return running.promise
  const controller = new AbortController()
  const run = (async () => {
    const stored = await serialize(id, async () => {
      const current = await read(id)
      if (!current) throw new Error('저장된 전사 복구 음성이 없습니다.')
      if (!current.result) {
        current.backup.input = cleanInput({ ...current.backup.input,
          ...(input.context === undefined ? {} : { context: input.context }),
          ...(input.knownSpeakers === undefined ? {} : { knownSpeakers: input.knownSpeakers }) })
        await write(current)
      }
      return current
    })
    if (stored.result) return stored.result
    const result = await transcribe(stored.backup.input, controller.signal)
    if (result.ok) await serialize(id, async () => {
      // A user can discard a recording while its request is still running.
      if (await read(id)) await write({ backup: stored.backup, result: cleanResult(result) })
    })
    return result
  })()
  transcriptions.set(id, { promise: run, controller })
  void run.finally(() => { if (transcriptions.get(id)?.promise === run) transcriptions.delete(id) }).catch(() => undefined)
  return run
}
