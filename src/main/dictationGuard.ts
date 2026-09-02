function compactLength(text: string): number {
  return text.replace(/\s+/g, '').length
}

function protectedTokens(text: string): string[] {
  const pattern =
    /(?:\d+(?:[.,:/-]\d+)*(?:\s*(?:원|만원|천원|억원|억|만|년|월|일|시|분|초|호|건|명|회|%))?)|않|못|없|아니|(?:^|\s)안(?=\s)/g
  return [...text.normalize('NFKC').matchAll(pattern)]
    .map((match) => match[0].trim())
    .filter(Boolean)
}

export function shouldUseDictationCorrection(rawText: string, correctedText: string): boolean {
  const raw = rawText.trim()
  const corrected = correctedText.trim()
  if (!raw || !corrected) return false
  if (protectedTokens(raw).join('\u0000') !== protectedTokens(corrected).join('\u0000')) return false
  const rawLength = compactLength(raw)
  const lengthLimit = Math.max(3, Math.ceil(rawLength * 0.15))
  return Math.abs(rawLength - compactLength(corrected)) <= lengthLimit
}
