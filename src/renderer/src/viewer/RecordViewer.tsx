import { useEffect, useRef, useState } from 'react'
import PdfViewer from './PdfViewer'

export interface RecordItem {
  path: string
  label: string
}

/**
 * 하나의 탭이 곧 하나의 문서지만, 목록(items) 안에서의 위치를 알고 있어
 * 마지막/첫 페이지에서 다음/이전 문서로 **탭 생성 없이** 이어서 넘어간다(흐름).
 * 시작 문서는 startPath. 현재 문서가 바뀌면 onCurrent로 알려 탭 제목/식별을 갱신한다.
 */
export default function RecordViewer({
  items,
  startPath,
  cropOn,
  cropRatio,
  onCropOn,
  onCropRatio,
  onCurrent,
  onAskDoc
}: {
  items: RecordItem[]
  startPath: string
  cropOn: boolean
  cropRatio: number
  onCropOn: (v: boolean) => void
  onCropRatio: (r: number) => void
  onCurrent?: (item: RecordItem) => void
  onAskDoc?: () => void
}): JSX.Element {
  // 시작 문서 인덱스 (마운트 시 1회). 이후엔 내부 이동이 주도.
  const [index, setIndex] = useState(() => {
    const i = items.findIndex((it) => it.path === startPath)
    return i >= 0 ? i : 0
  })

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, items.length - 1)))
  }, [items.length])

  const cur = items[index]
  const onCurrentRef = useRef(onCurrent)
  onCurrentRef.current = onCurrent

  // 현재 문서가 바뀌면 보고 (탭 제목·식별 경로 갱신)
  useEffect(() => {
    if (cur) onCurrentRef.current?.(cur)
  }, [cur?.path]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!cur)
    return (
      <div className="welcome">
        <p className="muted">표시할 문서가 없습니다.</p>
      </div>
    )

  return (
    <PdfViewer
      key={cur.path}
      path={cur.path}
      cropOn={cropOn}
      cropRatio={cropRatio}
      onCropOn={onCropOn}
      onCropRatio={onCropRatio}
      onNextDoc={() => setIndex((i) => Math.min(items.length - 1, i + 1))}
      onPrevDoc={() => setIndex((i) => Math.max(0, i - 1))}
      onAskDoc={onAskDoc}
    />
  )
}
