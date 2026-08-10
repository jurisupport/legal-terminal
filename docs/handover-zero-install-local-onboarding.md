# legal-terminal 로컬 단독 설치·온보딩 핸드오버

## 목적

변호사가 별도로 Claude Code, Node.js, Git을 설치하거나 터미널 명령을 실행하지 않고 다음 흐름으로 legal-terminal을 사용할 수 있게 한다.

> 서명된 legal-terminal 설치 → 앱 안에서 Claude 로그인 → 사건 폴더 선택 → Agent 및 JuriSupport 기능 사용

여기서 “로컬 단독 설치”는 **legal-terminal 앱 외에 별도 개발 도구를 설치하지 않는다**는 뜻이다. Claude 모델 사용에는 인터넷 연결과 사용 가능한 Claude 계정이 필요하며, 온디바이스·오프라인 AI를 뜻하지 않는다.

## 현재 판정

| 환경 | 현재 상태 |
| --- | --- |
| Claude Code가 설치되고 로그인된 기존 개발 PC | 사용 가능 |
| Claude Code, Node.js, Git, `~/.claude`가 없는 신규 변호사 PC | 첫 Agent 사용 불가 |
| HWP/HWPX/PDF/Markdown 열람·편집 및 HWPX 내보내기 | 로컬 사용 가능 |
| JuriSupport 대시보드 | 토큰과 인터넷 연결이 있으면 사용 가능 |
| Claude/Codex 터미널 탭 | 각 시스템 CLI가 별도로 필요 |

핵심 장애물은 Claude 실행 파일이 아니다. 앱에는 Claude Agent SDK 실행 파일이 이미 포함되어 있지만, **로컬 Claude 로그인 절차가 앱에 구현되어 있지 않다.**

## 확인된 근거

- 저장소 버전: `0.1.185`
- 확인한 설치 앱: `0.1.184`
- 앱 번들 Claude Code: `2.1.162`
- 시스템 Claude Code: `2.1.222`
- `electron-builder.yml`은 macOS/Windows용 Claude Agent SDK 실행 파일을 패키징하고 unpack한다.
- `src/main/agent/agent-service.ts`의 로컬 Agent 호출은 `pathToClaudeCodeExecutable`로 번들 실행 파일을 사용한다.
- 같은 파일의 `startAgentAuthLogin`은 현재 SSH Claude 로그인만 지원한다.
- 깨끗한 임시 `CLAUDE_CONFIG_DIR`에서 번들 실행 파일을 확인한 결과:

```text
auth status → loggedIn: false, authMethod: none
prompt      → Not logged in · Please run /login
```

- macOS `install-mac.sh`는 legal-terminal 설치 전에 Claude Code 설치를 권유한다.
- Windows `install.ps1`은 Git, Node/npm, Claude Code를 설치한 뒤 legal-terminal을 설치한다.
- `README.md`도 터미널에서 `claude`를 실행해 최초 로그인하도록 안내한다.

## 작업 범위와 우선순위

### P0 — 신규 PC에서 Agent 첫 실행 완성

#### 1. 번들 Claude의 로컬 인증을 앱 안에서 처리

대상:

- `src/main/agent/agent-service.ts`
- `src/main/agent/agent-types.ts`
- `src/renderer/src/agent/AgentPanel.tsx`

구현 지시:

1. 기존 `packagedClaudeAgentSdkExecutable()`을 그대로 재사용한다.
2. 로컬 Claude 세션을 열 때 번들 실행 파일의 `auth status`를 확인한다.
3. 미로그인 상태면 일반 Agent 오류 대신 명확한 “Claude 로그인” 버튼을 표시한다.
4. 버튼은 번들 실행 파일의 `auth login --claudeai` 흐름을 시작하고, 브라우저 인증 완료를 앱에 반영한다.
5. 로그인 중에는 중복 요청을 막고, 완료 후 대기 중인 첫 메시지를 재시도하거나 사용자가 다시 전송할 수 있게 한다.
6. 로그아웃·만료·취소·브라우저 미복귀를 사용자에게 구분해 표시한다.
7. 현재 SSH 인증 이벤트와 UI를 재사용하고, 로컬 인증만을 위한 새 계층이나 새 의존성은 만들지 않는다.

완료 기준:

- `~/.claude`가 없는 사용자도 앱 안에서 로그인을 시작하고 Agent 응답을 받는다.
- 미로그인 오류에 `/login` 또는 터미널 사용을 요구하지 않는다.
- 앱 재실행 후 인증 상태가 정상 복원된다.

#### 2. 번들 Agent를 기본 경로로 지정

- 기본 설치와 첫 실행에서 시스템 `claude` CLI를 요구하지 않는다.
- Claude/Codex 터미널 탭은 “고급 기능”으로 유지한다.
- 시스템 CLI가 없을 때 터미널 탭만 설치 안내를 표시하고, Agent 패널·문서 편집 기능은 정상 동작해야 한다.
- Codex의 무설치 지원은 이번 범위에 포함하지 않는다.

#### 3. 깨끗한 사용자 프로필 회귀 검사 추가

기존 검증 스크립트 패턴을 재사용해 최소한 다음을 확인한다.

- 패키징 결과물에 OS/아키텍처별 Claude 실행 파일이 존재하고 실행 가능하다.
- 격리된 `CLAUDE_CONFIG_DIR`에서 `auth status`가 미로그인으로 판정된다.
- 앱은 이 상태를 일반 실패가 아닌 로그인 필요 상태로 매핑한다.
- 로그인 필요 상태의 사용자 메시지와 CTA가 회귀하지 않는다.

새 테스트 프레임워크는 추가하지 않는다. 기존 Node 스크립트 또는 작은 self-check 하나로 충분하다.

### P0 — 외부 배포 안전성

#### 4. 앱 서명·공증

현재 macOS 설정은 `identity: null`, `hardenedRuntime: false`, `gatekeeperAssess: false`이다. 변호사 대상 배포 전 다음이 필요하다.

- macOS Developer ID 서명, hardened runtime, notarization
- Windows 코드 서명과 SmartScreen 평판 계획
- 정상 설치 경로에서는 `xattr` 제거나 수동 “차단 해제” 안내 삭제
- 서명된 DMG/EXE 직접 다운로드를 기본 설치 방식으로 지정

설치 스크립트는 관리 배포나 고급 설정용 보조 수단으로만 남긴다.

#### 5. JuriSupport 토큰 평문 저장 금지

`src/main/jurisupport.ts`는 Electron `safeStorage`를 사용할 수 없을 때 `plain:` 형식으로 저장한다. 외부 배포판에서는 암호화 저장이 불가능하면 토큰 저장을 거부하고 재로그인을 안내하도록 fail closed 처리한다.

#### 6. Electron 보안 설정 점검

현재 BrowserWindow는 `contextIsolation: true`, `nodeIntegration: false`이지만 `sandbox: false`이다. PTY/preload 기능과의 호환성을 확인한 뒤 sandbox 활성화 가능 여부를 결정하고, 유지해야 한다면 신뢰 경계와 검증 결과를 릴리스 기록에 남긴다.

### P1 — 플러그인과 첫 실행 경험

#### 7. JuriSupport 플러그인을 앱 리소스로 제공

기본 사용을 위해 외부 `claude plugin` 설치나 marketplace bootstrap을 요구하지 않게 한다.

- 현재 `resources/skills` 패턴을 우선 재사용한다.
- Agent SDK가 지원하는 plugin path가 있으면 앱 번들 경로를 직접 전달한다.
- 직접 경로가 지원되지 않을 때만 앱 전용 Claude 설정 디렉터리에 번들 플러그인을 최초 1회 등록한다.
- 사용자 전역 Claude 설정을 불필요하게 수정하지 않는다.
- `/jurisupport:brief-protocol` 등 제공 명령이 새 사용자 프로필에서 보이는지 패키징 후 확인한다.

#### 8. 기본 MCP를 원격 경로로 단순화

- JuriSupport MCP는 원격 연결을 기본으로 한다.
- `korean-law`의 `npx`, Python, `jq`, Git 등 로컬 도구는 첫 실행 필수 조건에서 제외한다.
- 선택적 MCP가 없더라도 Agent와 핵심 JuriSupport 흐름은 안전하게 축소 동작해야 한다.
- `legal-books`, `case-records` 등 사무소별 로컬 도구는 고급 설정으로 둔다.

#### 9. 첫 실행 상태 화면

별도 대형 마법사를 만들지 말고 기존 Agent 화면에 다음 상태만 간단히 보여준다.

- Claude 로그인
- JuriSupport 토큰
- JuriSupport 플러그인 로드
- 필수 MCP 연결

각 항목은 상태, 한 줄 설명, 바로 실행할 수 있는 조치 하나만 제공한다.

### P1 — 설치기와 버전 정리

#### macOS

- 기본 흐름에서 `ensure_claude`를 제거한다.
- legal-terminal을 먼저 설치하고 앱 내 로그인을 사용한다.
- 시스템 Claude Code와 plugin bootstrap은 선택적 고급 설치로 분리한다.

#### Windows

- 기본 흐름에서 Git, Node/npm, Claude Code 설치를 제거한다.
- Electron 앱과 번들 Claude만으로 Agent 패널을 실행한다.
- 시스템 CLI가 필요한 터미널 기능은 선택적 고급 설치로 분리한다.

#### 릴리스 일관성

- `package.json`, README 최신 버전, 릴리스 태그를 한 번에 검증한다.
- 번들 Agent SDK 버전을 정기적으로 갱신하고 패키지 검증 결과에 버전을 출력한다.
- 앱 자동 업데이트 또는 최소한 명확한 업데이트 알림을 제공한다.

## 권장 구현 순서

1. 로컬 Claude 인증 상태 확인 및 로그인 UI
2. 깨끗한 프로필 self-check
3. 설치기에서 외부 Claude/Node/Git 필수 조건 제거
4. 플러그인 번들 로딩
5. 첫 실행 상태 표시
6. 토큰 저장 fail-closed
7. macOS/Windows 서명 및 클린 VM 검증
8. README와 배포 문구 갱신

## 클린 VM 인수 테스트

macOS와 Windows에서 각각 Node.js, Git, Claude Code, 기존 Claude 설정이 전혀 없는 새 사용자 계정으로 테스트한다.

1. 서명된 설치 파일을 다운로드하고 경고 우회 없이 설치한다.
2. 앱을 실행하고 Claude 로그인을 앱 안에서 완료한다.
3. 사건 폴더를 연다.
4. Agent에게 일반 질문을 보내 응답을 받는다.
5. JuriSupport 토큰을 등록하고 연결 상태를 확인한다.
6. `/jurisupport:brief-protocol` 등 번들 명령을 호출한다.
7. 문서를 열고 수정한 뒤 HWPX로 내보낸다.
8. 앱을 종료·재실행해 작업공간과 인증 상태가 유지되는지 확인한다.
9. 인터넷을 끊고 문서 편집·열람·HWPX 내보내기는 유지되며, Agent는 인터넷/로그인 필요를 명확히 안내하는지 확인한다.
10. 이전 버전에서 업그레이드했을 때 작업공간과 설정이 보존되고 토큰이 평문으로 남지 않는지 확인한다.

지원 대상 아키텍처마다 패키징 결과물에 번들 Claude 실행 파일이 있는지도 별도로 검사한다.

## 이번 작업의 비범위

- 온디바이스 또는 완전 오프라인 AI
- Codex CLI의 무설치 실행
- Claude Desktop 대체
- `legal-books`, `case-records`, Python, rclone 등 모든 선택 도구의 기본 번들
- Agent 화면의 전면 재설계
- 시스템 터미널 기능 제거

## 결정이 필요한 외부 사항

다음은 구현 전에 공식 Anthropic 문서·계약 기준으로 확인한다.

- 제3자 데스크톱 앱에 Claude Agent SDK 실행 파일을 포함해 배포할 수 있는지
- `auth login --claudeai`를 앱 내 브라우저 인증으로 제공하는 방식이 지원되는지
- macOS/Windows 패키지에서 OAuth callback이 안정적으로 복귀하는지
- 플러그인을 사용자 전역 설정 없이 앱 경로에서 로드할 수 있는 공식 방식

기술적으로 실행 파일이 포함되어 있다는 사실만으로 재배포·인증 방식이 허용된다고 가정하지 않는다.

## 팀에 그대로 전달할 변경 지시문

```text
목표: 신규 변호사 PC에서 legal-terminal만 설치해 앱 내 Claude 로그인 후 Agent와 JuriSupport를 사용할 수 있게 한다. 별도 Claude Code, Node.js, Git, 터미널 명령을 기본 경로에서 요구하지 않는다.

우선 src/main/agent/agent-service.ts의 기존 packagedClaudeAgentSdkExecutable()과 SSH 인증 UI/event를 재사용해 로컬 Claude auth status/login/logout 흐름을 구현한다. 깨끗한 CLAUDE_CONFIG_DIR에서 미로그인 상태가 로그인 CTA로 보이고, 앱 내 브라우저 로그인 완료 후 Agent 응답을 받는 것을 검증한다.

그다음 install-mac.sh와 install.ps1에서 시스템 Claude Code 및 개발 도구 설치를 기본 필수 단계에서 제거한다. Agent 패널은 번들 Claude를 사용하고, CLI 터미널은 선택적 고급 기능으로 남긴다.

JuriSupport 플러그인은 앱 리소스에서 로드하고 원격 JuriSupport MCP를 기본으로 한다. 선택적 로컬 도구가 없어도 핵심 흐름이 실패하지 않게 한다. 새 의존성이나 별도 인증 계층은 추가하지 않는다.

배포 전 macOS/Windows 코드 서명, macOS notarization/hardened runtime, JuriSupport 토큰 평문 fallback 제거를 완료한다. macOS와 Windows의 깨끗한 VM에서 설치·로그인·Agent·플러그인·MCP·HWPX 내보내기·재실행·업그레이드 흐름을 통과시킨다.
```

## 완료 정의

다음 조건을 모두 만족해야 “변호사가 로컬에서 문제 없이 사용할 수 있다”고 안내할 수 있다.

- 앱 외 별도 개발 도구 없이 설치와 첫 Claude 로그인이 완료된다.
- 깨끗한 PC에서 Agent 및 핵심 JuriSupport 명령이 동작한다.
- 문서 기능은 네트워크 장애와 무관하게 동작한다.
- 미로그인·오프라인·선택 도구 미설치 상태가 이해 가능한 안내로 처리된다.
- 배포 파일이 서명·공증되고 토큰이 평문으로 저장되지 않는다.
- 지원 OS별 클린 VM 인수 테스트와 패키지 self-check가 통과한다.
