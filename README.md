# legal-terminal

**대한민국 송무 변호사를 위한 AI 통합 작업환경.**
사건 기록을 **읽고**, AI와 함께 서면을 **쓰고**, 사건·기일을 **관리하는** 흐름을 한 화면에 담았습니다.

- **AI 송무 비서** — 사건 폴더에서 Claude Code가 실행되어, 기록 분석·인용 검증·서면 초안을 같은 화면에서
- **준비서면 에디터** — 라이브 프리뷰·편집 가능한 표·PDF 내보내기까지 (Markdown 기반)
- **전자소송기록 뷰어** — 전자소송기록 PDF를 문서/서증/첨부서류로 자동 분류해 탐색
- **사건 대시보드** — JuriSupport와 연동해 사건·기일·당사자를 한눈에, 클릭 한 번으로 작업환경 진입

![legal-terminal](screenshots/app.png)

> 따로 떠 있던 터미널의 `claude`, 별도 에디터, 전자소송기록 뷰어를 **한 화면에 통합**했습니다. 기존 `jurisupport-plugins` 생태계(songmu-legal 플러그인, korean-law MCP, 법령·판례·사건기록 토킷, PII 보호 훅)는 **교체가 아니라 그대로 살려** 동작합니다.

## 다운로드 / 설치

[**Releases**](https://github.com/jurisupport/legal-terminal/releases)에서 Windows용 설치본을 받으세요.

- `legal-terminal-Setup-x.y.z.exe` — 설치형(NSIS). 실행 후 설치 경로 선택 가능
- `legal-terminal-x.y.z-portable.exe` — 무설치 포터블(더블클릭 실행)

> 코드서명 전이라 처음 실행 시 Windows SmartScreen 경고가 뜰 수 있습니다 — **추가 정보 → 실행**을 누르세요.

### 처음이라면 — `jurisupport-plugins`부터 설치하세요

legal-terminal은 PC에 설치된 **Claude Code**와 **변호사용 플러그인**을 그대로 사용합니다. 아직 이것들이 없다면, **먼저 [`jurisupport-plugins`](https://github.com/jurisupport/jurisupport-plugins)를 설치**하세요. 설치 스크립트가 의존성(Node 등)·**Claude Code**·송무 플러그인·검색 토킷·PII 보호 훅까지 한 번에 구성해 줍니다.

- Windows: `windows-bootstrap.ps1`
- macOS/Linux/WSL: `install.sh`

설치 후 `claude` 1회 로그인 → 그다음 legal-terminal 설치본을 실행하면 됩니다. (사건 대시보드의 JuriSupport 연동은 선택 사항 — 아래 참고)

## jurisupport-plugins와 함께 사용

legal-terminal은 **실제 `claude` CLI를 그대로 실행**하므로, [`jurisupport-plugins`](https://github.com/jurisupport/jurisupport-plugins)를 설치해 두면 그 플러그인·스킬·MCP·훅이 이 앱의 터미널에서 **무수정으로 동작**합니다(앱은 별도 설정이 필요 없습니다).

1. **설치** — `jurisupport-plugins` 저장소의 설치 스크립트 실행
   - Windows: `windows-bootstrap.ps1` (Python·Node·Chrome 등 의존성 + 플러그인 구성)
   - macOS/Linux/WSL: `install.sh`
   - 설치되는 것: `~/.claude/settings.json`에 플러그인·**PII 보호 훅**, 검색 토킷 서버, MCP 등록
2. **구성요소** (설치 후 터미널의 claude에서 바로 사용)
   - `songmu-legal` 플러그인 — `/brief-protocol`(준비서면 표준 절차), `/cold-start-interview`(사무소 플레이북), `case-index`(CSV 사건관리)
   - 검색 스킬 — 법고을 판례검색 · 과거 사건기록(:8767) · 법률서적(:8766) · lbox 가이드
   - `korean-law` MCP, **PII 차단 훅**
3. **사용** — legal-terminal에서 사건 폴더를 열면 그 폴더(cwd)에서 claude가 실행되어, 위 스킬·커맨드를 그대로 호출할 수 있습니다. 예: 터미널에서 `/brief-protocol`, 또는 문서를 터미널로 드래그해 질문.

> **사건 대시보드(JuriSupport 본체 연동)**는 위 플러그인과 별개입니다. 사건 모드에서 JuriSupport 웹 → 프로필 → **MCP 연결** 토큰을 발급해 붙여넣으면 사건·기일·당사자를 조회합니다.

## 주요 기능

### 작업 공간
- 좌측 **탐색기 / 사건 / 기록뷰어** 모드 전환, 우측 **터미널은 항상 유지**
- 탐색기: 파일트리, 인라인 새 파일/폴더, 드래그앤드롭 이동·복사(폴더 자동 펼침)
- 파일 뷰어: 이미지·PDF·HWP(텍스트)·CSV(표/색상)·Markdown
- 탭 **재정렬·찢어내기(새 창)·창 간 이동**, 새 창은 문서 전용(터미널 없이)이며 Claude 질문은 메인 창 터미널로 라우팅

### 터미널 / 세션
- 사건 1개 = 터미널 1개. **세션 이름 자동 생성**(법원·사건번호·사건명·당사자) + claude 세션 제목(transcript ai-title) 반영
- **세션 목록(☰)** — 열린 세션 + **과거 세션(`claude --resume`로 이어서 열기)**, 사건별 필터
- 탭 상태 표시: **작업 중(⟳) / 완료(●) / 질문 대기(❓)**, 완료 시 알림음, 질문 시 팝업
- 복사/붙여넣기, Ctrl+T 새 터미널, Ctrl+Tab·Ctrl+PageUp/Down 탭 이동
- 탐색기·기록뷰어의 문서를 **터미널로 드래그**하면 그 파일을 Claude에 질문

### 사건 대시보드 (JuriSupport 연동)
- 웹 → 프로필 → **MCP 연결**에서 토큰 발급 후 붙여넣기 (토큰은 safeStorage로 암호화 저장)
- 사건 카드(사건번호·법원·당사자·임박 기일), 검색, 좌측 **다가오는 기일** 패널
- 좌클릭 = 작업환경 열기(작성서류/소송기록 폴더 자동 매칭→없으면 직접 지정 + 터미널·뷰어 연결)
- 우클릭 = Claude 브리핑 / `/brief-protocol` 초안 / JuriSupport 웹에서 보기 / 복사 / 상세

## 기술 스택

Electron 33 · electron-vite · React 18 · TypeScript · xterm.js(+WebGL) · `@lydell/node-pty`(ConPTY) · pdf.js · CodeMirror 6 · marked/DOMPurify · hwp.js · D2Coding 번들 폰트

## 개발

```bash
npm install
npm run dev        # 개발 모드 (HMR)
npm run build      # 프로덕션 빌드 (out/)
npm run preview    # 빌드 결과 실행
npm run typecheck  # 타입 검사
```

> Windows 기준. `@lydell/node-pty`는 prebuilt N-API라 별도 컴파일러가 필요 없습니다.

## 의뢰인 정보 보호

- 사건 데이터·산출물(`사건/`, `*_index.csv`, `*.pdf`)은 **절대 커밋하지 않습니다**(`.gitignore`).
- JuriSupport MCP 토큰은 로컬에서 Electron `safeStorage`로 암호화 저장됩니다.
- 외부 서비스로 의뢰인 정보가 전송되지 않도록 주의하세요(PII 보호 훅 등 기존 정책 유지).

## 라이선스

MIT
