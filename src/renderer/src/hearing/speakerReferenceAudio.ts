interface ReferenceSegment {
  speaker: string
  start: number
  end: number
  text: string
}

export interface SpeakerReferenceAudio {
  speaker: string
  segmentIndex: number
  start: number
  end: number
  audio: Uint8Array
}

const SAMPLE_RATE = 16_000
const MIN_SECONDS = 2
const MAX_SECONDS = 8
const EDGE_MARGIN = 0.05

export async function extractSpeakerReferences(
  audio: Uint8Array,
  segments: ReferenceSegment[]
): Promise<SpeakerReferenceAudio[]> {
  if (!audio?.byteLength || !Array.isArray(segments)) return []
  const ordered = segments.flatMap((segment, segmentIndex) => {
    if (!segment || typeof segment.speaker !== 'string' || !segment.speaker.trim() ||
      !Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
      segment.start < 0 || segment.end <= segment.start) return []
    return [{ ...segment, segmentIndex, overlaps: false }]
  }).sort((a, b) => a.start - b.start)

  // The two farthest ends from distinct speakers detect earlier overlaps in constant time.
  let farthest: typeof ordered[number] | undefined
  let second: typeof ordered[number] | undefined
  for (const segment of ordered) {
    const other = farthest?.speaker === segment.speaker ? second : farthest
    segment.overlaps = !!other && other.end > segment.start
    if (!farthest || segment.end > farthest.end) {
      if (farthest?.speaker !== segment.speaker) second = farthest
      farthest = segment
    } else if (segment.speaker !== farthest.speaker && (!second || segment.end > second.end)) {
      second = segment
    }
  }
  // In start order, only the nearest later segment from another speaker can matter.
  let nextOther: typeof ordered[number] | undefined
  for (let index = ordered.length - 2; index >= 0; index--) {
    const segment = ordered[index]
    if (segment.speaker !== ordered[index + 1].speaker) nextOther = ordered[index + 1]
    if (nextOther && nextOther.start < segment.end) segment.overlaps = true
  }
  const candidates = ordered.filter((segment) => !segment.overlaps &&
    typeof segment.text === 'string' && segment.text.trim() && segment.end - segment.start >= MIN_SECONDS
  ).sort((a, b) => (b.end - b.start) - (a.end - a.start))
  if (!candidates.length) return []

  try {
    // decodeAudioData may detach its input; decode a copy and resample at 16 kHz.
    const decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(new Uint8Array(audio).buffer)
    if (decoded.sampleRate !== SAMPLE_RATE || decoded.numberOfChannels < 1) return []
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index))
    const references: SpeakerReferenceAudio[] = []
    const speakers = new Set<string>()
    for (const segment of candidates) {
      if (speakers.has(segment.speaker) || segment.end > decoded.length / SAMPLE_RATE) continue
      let first = Math.ceil(segment.start * SAMPLE_RATE)
      let last = Math.floor(segment.end * SAMPLE_RATE)
      const margin = EDGE_MARGIN * SAMPLE_RATE
      if (last - first >= (MIN_SECONDS * SAMPLE_RATE) + margin * 2) {
        first += margin
        last -= margin
      }
      last = Math.min(last, first + MAX_SECONDS * SAMPLE_RATE)
      const frames = last - first
      if (frames < MIN_SECONDS * SAMPLE_RATE) continue
      const wav = new Uint8Array(44 + frames * 2)
      const view = new DataView(wav.buffer)
      let audible = false
      let finite = true
      for (let frame = 0; frame < frames; frame++) {
        let sample = 0
        for (const channel of channels) sample += channel[first + frame] / channels.length
        if (!Number.isFinite(sample)) { finite = false; break }
        sample = Math.max(-1, Math.min(1, sample))
        const pcm = Math.round(sample * (sample < 0 ? 0x8000 : 0x7fff))
        if (pcm) audible = true
        view.setInt16(44 + frame * 2, pcm, true)
      }
      if (!audible || !finite) continue
      for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
        for (let index = 0; index < value.length; index++) wav[offset + index] = value.charCodeAt(index)
      }
      view.setUint32(4, wav.length - 8, true)
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, SAMPLE_RATE, true)
      view.setUint32(28, SAMPLE_RATE * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      view.setUint32(40, frames * 2, true)
      references.push({ speaker: segment.speaker, segmentIndex: segment.segmentIndex,
        start: first / SAMPLE_RATE, end: last / SAMPLE_RATE, audio: wav })
      speakers.add(segment.speaker)
      if (references.length === 4) break
    }
    return references
  } catch {
    // A missing reference must never discard an otherwise successful transcript.
    return []
  }
}
