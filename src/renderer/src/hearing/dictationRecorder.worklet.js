class DictationRecorder extends AudioWorkletProcessor {
  constructor({ processorOptions: { segmentFrames } }) {
    super()
    if (!Number.isSafeInteger(segmentFrames) || segmentFrames < 1 || 44 + segmentFrames * 2 >= 25_000_000) {
      throw new Error('Invalid recording segment size')
    }
    this.segmentFrames = segmentFrames
    this.frames = 0
    this.startFrame = 0
    this.stopped = false
    this.audio = new Uint8Array(44 + segmentFrames * 2)
    this.view = new DataView(this.audio.buffer)
    this.port.onmessage = ({ data }) => {
      if (data !== 'stop' || this.stopped) return
      this.stopped = true
      if (this.frames) this.emitSegment(true)
      this.port.postMessage({ stopped: true })
    }
  }

  emitSegment(final) {
    const audio = final ? this.audio.slice(0, 44 + this.frames * 2) : this.audio
    const view = new DataView(audio.buffer)
    for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) {
      for (let index = 0; index < value.length; index++) audio[offset + index] = value.charCodeAt(index)
    }
    view.setUint32(4, audio.length - 8, true)
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    view.setUint32(40, this.frames * 2, true)
    this.port.postMessage({ audio, startSeconds: this.startFrame / sampleRate, final }, [audio.buffer])
    this.startFrame += this.frames
    this.frames = 0
    if (!final) {
      this.audio = new Uint8Array(44 + this.segmentFrames * 2)
      this.view = new DataView(this.audio.buffer)
    }
  }

  process(inputs) {
    if (this.stopped) return false
    const channels = inputs[0]
    if (!channels?.length) return true
    for (let frame = 0; frame < channels[0].length; frame++) {
      let sample = 0
      for (const channel of channels) sample += channel[frame] / channels.length
      sample = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0
      this.view.setInt16(44 + this.frames * 2, Math.round(sample * (sample < 0 ? 0x8000 : 0x7fff)), true)
      if (++this.frames === this.segmentFrames) this.emitSegment(false)
    }
    // The silent output keeps capture processing active without microphone feedback.
    return true
  }
}

registerProcessor('dictation-recorder', DictationRecorder)
