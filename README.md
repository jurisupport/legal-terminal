# legal-terminal

> **대한민국 송무 변호사를 위한 AI 통합 작업환경** — 사건 기록을 읽고, AI와 함께 서면을 쓰고, 사건·기일을 관리하는 흐름을 한 화면에
>
> 쥬리서포트 주식회사 ([jurisupport.com](https://jurisupport.com))

![License](https://img.shields.io/badge/License-MIT-blue.svg)
![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-lightgrey)
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

## 이번 업데이트 (v0.1.23) — 원격 사건 작업·작업환경 복원·편집 품질 개선

2026년 6월 1일부터 6월 2일까지의 릴리즈는 "사무실 서버에 있는 사건을 노트북에서 끊기지 않고 다루는 것"에 초점을 맞췄습니다.

- **원격(SSH) 사건 작업 정식화** — 저장된 SSH 프로필로 원격 사건 폴더를 고르고, 그 폴더에서 Claude Code를 실행합니다. 파일 패널·Markdown 편집기·PDF/이미지/HWP/CSV 뷰어·기록뷰어가 `ssh://` 라우팅으로 원격 파일을 직접 다룹니다.
- **원격 폴더 탐색 개선** — 원격 사용자 홈, 루트, OneDrive, iCloud Drive 같은 시작점을 빠르게 오가고, 현재 경로 breadcrumb·정렬·직접 경로 입력으로 사건 폴더를 찾습니다.
- **원격 OneDrive/rclone 보강** — 원격 Mac의 OneDrive 클라우드 전용 파일을 자동 실체화하고, 사건기록 PDF는 목록화 전에 순차 다운로드합니다. Homebrew 경로의 `rclone` 탐지, 한글 경로 정규화, `copy --update` 기반 가져오기/보내기도 보강했습니다.
- **원격 과거 Claude 세션 복원** — 원격 transcript를 읽어 `claude --resume` 대상 세션을 다시 찾습니다. 터미널 탭을 닫거나 작업환경을 복원한 뒤에도 현재 사건의 원격 cwd와 SSH 정보를 유지해 과거 세션 목록이 비지 않도록 했습니다.
- **작업환경 저장·복원** — 문서 탭, 터미널 탭, 좌우 패널 배치, 현재 사건, PDF 여백 자르기 설정을 저장하고 다시 불러옵니다. 여러 사건/문서 작업환경은 안정적인 ID로 분리 저장되어 복원 시 목록에서 선택할 수 있습니다.
- **양방향 작업 패널** — 문서는 왼쪽, 터미널은 오른쪽에 기본 배치하되 필요한 탭을 반대편으로 옮길 수 있습니다. 문서/터미널 탭은 재정렬, 창 간 이동, 새 창 찢어내기를 지원합니다.
- **파일트리 작업 확대** — 로컬/원격 파일 복사·이동·삭제, 폴더 자동 펼침, 인라인 새 파일/폴더 생성, 클립보드 파일 붙여넣기, 원격 파일/폴더 다운로드를 지원합니다.
- **전자소송기록/PDF 개선** — 전자소송기록 파일명을 문서/서증/첨부서류로 더 안정적으로 분류하고, 암호 PDF, 확대 상태의 손 도구, 로컬/원격 OneDrive 로딩 안내와 사전 다운로드를 개선했습니다.
- **Markdown 서면 편집 개선** — 읽기 좋은 Markdown 본문을 JuriSupport 법률문서 MCP 초안 작성에 넘기고, 라이브 프리뷰·표 편집·PDF 내보내기의 텍스트 보존과 레이아웃 안정성을 높였습니다.
- **검색·알림·설정** — 파일트리/터미널/문서 검색 UX, 알림음·볼륨, Markdown/터미널 폰트와 크기 설정을 추가했습니다.
- **터미널 품질 개선** — 붙여넣기 줄바꿈 정규화, Cmd/Ctrl+W 닫기, 완료/질문 상태 표시, 질문 대기 팝업, Mac/Windows IME 조합 위치, 좁은 패널 가독성을 보강했습니다.
- **Windows/macOS 배포 안정화** — macOS arm64/x64와 Windows x64 릴리즈 빌드를 자동화하고, Windows `node-pty` 네이티브 바이너리 검증·포함, 레거시 제거기 실패 복구 설치, macOS Gatekeeper 안내를 정리했습니다.

## 다운로드 (Windows)

### 방법 1. PowerShell 한 줄 설치

1. 키보드에서 **Win** 키를 누릅니다.
2. `PowerShell`을 입력합니다.
3. **Windows PowerShell** 또는 **PowerShell**을 클릭해 실행합니다.
4. 열린 창에 아래 한 줄을 붙여넣고 **Enter**를 누릅니다.

처음 설치와 업데이트 모두 같은 명령을 씁니다.

```powershell
irm https://raw.githubusercontent.com/jurisupport/legal-terminal/main/install.ps1 | iex
```

설치 중 **jurisupport-plugins**가 없으면 설치할지 물어보고, **Claude Code**가 없으면 먼저 설치합니다. 설치 후 `claude` 1회 로그인 → legal-terminal 실행 순서로 진행하면 됩니다.

### 방법 2. 직접 내려받기

PowerShell을 쓰지 않으려면 설치 파일을 직접 내려받아 실행하세요.

👉 **[legal-terminal 설치 (Setup) 내려받기](https://github.com/jurisupport/legal-terminal/releases/latest/download/legal-terminal-Setup.exe)**

- 설치 없이 바로 실행: **[포터블 버전](https://github.com/jurisupport/legal-terminal/releases/latest/download/legal-terminal-portable.exe)**
- 기존 버전 때문에 설치/제거가 막히면 최신 설치본을 다시 실행하세요. 기존 제거기가 실패해도 복구 설치로 진행됩니다.

### 막히는 경우

회사 보안 정책 때문에 `irm ... | iex`가 막히거나, 실행 전에 스크립트 내용을 확인하고 싶다면 아래처럼 파일로 저장한 뒤 실행하세요.

```powershell
$installer = "$env:TEMP\legal-terminal-install.ps1"
iwr https://raw.githubusercontent.com/jurisupport/legal-terminal/main/install.ps1 -UseBasicParsing -OutFile $installer
notepad $installer
powershell -NoProfile -ExecutionPolicy Bypass -File $installer
```

설치 파일 실행 중 파란색 **"Windows의 PC 보호(Windows protected your PC)"** 창이 뜨면 정상입니다. 창에서 **추가 정보(More info)** → **실행(Run anyway)** 을 누르세요.

그래도 막히면 받은 `.exe`를 **우클릭 → 속성 → 하단 "차단 해제(Unblock)" 체크 → 확인** 후 다시 실행하세요.

## 다운로드 (macOS)

### 방법 1. 터미널 한 줄 설치

1. 키보드에서 **Command(⌘) + Space**를 누릅니다.
2. `Terminal`을 입력하고 **터미널**을 실행합니다.
3. 열린 창에 아래 한 줄을 붙여넣고 **Enter**를 누릅니다.

처음 설치와 업데이트 모두 같은 명령을 씁니다. Mac 종류(Apple Silicon/Intel)는 자동으로 감지합니다.

```bash
curl -fsSL https://raw.githubusercontent.com/jurisupport/legal-terminal/main/install-mac.sh | bash
```

Claude Code를 처음 쓰는 Mac이라면 아래 **처음이라면 먼저 준비하세요**를 확인한 뒤 `claude` 1회 로그인 → legal-terminal 실행 순서로 진행하면 됩니다.

### 방법 2. 직접 내려받기

👉 **[Mac Apple Silicon용 내려받기](https://github.com/jurisupport/legal-terminal/releases/latest/download/legal-terminal-mac-arm64.dmg)** — M1/M2/M3/M4 Mac용

👉 **[Mac Intel용 내려받기](https://github.com/jurisupport/legal-terminal/releases/latest/download/legal-terminal-mac-x64.zip)** — Intel Mac용

- 압축 파일이 필요하면: [Apple Silicon zip](https://github.com/jurisupport/legal-terminal/releases/latest/download/legal-terminal-mac-arm64.zip)

### 막히는 경우

아직 코드서명/공증 전 빌드라서 macOS Gatekeeper가 앱을 막을 수 있습니다. **"손상되었기 때문에 휴지통으로 이동"** 경고가 뜨면 실제 파일이 깨진 것이 아니라 격리(quarantine) 속성 때문인 경우가 많습니다.

테스트용으로 실행할 때는 앱 위치에 맞춰 아래 명령을 실행한 뒤 Finder에서 앱을 우클릭 → **열기**로 실행하세요.

```bash
# /Applications에 설치한 경우
xattr -dr com.apple.quarantine /Applications/legal-terminal.app

# Downloads에서 압축을 풀고 바로 실행하는 경우
xattr -dr com.apple.quarantine ~/Downloads/legal-terminal.app
```

정식 배포에서는 Apple Developer ID 서명과 notarization을 붙이면 이 경고가 사라집니다.

### 처음이라면 먼저 준비하세요

- Node.js 20 이상
- Claude Code CLI (`claude`) 로그인 1회
- [`jurisupport-plugins`](https://github.com/jurisupport/jurisupport-plugins) 설치: macOS/Linux용 `install.sh`
- 원격 동기화를 쓸 경우: 원격 Mac에 `rclone` 설정, 로컬/원격 SSH 키 또는 ssh-agent

## 개발 / 패키징 (macOS)

### 개발 모드로 실행

```bash
npm ci
npm run dev
```

앱 안의 터미널은 macOS에서 로그인 셸(`/bin/zsh -l` 또는 `$SHELL -l`)로 뜨므로 Homebrew·Claude Code 경로를 일반 터미널과 최대한 비슷하게 읽습니다.

### Mac 앱으로 패키징

```bash
npm run dist:mac
```

결과물은 `dist/` 아래에 `legal-terminal-mac-<arch>.dmg`와 `.zip`으로 생성됩니다. 서명하지 않은 로컬 빌드를 직접 열 때 macOS가 차단하면, Finder에서 우클릭 → 열기를 사용하거나 테스트용으로 다음 명령을 실행하세요.

```bash
xattr -dr com.apple.quarantine /Applications/legal-terminal.app
```

배포용 릴리스는 Apple Developer ID 인증서와 notarization 설정을 붙인 뒤 `electron-builder.yml`의 `mac.identity: null`을 제거하세요.

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
- 문서는 왼쪽, 터미널은 오른쪽에 기본으로 열리며 필요하면 서로 반대 패널로 이동 가능
- 작업환경 **저장/복원**: 열린 문서·터미널·좌우 패널·현재 사건·PDF 보기 설정을 저장하고, 여러 작업환경을 목록에서 선택해 복원
- 탐색기: 파일트리, 인라인 새 파일/폴더, 드래그앤드롭 이동·복사(폴더 자동 펼침), **우클릭 삭제**(폴더 재귀), 클립보드 파일 붙여넣기, 원격 파일/폴더 다운로드
- 파일 뷰어: 이미지·PDF·HWP(텍스트)·CSV(표/색상)·Markdown
- 탭 **재정렬·찢어내기(새 창)·창 간 이동**, 새 창은 선택한 문서/터미널만 표시하며 Claude 질문은 메인 창 터미널로 라우팅
- 파일트리/터미널/문서 검색, 알림음·볼륨, 터미널·Markdown 폰트와 크기 설정
- 저장 안 된 새 문서는 닫을 때 **확인**(데이터 손실 방지)

### 터미널 / 세션
- 사건 1개 = 터미널 1개. **세션 이름 자동 생성**(법원·사건번호·사건명·당사자) + claude 세션 제목(transcript ai-title) 반영
- **세션 목록(☰)** — 열린 세션 + **과거 세션(`claude --resume`로 이어서 열기)**, 사건별 필터. 원격 사건도 transcript를 찾아 이어서 열기 가능
- 탭 상태 표시: **작업 중(⟳) / 완료(●) / 질문 대기(❓)**, 완료 시 알림음, 질문 시 팝업
- 복사/붙여넣기, Cmd/Ctrl+T 새 터미널, **Cmd/Ctrl+W 터미널 닫기(작업 중이면 확인)**, Cmd/Ctrl+Tab·Cmd/Ctrl+PageUp/Down 탭 이동
- 탐색기·기록뷰어의 문서를 **터미널로 드래그**하면 그 파일을 Claude에 질문
- 터미널을 모두 닫아도 사건 컨텍스트 유지 → **사건 지정 해제** 버튼으로 비우기
- Mac/Windows IME 조합 위치, 좁은 패널 가독성, 텍스트 인코딩이 섞인 파일 복사/열기 보강

### 원격 작업 (SSH)
- 설정에 **SSH 접속 프로필** 저장(호스트·사용자·키·원격 작성서류/소송기록 루트). 루트는 접속해 **'찾아보기'** 로 지정
- 터미널 ＋/📁 → **로컬 / 원격 프로필** 선택 → 원격 폴더에서 사건 고르면 그 폴더에서 claude 실행
- **파일 패널 원격화** — 탐색기·뷰어·Markdown 편집·기록뷰어가 SFTP로 원격 파일을 직접 다룸(`ssh://` 라우팅)
- **OneDrive 동기화** — 활성 사건 폴더를 맥의 rclone으로 클라우드와 **가져오기/보내기**. 원격 폴더 찾기 화면에서는 **OneDrive 최신화**로 누락된 작성서류/소송기록 폴더를 먼저 내려받은 뒤 선택
- **원격 OneDrive 파일 실체화** — 파일이 원격 Mac에서 클라우드 전용 상태면 `rclone`으로 원격 임시파일에 받은 뒤 OneDrive 파일 위치에 반영합니다. 사건기록 PDF 목록은 열람 전에 백그라운드로 원격 Mac에 순차 다운로드됩니다.
- 원격 파일 변경 자동 새로고침, 원격 최근 사건 기억, 원격 파일/폴더 다운로드, 로컬 클립보드 파일의 원격 업로드
- 인증은 **키/ssh-agent** 사용(파일 패널·동기화는 비밀번호 인증 미지원). 터미널 접속 자체는 비밀번호도 가능

### 사건 대시보드 (JuriSupport 연동)
- 웹 → 프로필 → **MCP 연결**에서 토큰 발급 후 붙여넣기 (토큰은 safeStorage로 암호화 저장)
- 사건 카드(사건번호·법원·당사자·임박 기일), 검색, 좌측 **다가오는 기일** 패널
- 좌클릭 = 작업환경 열기(작성서류/소송기록 폴더 자동 매칭→없으면 직접 지정 + 터미널·뷰어 연결)
- 우클릭 = **원격(○○)에서 열기** / Claude 브리핑 / `/brief-protocol` 초안 / JuriSupport 웹에서 보기 / 복사 / 상세

## 기술 스택

Electron 42 · electron-vite · React 18 · TypeScript · xterm.js(+WebGL/Canvas) · `@lydell/node-pty`(ConPTY) · `ssh2`(SFTP 원격 파일) · 시스템 OpenSSH(터미널)·rclone(동기화, 외부) · pdf.js · CodeMirror 6 · marked/DOMPurify · hwp.js · D2Coding 번들 폰트

## 개발

```bash
npm ci
npm run dev        # 개발 모드 (HMR)
npm run build      # 프로덕션 빌드 (out/)
npm run preview    # 빌드 결과 실행
npm run typecheck  # 타입 검사
npm run dist:mac   # macOS dmg/zip 패키징
npm run dist:win   # Windows nsis/portable 패키징
```

`@lydell/node-pty`는 prebuilt N-API라 일반적인 macOS/Windows 개발 환경에서는 별도 컴파일러 없이 설치됩니다.

## 라이선스

MIT
