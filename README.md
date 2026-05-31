# legal-terminal

> **대한민국 송무 변호사를 위한 AI 통합 작업환경** — 사건 기록을 읽고, AI와 함께 서면을 쓰고, 사건·기일을 관리하는 흐름을 한 화면에
>
> 쥬리서포트 주식회사 ([jurisupport.com](https://jurisupport.com))

![License](https://img.shields.io/badge/License-MIT-blue.svg)
![Platform](https://img.shields.io/badge/Platform-Windows-lightgrey)
![Locale](https://img.shields.io/badge/Locale-ko--KR-red)
![Claude Code](https://img.shields.io/badge/Claude%20Code-Required-orange)

---

- **내 사건을 직접 읽는 Claude** — 사건 폴더에서 Claude Code가 돌며, 기록 분석·인용 검증·서면 초안을 같은 화면에서
- **준비서면 에디터** — 라이브 프리뷰·편집 가능한 표·PDF 내보내기까지 (Markdown 기반)
- **전자소송기록 뷰어** — 전자소송기록 PDF를 문서/서증/첨부서류로 자동 분류해 탐색
- **사건 대시보드** — JuriSupport와 연동해 사건·기일·당사자를 한눈에, 클릭 한 번으로 작업환경 진입
- **원격(SSH) 작업** — 사무실 서버(Mac/Linux)의 사건을 로컬처럼: 원격에서 claude 실행 + 파일 탐색·뷰어·편집, OneDrive 동기화까지

![legal-terminal](screenshots/app.png)

> 따로 떠 있던 터미널의 `claude`, 별도 에디터, 전자소송기록 뷰어를 **한 화면에 통합**했습니다. 기존 `jurisupport-plugins` 생태계(songmu-legal 플러그인, korean-law MCP, 법령·판례·사건기록 검색 도구, PII 보호 훅)는 **교체가 아니라 그대로 살려** 동작합니다.

## 이번 업데이트 (v0.1.0) — 원격(SSH) 작업

사무실 서버에 둔 사건을, 노트북에서 로컬과 똑같이 다룰 수 있습니다.

- **원격에서 claude 실행** — 저장된 SSH 프로필로 접속해 원격 사건 폴더에서 Claude Code 실행. `~/.ssh/config`·키·ssh-agent·known_hosts를 그대로 사용(비밀번호/패스프레이즈 프롬프트는 터미널에 표시).
- **원격 파일 패널** — 탐색기·PDF/이미지 뷰어·Markdown 편집·기록뷰어가 **원격 파일을 직접**(SFTP) 읽고 씁니다. 새 파일/폴더·이동·**삭제(우클릭)** 도 원격에서.
- **사건 대시보드 → 원격 열기** — 사건 우클릭 **"○○에서 열기"** 로 원격 작업환경 진입. 작성서류·**소송기록 폴더 자동 매칭**(이전에 고른 짝은 기억).
- **OneDrive 동기화(rclone)** — 원격 사건폴더 ↔ OneDrive 클라우드 **가져오기/보내기**(맥에서 rclone 실행, `copy --update`로 삭제 전파 없이 안전).
- **설정에서 원격 루트를 '찾아보기'로 지정** — 경로를 외워 입력할 필요 없이, 접속해 원격 폴더를 탐색·선택.
- 그 외: 터미널 **Ctrl+W로 탭 닫기**(작업 중이면 확인), **사건 지정 해제** 버튼, 저장 안 된 새 문서 **닫기 보호**, 사건 목록 로딩 멈춤(타임아웃) 수정.

## 다운로드 (Windows)

### 1) 이 파일을 받으세요

👉 **[legal-terminal 설치 (Setup) 내려받기](https://github.com/jurisupport/legal-terminal/releases/latest/download/legal-terminal-Setup.exe)** — 대부분 이 파일 하나면 됩니다. 받은 뒤 더블클릭해서 설치하세요.

- 설치하기 싫고 바로 실행만: **[포터블 버전](https://github.com/jurisupport/legal-terminal/releases/latest/download/legal-terminal-portable.exe)** (다운로드 후 더블클릭, 설치 불필요)

### 2) 설치할 때 "Windows의 PC 보호" 경고 푸는 법

아직 코드서명 전이라 처음 실행하면 파란색 **"Windows의 PC 보호(Windows protected your PC)"** 창이 뜹니다. 정상이며, 이렇게 통과합니다.

1. 창에서 **추가 정보(More info)** 클릭
2. 아래에 나타나는 **실행(Run anyway)** 클릭

> 그래도 막히면: 받은 `.exe`를 **우클릭 → 속성 → 하단 "차단 해제(Unblock)" 체크 → 확인** 후 다시 실행하세요.

### 3) 처음이라면 — `jurisupport-plugins`부터 설치하세요

legal-terminal은 PC에 설치된 **Claude Code**와 **변호사용 플러그인**을 그대로 사용합니다. 아직 이것들이 없다면, **먼저 [`jurisupport-plugins`](https://github.com/jurisupport/jurisupport-plugins)를 설치**하세요. 설치 스크립트가 의존성(Node 등)·**Claude Code**·송무 플러그인·판례·법령·사건기록 검색 도구·PII 보호 훅까지 한 번에 구성해 줍니다.

- Windows: `windows-bootstrap.ps1`
- macOS/Linux/WSL: `install.sh`

설치 후 `claude` 1회 로그인 → 그다음 legal-terminal 설치본을 실행하면 됩니다. (사건 대시보드의 JuriSupport 연동은 선택 사항 — 아래 참고)

## jurisupport-plugins와 함께 사용

legal-terminal은 **실제 `claude` CLI를 그대로 실행**하므로, [`jurisupport-plugins`](https://github.com/jurisupport/jurisupport-plugins)를 설치해 두면 그 플러그인·스킬·MCP·훅이 이 앱의 터미널에서 **무수정으로 동작**합니다(앱은 별도 설정이 필요 없습니다).

1. **설치** — `jurisupport-plugins` 저장소의 설치 스크립트 실행
   - Windows: `windows-bootstrap.ps1` (Python·Node·Chrome 등 의존성 + 플러그인 구성)
   - macOS/Linux/WSL: `install.sh`
   - 설치되는 것: `~/.claude/settings.json`에 플러그인·**PII 보호 훅**, 검색 서버(법령·판례·사건기록), MCP 등록
2. **구성요소** (설치 후 터미널의 claude에서 바로 사용)
   - `songmu-legal` 플러그인 — `/brief-protocol`(준비서면 표준 절차), `/cold-start-interview`(사무소 플레이북), `case-index`(CSV 사건관리)
   - 검색 스킬 — 법고을 판례검색 · 과거 사건기록(:8767) · 법률서적(:8766) · lbox 가이드
   - `korean-law` MCP, **PII 차단 훅**
3. **사용** — legal-terminal에서 사건 폴더를 열면 그 폴더(cwd)에서 claude가 실행되어, 위 스킬·커맨드를 그대로 호출할 수 있습니다. 예: 터미널에서 `/brief-protocol`, 또는 문서를 터미널로 드래그해 질문.

> **사건 대시보드(JuriSupport 본체 연동)**는 위 플러그인과 별개입니다. 사건 모드에서 JuriSupport 웹 → 프로필 → **MCP 연결** 토큰을 발급해 붙여넣으면 사건·기일·당사자를 조회합니다.

## 주요 기능

### 작업 공간
- 좌측 **탐색기 / 사건 / 기록뷰어** 모드 전환, 우측 **터미널은 항상 유지**
- 탐색기: 파일트리, 인라인 새 파일/폴더, 드래그앤드롭 이동·복사(폴더 자동 펼침), **우클릭 삭제**(폴더 재귀)
- 파일 뷰어: 이미지·PDF·HWP(텍스트)·CSV(표/색상)·Markdown
- 탭 **재정렬·찢어내기(새 창)·창 간 이동**, 새 창은 문서 전용(터미널 없이)이며 Claude 질문은 메인 창 터미널로 라우팅
- 저장 안 된 새 문서는 닫을 때 **확인**(데이터 손실 방지)

### 터미널 / 세션
- 사건 1개 = 터미널 1개. **세션 이름 자동 생성**(법원·사건번호·사건명·당사자) + claude 세션 제목(transcript ai-title) 반영
- **세션 목록(☰)** — 열린 세션 + **과거 세션(`claude --resume`로 이어서 열기)**, 사건별 필터
- 탭 상태 표시: **작업 중(⟳) / 완료(●) / 질문 대기(❓)**, 완료 시 알림음, 질문 시 팝업
- 복사/붙여넣기, Ctrl+T 새 터미널, **Ctrl+W 터미널 닫기(작업 중이면 확인)**, Ctrl+Tab·Ctrl+PageUp/Down 탭 이동
- 탐색기·기록뷰어의 문서를 **터미널로 드래그**하면 그 파일을 Claude에 질문
- 터미널을 모두 닫아도 사건 컨텍스트 유지 → **사건 지정 해제** 버튼으로 비우기

### 원격 작업 (SSH)
- 설정에 **SSH 접속 프로필** 저장(호스트·사용자·키·원격 작성서류/소송기록 루트). 루트는 접속해 **'찾아보기'** 로 지정
- 터미널 ＋/📁 → **로컬 / 원격 프로필** 선택 → 원격 폴더에서 사건 고르면 그 폴더에서 claude 실행
- **파일 패널 원격화** — 탐색기·뷰어·Markdown 편집·기록뷰어가 SFTP로 원격 파일을 직접 다룸(`ssh://` 라우팅)
- **OneDrive 동기화** — 활성 사건 폴더를 맥의 rclone으로 클라우드와 **가져오기/보내기**
- 인증은 **키/ssh-agent** 사용(파일 패널·동기화는 비밀번호 인증 미지원). 터미널 접속 자체는 비밀번호도 가능

### 사건 대시보드 (JuriSupport 연동)
- 웹 → 프로필 → **MCP 연결**에서 토큰 발급 후 붙여넣기 (토큰은 safeStorage로 암호화 저장)
- 사건 카드(사건번호·법원·당사자·임박 기일), 검색, 좌측 **다가오는 기일** 패널
- 좌클릭 = 작업환경 열기(작성서류/소송기록 폴더 자동 매칭→없으면 직접 지정 + 터미널·뷰어 연결)
- 우클릭 = **원격(○○)에서 열기** / Claude 브리핑 / `/brief-protocol` 초안 / JuriSupport 웹에서 보기 / 복사 / 상세

## 기술 스택

Electron 33 · electron-vite · React 18 · TypeScript · xterm.js(+WebGL) · `@lydell/node-pty`(ConPTY) · `ssh2`(SFTP 원격 파일) · 시스템 OpenSSH(터미널)·rclone(동기화, 외부) · pdf.js · CodeMirror 6 · marked/DOMPurify · hwp.js · D2Coding 번들 폰트

## 개발

```bash
npm install
npm run dev        # 개발 모드 (HMR)
npm run build      # 프로덕션 빌드 (out/)
npm run preview    # 빌드 결과 실행
npm run typecheck  # 타입 검사
```

> Windows 기준. `@lydell/node-pty`는 prebuilt N-API라 별도 컴파일러가 필요 없습니다.

## 라이선스

MIT
