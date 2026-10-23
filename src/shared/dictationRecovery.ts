import type { DictationTranscribeInput } from '../main/dictation'

export interface DictationBackup {
  id: string
  recordId: string
  recordPath?: string
  caseKey: string
  recordJson: string
  selection: { value: string; start: number; end: number; message: string }
  startedAt: number
  input: DictationTranscribeInput
}

export interface DictationBackupQuery {
  caseKey: string
}
