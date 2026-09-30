export interface RemotionPreviewOptions {
  projectDir: string
  /** Optional bridge JSON path, relative to the project. */
  entryPoint?: string
  frame?: number
  compositionId?: string
}

export interface RemotionPreviewSelection {
  sessionId: string
  projectDir: string
  sourcePath: string
  compositionId: string
  frame: number
  fps: number
  durationInFrames: number
  startFrame: number
  /** Exclusive upper bound, like media endSeconds. */
  endFrame?: number
  version: string
  captureDataUrl: string
}

export interface RemotionPreviewResult {
  ok: boolean
  sessionId?: string
  error?: string
}

export interface RemotionBridge {
  component: string
  exportName?: string
  compositionId: string
  width: number
  height: number
  fps: number
  durationInFrames: number
  props?: Record<string, unknown>
}
