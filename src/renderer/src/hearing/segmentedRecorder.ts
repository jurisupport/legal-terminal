import workletSource from './dictationRecorder.worklet.js?raw'

export interface RecordedSegment {
  audio: Uint8Array
  startSeconds: number
  final: boolean
}

export interface SegmentedRecorder {
  stop(): Promise<void>
  dispose(): void
}

const modules = new WeakMap<BaseAudioContext, Promise<void>>()

export async function createSegmentedRecorder(
  context: BaseAudioContext,
  source: AudioNode,
  segmentSeconds: number,
  onSegment: (segment: RecordedSegment) => void,
  onError: (error: Error) => void
): Promise<SegmentedRecorder> {
  const segmentFrames = Math.round(context.sampleRate * segmentSeconds)
  if (!Number.isInteger(context.sampleRate) || context.sampleRate <= 0 ||
    !Number.isFinite(segmentSeconds) || segmentSeconds <= 0 ||
    !Number.isSafeInteger(segmentFrames) || segmentFrames < 1 || 44 + segmentFrames * 2 >= 25_000_000) {
    throw new Error('녹음 구간의 길이 또는 오디오 형식이 올바르지 않습니다.')
  }
  let module = modules.get(context)
  if (!module) {
    const url = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }))
    module = context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
    modules.set(context, module)
    module.catch(() => modules.delete(context))
  }
  await module
  const node = new AudioWorkletNode(context, 'dictation-recorder', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { segmentFrames }
  })
  let disposed = false
  let failure: Error | undefined
  let stopping: Promise<void> | undefined
  let resolveStop: (() => void) | undefined
  let rejectStop: ((error: Error) => void) | undefined
  const dispose = () => {
    if (disposed) return
    disposed = true
    node.port.onmessage = null
    node.onprocessorerror = null
    node.port.postMessage('stop')
    node.port.close()
    try { source.disconnect(node) } catch { /* The source may already be disconnected. */ }
    node.disconnect()
    rejectStop?.(failure ?? new Error('녹음이 종료되기 전에 연결이 해제되었습니다.'))
  }
  const fail = (error: Error) => {
    if (disposed) return
    failure = error
    dispose()
    onError(error)
  }
  node.port.onmessage = ({ data }: MessageEvent<RecordedSegment | { stopped: true }>) => {
    if ('stopped' in data) {
      resolveStop?.()
      rejectStop = undefined
      dispose()
    } else {
      try { onSegment(data) } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }
  node.onprocessorerror = () => fail(new Error('오디오 녹음 처리가 중단되었습니다. 저장된 구간은 복구할 수 있습니다.'))
  try {
    source.connect(node)
    node.connect(context.destination)
  } catch (error) {
    dispose()
    throw error
  }
  return {
    stop() {
      if (stopping) return stopping
      if (failure) return Promise.reject(failure)
      if (disposed) return Promise.resolve()
      stopping = new Promise<void>((resolve, reject) => {
        resolveStop = resolve
        rejectStop = reject
      })
      node.port.postMessage('stop')
      return stopping
    },
    dispose
  }
}
