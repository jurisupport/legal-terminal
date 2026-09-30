# 영상·음성 리뷰

탐색기에서 MP4/WebM 또는 MP3/WAV 등의 파일을 열면 미디어 탭에서 재생합니다. FFmpeg와 Remotion 어느 쪽에서 만든 결과든 같은 방법으로 검토합니다. 실제 재생 가능 여부는 파일 안의 코덱에 따라 달라집니다.

1. 원하는 장면에서 일시정지하거나 구간 시작/끝을 지정합니다.
2. 장면 또는 구간 질문을 누르면 선택 시간·리뷰 버전·화면 캡처가 같은 작업환경의 Agent 입력창에 첨부됩니다.
3. 수정할 내용을 입력하고 전송합니다. 음성은 구간과 파일을 전달하며 전사문을 자동으로 만들지 않습니다.
4. 제작이 끝나면 새 버전 보기 또는 새로고침으로 결과를 확인합니다. 이전 버전도 선택할 수 있습니다.

SSH 프로젝트에서는 영상을 로컬 디스크에 내려받은 뒤 재생합니다. 전송 중에는 취소할 수 있으며, 이미 받은 영상은 연결이 끊겨도 재생할 수 있습니다. 캡처는 원격 Agent가 읽을 수 있는 프로젝트 폴더로 전달됩니다. 원본과 다른 SSH 작업환경의 Agent를 선택하면 먼저 해당 작업환경으로 전환해야 합니다.

## 제작 스크립트와 완료 알림 연결

단순 파일 열기는 별도 설정 없이 사용합니다. 자동으로 새 결과를 찾아 제시하려면, 제작 프로세스가 **성공한 뒤에만** 다음 게시 도우미를 실행합니다. 이 도우미는 완성 파일을 고유 이름으로 보존하고 `.legal-terminal/media.json` 완료 기록을 원자적으로 갱신합니다. 제작 원본은 보존합니다.

```sh
node /path/to/legal-terminal/scripts/publish-media.mjs /path/to/shorts ffmpeg output.mp4 render.py
node /path/to/legal-terminal/scripts/publish-media.mjs /path/to/shorts remotion out/video.mp4 src/index.ts
```

도우미는 렌더링을 실행하거나 성공 여부를 추측하지 않습니다. 기존 제작 스크립트에서 종료 코드 0을 확인한 뒤 호출해야 합니다. 원격에서는 도우미 파일을 해당 환경에 복사해 실행할 수 있습니다.

완료 기록 형식:

```json
{
  "version": 1,
  "engine": "remotion",
  "entry": "src/index.ts",
  "completed": {
    "version": "unique-render-id",
    "path": ".legal-terminal/media-versions/unique-render-id.mp4",
    "completedAt": "2026-10-01T00:00:00.000Z"
  }
}
```

경로는 프로젝트 안의 상대 경로여야 합니다. 렌더링 중인 파일을 이 기록에 넣지 않습니다. 새 버전은 검토자가 선택한 뒤 표시되며, 앞부분 길이가 달라졌다면 같은 초가 같은 장면을 의미하지 않을 수 있습니다.

Remotion의 렌더링 전 미리보기 설정은 `docs/remotion-preview.md`를 참고하세요. 이 기능도 기존 AI 대화에 선택 프레임을 첨부합니다.


일반 미디어 검증은 `scripts/fixtures/media-review`의 합성 MP4/WAV를 사용하므로 FFmpeg 설치 없이 실행할 수 있습니다. 이 샘플은 2초 단색 H.264 영상과 440Hz 음성입니다. Remotion의 별도 최종 렌더 검사는 FFmpeg와 프로젝트 패키지를 사용합니다.
