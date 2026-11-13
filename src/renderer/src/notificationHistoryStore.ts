import { isSharedNotificationEntry, isSharedUiOperation, type SharedNotificationEntry, type SharedUiOperation } from '../../shared/sharedUiState'

export interface NotificationEntry extends SharedNotificationEntry { host: string }
export const NOTIFICATION_HISTORY_KEY = 'notification-history-v1'
export const NOTIFICATION_OUTBOX_KEY = 'notification-outbox-v1'
type ReadStorage = Pick<Storage, 'getItem' | 'key' | 'length'>
type WriteStorage = ReadStorage & Pick<Storage, 'setItem' | 'removeItem'>
export interface PendingNotificationOperation { host: string; operation: SharedUiOperation }

const validHost = (host: unknown): host is string => typeof host === 'string' && host.length > 0 && host.length <= 4096
const entryKey = (entry: NotificationEntry): string => `${NOTIFICATION_HISTORY_KEY}:${JSON.stringify([entry.host, entry.id])}`
const operationKey = (host: string, id: string): string => `${NOTIFICATION_OUTBOX_KEY}:${JSON.stringify([host, id])}`
const storedKeys = (storage: ReadStorage, prefix: string): string[] => {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key?.startsWith(`${prefix}:`)) keys.push(key)
  }
  return keys
}
const validEntry = (entry: unknown): entry is NotificationEntry => isSharedNotificationEntry(entry) &&
  validHost((entry as NotificationEntry).host)

export function limitNotificationHistory(entries: NotificationEntry[]): NotificationEntry[] {
  const unique = new Map<string, NotificationEntry>()
  for (const entry of entries) {
    const key = JSON.stringify([entry.host, entry.id])
    if (!unique.has(key)) unique.set(key, entry)
  }
  return [...unique.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 100)
}

function storedHistory(storage: ReadStorage): NotificationEntry[] {
  return storedKeys(storage, NOTIFICATION_HISTORY_KEY).flatMap((key) => {
    const raw = storage.getItem(key)
    if (raw === null) return [] // Another window may have cleared it since enumeration.
    const entry: unknown = JSON.parse(raw)
    if (!validEntry(entry) || entryKey(entry) !== key) throw new Error('저장된 알림 기록을 읽을 수 없습니다.')
    return [entry]
  })
}

export function readNotificationHistory(storage: ReadStorage): NotificationEntry[] {
  return limitNotificationHistory(storedHistory(storage))
}

export function writeNotificationHistory(storage: WriteStorage, entries: NotificationEntry[], previous: NotificationEntry[]): NotificationEntry[] {
  if (!entries.every(validEntry) || !previous.every(validEntry)) throw new Error('저장할 알림 기록 형식이 올바르지 않습니다.')
  storedHistory(storage) // Validate before replacing or pruning any stored records.
  const next = new Map(limitNotificationHistory(entries).map((entry) => [entryKey(entry), entry]))
  const prior = new Map(previous.map((entry) => [entryKey(entry), entry]))
  for (const key of prior.keys()) if (!next.has(key)) storage.removeItem(key)
  for (const [key, entry] of next) {
    if (JSON.stringify(prior.get(key)) !== JSON.stringify(entry)) storage.setItem(key, JSON.stringify(entry))
  }
  const stored = storedHistory(storage)
  const retained = limitNotificationHistory(stored)
  const retainedKeys = new Set(retained.map(entryKey))
  for (const entry of stored) if (!retainedKeys.has(entryKey(entry))) storage.removeItem(entryKey(entry))
  return retained
}

export function readNotificationOutbox(storage: ReadStorage): PendingNotificationOperation[] {
  return storedKeys(storage, NOTIFICATION_OUTBOX_KEY).flatMap((key) => {
    const raw = storage.getItem(key)
    if (raw === null) return []
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') throw new Error('알림 동기화 대기 기록을 읽을 수 없습니다.')
    const pending = value as PendingNotificationOperation
    if (!validHost(pending.host) || !isSharedUiOperation(pending.operation) ||
      !['notification', 'notification-clear'].includes(pending.operation.type) ||
      operationKey(pending.host, pending.operation.id) !== key) throw new Error('알림 동기화 대기 기록을 읽을 수 없습니다.')
    return [pending]
  }).sort((a, b) => Number(a.operation.type === 'notification-clear') - Number(b.operation.type === 'notification-clear'))
}

export function saveNotificationOperation(storage: Pick<Storage, 'setItem'>, host: string, operation: SharedUiOperation): void {
  if (!validHost(host) || !isSharedUiOperation(operation) || !['notification', 'notification-clear'].includes(operation.type)) {
    throw new Error('알림 동기화 요청 형식이 올바르지 않습니다.')
  }
  storage.setItem(operationKey(host, operation.id), JSON.stringify({ host, operation }))
}

export function removeNotificationOperation(storage: Pick<Storage, 'removeItem'>, host: string, id: string): void {
  storage.removeItem(operationKey(host, id))
}

export function notificationEventId(caseKey: string, termId: string, run: { runId: string; sequence: number }, status: string): string {
  return JSON.stringify(['notification', caseKey, termId, run.runId, run.sequence, status])
}
