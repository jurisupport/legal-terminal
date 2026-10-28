# Remotion 렌더링 전 미리보기

프로젝트 폴더에서 Remotion 미리보기를 열면 프로젝트에 설치된 `@remotion/player`와 `@remotion/bundler`로 소스를 준비합니다. MP4를 먼저 만들 필요가 없습니다. 컴포넌트 변경 후 **소스 변경 불러오기**를 누르고, 원하는 프레임에서 **이 장면 AI에게 질문**을 누르면 화면·프레임·시간·컴포넌트 경로가 앱으로 전달됩니다. 대화창에서 실제 첨부 준비 상태를 확인할 수 있습니다. `여기부터 / 여기까지`로 구간도 지정할 수 있습니다. 최종 MP4 검토는 일반 미디어 뷰어를 사용합니다.

## 프로젝트 설정

기존 프로젝트에 `.legal-terminal/remotion.json`을 추가합니다. Player에는 `<Composition>` 목록을 등록한 루트가 아니라 실제 영상 컴포넌트를 연결해야 합니다.

```json
{
  "component": "src/MyComposition.tsx",
  "exportName": "MyComposition",
  "compositionId": "MyVideo",
  "width": 1080,
  "height": 1920,
  "fps": 30,
  "durationInFrames": 900,
  "props": { "title": "첫 번째 쇼츠" }
}
```

- `component`는 프로젝트 안의 파일 경로입니다. `exportName`은 해당 파일의 named export이며 default export이면 생략합니다.
- 크기·fps·길이·props는 최종 렌더에 쓰는 composition과 맞춥니다. `calculateMetadata`를 사용하는 프로젝트는 계산 결과를 여기에 기록합니다. 자동으로 프로젝트의 등록 목록이나 동적 메타데이터를 추측하지 않습니다.
- 한 설정에는 한 composition을 연결합니다. 다른 설정 파일이 필요하면 `open({projectDir, entryPoint: '.legal-terminal/another.json'})`을 사용할 수 있습니다.
- 프로젝트에 `remotion`, `@remotion/player`, `@remotion/bundler`, `react`, `react-dom`이 설치되어 있어야 합니다. Remotion 패키지 버전은 프로젝트의 기존 버전에 맞춥니다. 터미널 앱에는 Remotion 의존성을 추가하지 않습니다.
- 표준 Remotion 번들러로 처리되는 TSX·CSS·폰트를 지원합니다. `remotion.config.ts`의 사용자 webpack override를 자동 실행하지 않으므로 별도 Tailwind/특수 loader 설정이 필요한 프로젝트는 기본 번들러에 맞는 미리보기 컴포넌트를 준비해야 합니다.
- `public/` 파일과 `staticFile()`을 지원합니다. HTTPS 외부 이미지·미디어·폰트도 브라우저의 CORS 규칙 안에서 불러옵니다. 공개 자산 밖으로 향하는 심볼릭 링크는 제공하지 않습니다.

최소 컴포넌트 예제:

```tsx
import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
export const MyComposition = ({title}: {title: string}) => (
  <AbsoluteFill style={{background: '#153c75', color: 'white', fontSize: 64,
    alignItems: 'center', justifyContent: 'center'}}>
    {title} · {useCurrentFrame()} 프레임
  </AbsoluteFill>
);
```

## 로컬·SSH 동작

로컬 프로젝트는 별도 자식 프로세스에서 준비합니다. SSH 프로젝트 경로는 기존 `ssh://프로필ID/절대경로` 형식을 사용합니다. 원격의 `node`가 비대화식 SSH 환경에서도 실행 가능해야 하며, 원격 macOS/Linux의 POSIX 셸을 사용합니다. 설치된 SSH 프로필의 키·사용자·포트·호스트키 정책을 그대로 사용합니다.

미리보기 서버는 `127.0.0.1`의 임의 포트에만 바인딩하고, SSH 전달도 양쪽 모두 loopback 주소를 사용합니다. 세션별 비밀 주소와 HttpOnly 쿠키로 자산 접근을 제한합니다. 선택 요청은 세션 토큰과 정확한 Origin을 검사합니다. 페이지에는 앱 preload나 Node API가 없으며 sandbox/contextIsolation을 켭니다. 임의 페이지 이동·새 창·다운로드·권한 요청은 차단합니다.

앱이 시작한 프로젝트 프로세스와 SSH 터널만 소유합니다. 창 닫기·작업 창 닫기·앱 종료 시 EOF를 전달해 프로젝트 안의 `.lt-remotion-preview-*` 임시 번들을 지우고 연결을 닫습니다. 연결이 끊긴 미리보기는 다시 열면 새 세션으로 연결합니다. 기존 외부 Studio 서버를 종료하지 않습니다.

## 화면과 버전의 의미

- 프레임은 0부터 시작하고 초 단위 위치는 `frame / fps`입니다. 구간 `endFrame`은 끝을 포함하지 않습니다.
- 캡처는 일시정지한 **현재 Player 화면 영역**을 Electron에서 이미지로 가져옵니다. 이미지·폰트·영상 버퍼링과 디코딩을 기다린 뒤 캡처하며, 10초 내 준비되지 않으면 첨부하지 않고 오류를 표시합니다. 이미지는 긴 변 1920px 이하, 5MiB 이하 JPEG입니다. 최종 렌더 해상도의 정지 프레임을 새로 생성하는 방식은 아닙니다. 화면에 보이는 DOM·CSS·한글/영문을 함께 캡처합니다.
- 버전 값은 준비된 JavaScript/CSS와 설정 JSON의 해시입니다. `public/` 및 외부 URL 자산을 변경 불가능한 스냅샷으로 보관하지 않습니다. 따라서 이 값만으로 모든 자산이나 최종 렌더의 동일성을 보장하지 않습니다. 첨부한 캡처가 검토 당시 화면 기록입니다.
- 이전 소스 버전을 자동 보관/복원하거나 Studio 전체를 대체하지 않습니다. 정확한 과거 영상 비교는 버전별로 완성 MP4를 저장하고 미디어 뷰어로 검토합니다.
- 전사·음성 합성·최종 렌더는 기존 제작 Agent와 FFmpeg/Remotion 작업 흐름을 사용합니다.

## 검증

```sh
node scripts/verify-remotion-preview.mjs --install-fixture
node scripts/verify-remotion-preview.mjs
# 선택 검사: 설치된 Chrome으로 실제 Remotion MP4 렌더
node scripts/verify-remotion-render.mjs
```

첫 명령은 `.omx/remotion-fixture`에만 고정 버전 Remotion 4.0.409, React 18.3.1을 설치합니다. 앱 package.json과 잠금 파일은 바꾸지 않습니다. 스크립트는 실제 Electron Player의 프레임·캡처·소스 변경·한/영 텍스트·public 이미지/음성/영상 자산, Origin/토큰 검증, 앱 API 격리, 창 닫기/실패 시 임시 파일·포트 정리를 확인합니다. FFmpeg로 만든 영상의 요청을 2.5초 지연시켜 준비를 기다리는지 확인하고, 37프레임의 빨간 장면과 5프레임으로 탐색한 파란 장면의 캡처를 비교합니다. SSH는 일회용 키와 known_hosts를 사용하는 로컬 SSH 서버에 실제 OpenSSH로 연결해 실행·포트 전달·종료를 검증합니다. 사용자의 SSH 설정 파일은 바꾸지 않습니다. 테스트에는 설치된 FFmpeg/OpenSSH가 필요합니다.

별도 최종 출력 검사는 같은 Fixture를 `registerRoot`/`Composition`으로 등록하고 공개 `bundle` → `selectComposition` → `renderMedia` API로 MP4를 만듭니다. 프로젝트 소스와 앱 의존성은 바꾸지 않습니다. 설치된 Chrome을 사용하며, 다른 위치라면 `REMOTION_BROWSER_EXECUTABLE`로 지정합니다. 결과는 `.omx/media-verification/remotion-final.mp4`와 같은 폴더의 프레임 PNG/결과 JSON에 남습니다.

macOS 합성 샘플의 실제 검증 결과: **H.264/AAC, 360×640, 30fps, 90프레임**. 영상 스트림은 3.000초이고 AAC 패딩을 포함한 컨테이너는 3.050667초였습니다. 최종 MP4에서 추출한 5프레임은 파란색(RGB 0,13,255), 37프레임은 빨간색(RGB 255,26,1)으로 Player의 동일 시점 캡처와 일치했습니다. 이 검사는 장면과 시점의 일치를 확인하며 디스플레이 색상 프로필까지 포함한 전체 픽셀 동일성을 주장하지 않습니다.

사용자의 실제 원격 서버에서 회선 중단·대용량 외부 미디어를 확인하는 검증과 Windows에서의 실행 검증은 별도로 필요합니다. macOS 합성 샘플 결과를 실제 제작 프로젝트나 Windows 검증으로 간주하지 않습니다.

공식 API 근거: [Player](https://www.remotion.dev/docs/player/player), [bundle()](https://www.remotion.dev/docs/bundle), [Electron 보안](https://www.electronjs.org/docs/latest/tutorial/security). Player를 직접 연결하므로 공개 컴포넌트 API만 사용하며 등록 목록을 읽기 위한 Remotion 내부 API에 의존하지 않습니다.
