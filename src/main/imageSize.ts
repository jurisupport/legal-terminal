// PNG/JPEG 바이트에서 형식과 픽셀 크기를 읽는다 (외부 의존성 없음).
// 로고 등 작은 이미지를 hwpx에 넣을 때 원본 크기(HWPUNIT 환산)가 필요해서 쓴다.

export interface ImageInfo {
  mime: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

export function imageInfo(buf: Buffer): ImageInfo | null {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    if (buf.length < 24) return null
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1
        continue
      }
      const marker = buf[i + 1]
      if (marker === 0xff) {
        i += 1
        continue
      }
      // SOF0~SOF15 (허프만표 C4, 재시작 C8, 산술조건 CC 제외)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          mime: 'image/jpeg',
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7)
        }
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2
        continue
      }
      i += 2 + buf.readUInt16BE(i + 2)
    }
  }
  return null
}
