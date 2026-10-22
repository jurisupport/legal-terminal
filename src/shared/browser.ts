export type BrowserLocation = 'local' | 'remote'
export type BrowserQuality = 'saver' | 'standard'

export interface BrowserTraffic {
  receivedBytes: number
  sentBytes: number
  startedAt: number
}

export interface BrowserTab { id: string; title: string; url: string }
export interface BrowserState {
  id: string
  agentSessionId: string
  location: BrowserLocation
  profileLabel?: string
  url: string
  title: string
  tabs: BrowserTab[]
  activeTabId: string
  downloadPath: string
  traffic: BrowserTraffic
  connected: boolean
}

export type BrowserCommand =
  | { action: 'navigate' | 'new_tab'; url: string }
  | { action: 'back' | 'forward' | 'reload' }
  | { action: 'switch_tab' | 'close_tab'; tabId: string }
  | { action: 'click'; x: number; y: number; button?: 'left' | 'right'; clickCount?: number }
  | { action: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
  | { action: 'type'; text: string }
  | { action: 'key'; key: string; code?: string; modifiers?: number }

export interface BrowserFrame {
  dataUrl?: string
  etag?: string
  width: number
  height: number
  state: BrowserState
}

export interface BrowserApi {
  open(input: { agentSessionId: string; location: BrowserLocation; profileId?: string }): Promise<BrowserState>
  state(id: string): Promise<BrowserState>
  command(id: string, command: BrowserCommand): Promise<BrowserState>
  frame(id: string, quality: BrowserQuality, etag?: string): Promise<BrowserFrame>
  bounds(id: string, bounds: { x: number; y: number; width: number; height: number } | null): Promise<void>
  close(id: string): Promise<void>
}
