export type TextEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be'

export interface DecodedText {
  text: string
  encoding: TextEncoding
  truncated: boolean
}

function evenLength(buf: Buffer): Buffer {
  return buf.length % 2 === 0 ? buf : buf.subarray(0, buf.length - 1)
}

function decodeUtf16Be(buf: Buffer): string {
  const src = evenLength(buf)
  const swapped = Buffer.allocUnsafe(src.length)
  for (let i = 0; i < src.length; i += 2) {
    swapped[i] = src[i + 1]
    swapped[i + 1] = src[i]
  }
  return swapped.toString('utf16le')
}

export function decodeTextBuffer(buf: Buffer, maxBytes = buf.length): DecodedText {
  const truncated = buf.length > maxBytes
  const slice = buf.subarray(0, Math.min(buf.length, maxBytes))

  if (slice.length >= 2 && slice[0] === 0xfe && slice[1] === 0xff) {
    return { text: decodeUtf16Be(slice.subarray(2)), encoding: 'utf16be', truncated }
  }

  if (slice.length >= 2 && slice[0] === 0xff && slice[1] === 0xfe) {
    return { text: evenLength(slice.subarray(2)).toString('utf16le'), encoding: 'utf16le', truncated }
  }

  if (slice.length >= 3 && slice[0] === 0xef && slice[1] === 0xbb && slice[2] === 0xbf) {
    return { text: slice.subarray(3).toString('utf8'), encoding: 'utf8-bom', truncated }
  }

  return { text: slice.toString('utf8'), encoding: 'utf8', truncated }
}
