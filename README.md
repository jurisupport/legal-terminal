# legal-terminal

> 대한민국 송무 변호사를 위한 AI 통합 작업환경.
> 사건 폴더, 전자소송기록, 준비서면, Claude Code, JuriSupport 사건 관리를 한 화면에서 다룹니다.
>
> 쥬리서포트 주식회사 ([jurisupport.com](https://jurisupport.com))

![License](https://img.shields.io/badge/License-MIT-blue.svg)
![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-lightgrey)
![Locale](https://img.shields.io/badge/Locale-ko--KR-red)
![Claude Code](https://img.shields.io/badge/Claude%20Code-Required-orange)

![legal-terminal](screenshots/app.png)

legal-terminal은 따로 떠 있던 `claude` 터미널, 문서 에디터, 전자소송기록 뷰어, 사건·기일 대시보드를 하나로 묶습니다. 기존 `jurisupport-plugins`의 `songmu-legal` 플러그인, korean-law MCP, 판례·법령·사건기록 검색 도구, PII 보호 훅도 그대로 사용할 수 있습니다.

## 빠른 설치

Windows:

```powershell
irm https://raw.githubusercontent.com/jurisupport/legal-terminal/main/install.ps1 | iex
```

macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/jurisupport/legal-terminal/main/install-mac.sh | bash
```

직접 내려받기:

- Windows 설치본: [legal-terminal-Setup.exe](https://github.com/jurisupport/legal-terminal/releases/latest/download/legal-terminal-Setup.exe)
- Windows 포터블: [legal-terminal-portable.exe](https://github.com/jurisupport/legal-terminal/releases/latest/download/legal-terminal-portable.exe)
- Mac Apple Silicon: [legal-terminal-mac-arm64.dmg](https://github.com/jurisupport/legal-terminal/releases/latest/download/legal-terminal-mac-arm64.dmg)
- Mac Intel: [legal-terminal-mac-x64.zip](https://github.com/jurisupport/legal-terminal/releases/latest/download/legal-terminal-mac-x64.zip)
- 최신 릴리스: [GitHub Releases](https://github.com/jurisupport/legal-terminal/releases/latest)

처음 설치 후에는 일반 터미널에서 `claude`를 한 번 실행해 로그인한 다음 legal-terminal을 열면 됩니다.

## 이번 업데이트

최신 릴리스: [v0.1.72](https://github.com/jurisupport/legal-terminal/releases/tag/v0.1.72)

- **사건별 하위 탭 분리**: 사건 A에서 연 문서·터미널·Agent 탭은 사건 A 안에서만 보이고, 사건 B로 섞이지 않습니다.
- **전체 사건탭 복원**: 스냅샷을 복원하면 여러 사건탭과 각 사건의 하위 탭 상태가 함께 돌아옵니다.
- **사건탭 우클릭 닫기**: 사건탭 목록에서 우클릭으로 해당 사건탭과 그 안의 하위 탭을 닫을 수 있습니다.

## 처음 쓰는 순서

1. **Claude Code 준비**
   - Node.js 20 이상을 설치합니다.
   - 터미널에서 `claude`를 실행해 1회 로그인합니다.

2. **legal-terminal 설치**
   - 위의 한 줄 설치 명령 또는 GitHub Release 파일을 사용합니다.

3. **사건 폴더 열기**
   - 좌측 탐색기 또는 새 작업환경 버튼에서 사건의 작성서류 폴더를 선택합니다.
   - Claude Agent 탭이 사건 폴더 기준으로 열립니다.

4. **JuriSupport 사건 연동**
   - 앱의 사건 화면에서 JuriSupport 토큰을 붙여넣습니다.
   - 토큰은 JuriSupport 웹 → 프로필 → MCP 연결에서 발급합니다.

5. **원격 사건을 쓰는 경우**
   - 설정에서 SSH 프로필을 추가합니다.
   - 원격 작성서류 루트와 소송기록 루트를 지정합니다.
   - 설정의 **사건 기본 열기**를 원하는 SSH 프로필로 바꿉니다.

## 주요 기능

### 사건 작업환경

- 사건 1개를 Agent 탭 또는 터미널 탭으로 열어 Claude Code와 함께 작업합니다.
- 탭 이름은 법원, 사건번호, 사건명, 당사자 정보를 바탕으로 자동 정리됩니다.
- 작업환경 저장/복원으로 열린 문서, 터미널, 좌우 패널, 현재 사건, PDF 보기 상태를 다시 불러올 수 있습니다.
- 문서와 터미널은 좌우 패널 사이를 옮길 수 있고, 탭을 새 창으로 떼어낼 수 있습니다.

### Agent Panel과 터미널

- 기본 작업은 **Agent Panel**에서 진행합니다. Claude의 메시지, 작업 과정, 권한 요청, 선택 질문, diff를 UI로 나누어 보여줍니다.
- 기존 PTY 터미널도 사용할 수 있습니다. 탭 메뉴에서 터미널로 실행하면 `claude` CLI 흐름 그대로 작업합니다.
- 과거 Claude 세션 목록을 열고 `claude --resume`으로 이어서 작업할 수 있습니다.
- 작업 중, 완료, 질문 대기 상태가 탭에 표시되고 알림음과 창 주의 요청을 지원합니다.

### 문서와 기록

- Markdown 에디터는 라이브 프리뷰, 표 편집, PDF 내보내기를 지원합니다.
- 파일 뷰어는 PDF, 이미지, HWP/HWPX 텍스트, DOCX 텍스트, CSV, Markdown을 다룹니다.
- 전자소송기록 PDF는 문서, 서증, 첨부서류로 자동 분류해 탐색할 수 있습니다.
- 탐색기와 기록뷰어의 파일을 Claude 탭으로 드래그하면 해당 파일을 바탕으로 질문할 수 있습니다.

### 사건 대시보드

- JuriSupport 사건, 기일, 당사자 정보를 앱 안에서 조회합니다.
- 좌측 **다가오는 기일** 패널에서 임박 기일을 날짜순으로 봅니다.
- 사건 카드, 다가오는 기일, 할일 카드 클릭은 설정의 **사건 기본 열기**를 따릅니다.
- 사건 우클릭 메뉴에서 로컬 열기, SSH 프로필별 열기, Claude 브리핑, `/brief-protocol` 초안, JuriSupport 웹 열기, 복사를 실행합니다.

### 원격 작업 (SSH)

- 원격 Mac/Linux의 사건 폴더를 로컬처럼 열 수 있습니다.
- 원격 사건에서는 해당 서버에서 Claude Code가 실행되고, 탐색기·뷰어·에디터는 SFTP로 원격 파일을 직접 다룹니다.
- 설정에 SSH 프로필, 원격 작성서류 루트, 원격 소송기록 루트, 빠른 시작 경로를 저장할 수 있습니다.
- 원격 폴더 선택창에서 하위 폴더 검색, 새 폴더 생성, OneDrive 최신화를 사용할 수 있습니다.
- 원격 OneDrive 파일이 클라우드 전용 상태이면 rclone으로 실체화한 뒤 열람합니다.
- 파일 패널과 동기화는 키 또는 ssh-agent 인증을 사용합니다. 비밀번호 인증은 원격 터미널 접속에서만 기대할 수 있습니다.

## 설치 상세

### Windows

PowerShell을 열고 아래 명령을 실행합니다.

```powershell
irm https://raw.githubusercontent.com/jurisupport/legal-terminal/main/install.ps1 | iex
```

회사 보안 정책 때문에 한 줄 실행이 막히면 파일로 저장해 확인한 뒤 실행할 수 있습니다.

```powershell
$installer = "$env:TEMP\legal-terminal-install.ps1"
iwr https://raw.githubusercontent.com/jurisupport/legal-terminal/main/install.ps1 -UseBasicParsing -OutFile $installer
notepad $installer
powershell -NoProfile -ExecutionPolicy Bypass -File $installer
```

설치 파일 실행 중 "Windows의 PC 보호" 창이 뜨면 **추가 정보** → **실행**을 누릅니다. 그래도 막히면 받은 `.exe`를 우클릭 → 속성 → **차단 해제** 후 다시 실행합니다.

### macOS

터미널을 열고 아래 명령을 실행합니다.

```bash
curl -fsSL https://raw.githubusercontent.com/jurisupport/legal-terminal/main/install-mac.sh | bash
```

아직 코드서명/공증 전 빌드라서 Gatekeeper가 앱을 막을 수 있습니다. "손상되었기 때문에 휴지통으로 이동" 경고가 뜨면 앱 위치에 맞춰 격리 속성을 지운 뒤 Finder에서 우클릭 → 열기로 실행합니다.

```bash
# /Applications에 설치한 경우
xattr -dr com.apple.quarantine /Applications/legal-terminal.app

# Downloads에서 압축을 풀고 바로 실행하는 경우
xattr -dr com.apple.quarantine ~/Downloads/legal-terminal.app
```

## jurisupport-plugins와 함께 사용

legal-terminal은 실제 `claude` CLI를 실행합니다. [`jurisupport-plugins`](https://github.com/jurisupport/jurisupport-plugins)를 설치해 두면 플러그인, 스킬, MCP, 훅이 앱 안의 Claude에서도 그대로 동작합니다.

설치 후 사용할 수 있는 대표 기능:

- `songmu-legal` 플러그인: `/brief-protocol`, `/cold-start-interview`, `case-index`
- 검색 스킬: 법고을 판례검색, 과거 사건기록, 법률서적, lbox 가이드
- `korean-law` MCP
- PII 차단 훅

사건 대시보드의 JuriSupport 토큰 연동은 위 플러그인 설치와 별개입니다. 사건·기일·당사자 대시보드를 쓰려면 앱의 사건 화면에서 JuriSupport MCP 토큰을 따로 연결합니다.

## 개발

```bash
npm ci
npm run dev        # 개발 모드
npm run typecheck  # 타입 검사
npm run build      # 프로덕션 빌드(out/)
npm run preview    # 빌드 결과 실행
npm run dist:mac   # macOS dmg/zip 패키징
npm run dist:win   # Windows nsis/portable 패키징
```

`@lydell/node-pty`는 prebuilt N-API라 일반적인 macOS/Windows 개발 환경에서는 별도 컴파일러 없이 설치됩니다.

릴리스 배포는 `v*` 태그 푸시로 GitHub Actions의 `Build & Release` 워크플로우가 실행됩니다.

## 기술 스택

Electron 42, electron-vite, React 18, TypeScript, xterm.js, `@lydell/node-pty`, `ssh2`, 시스템 OpenSSH, rclone, pdf.js, CodeMirror 6, marked/DOMPurify, hwp.js, D2Coding 번들 폰트.

## 라이선스

MIT
