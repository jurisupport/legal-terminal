# VS Code Claude Code 스타일 에이전트 UI 명세서

상태: 초안
작성일: 2026-06-04
대상 프로젝트: `legal-terminal`

## 1. 목표

`legal-terminal`의 Claude 사용 경험을 "터미널 안에서 실행되는 CLI"에서 "IDE 안의 네이티브 에이전트 패널"로 확장한다.

기존 xterm 기반 터미널은 유지한다. 다만 일반 사용자의 기본 작업 흐름은 Claude Code VS Code 확장처럼 대화, 파일 참조, 도구 실행 상태, 계획 검토, 변경 diff 승인, 세션 재개를 그래픽 UI에서 처리하도록 만든다.

핵심 목표는 다음과 같다.

- 사용자가 터미널 명령어를 몰라도 Claude Code 기반 작업을 수행할 수 있다.
- Claude가 어떤 파일을 읽고, 어떤 명령을 실행하고, 어떤 변경을 제안하는지 화면에서 추적할 수 있다.
- 파일 변경과 명령 실행은 명확한 승인 흐름을 거친다.
- 기존 `claude` CLI, `jurisupport-plugins`, MCP, Claude transcript, 원격 SSH 사건 폴더 흐름은 깨지지 않는다.

## 2. 참고 기준: Claude Code for VS Code

Claude Code VS Code 확장에서 강하게 참고할 UX 요소는 다음이다.

- 네이티브 그래픽 패널: VS Code 안에 통합된 패널 또는 탭 UI를 기본 사용 경로로 제공한다.
- 다양한 진입점: activity bar, editor toolbar, command palette, status bar에서 Claude를 열 수 있다.
- 유연한 배치: sidebar, editor tab, 별도 창처럼 사용자가 에이전트 위치를 바꿀 수 있다.
- 복수 대화: 대화별 독립 세션, 별도 탭/창, 숨겨진 탭 상태 표시를 지원한다.
- 프롬프트 입력창: `/` 명령 메뉴, 권한 모드 선택, 컨텍스트 표시, 멀티라인 입력, 파일·폴더 첨부를 제공한다.
- 파일 참조: 현재 선택 영역을 컨텍스트로 보고, `@file#Lx-Ly` 형태의 명시적 참조를 삽입할 수 있다.
- 계획 검토: Plan mode에서는 실행 전에 Markdown 계획을 열고 사용자가 수정하거나 코멘트할 수 있다.
- Diff 승인: 파일 변경 전후를 side-by-side diff로 보여주고 accept/reject/modify 지시를 받는다.
- 세션 히스토리: 과거 대화를 검색하고 재개할 수 있다.
- 터미널 fallback: 그래픽 패널과 CLI 터미널 모드를 오갈 수 있다.
- Checkpoint/rewind: 특정 메시지나 변경 시점으로 코드 또는 대화를 되돌릴 수 있다.
- IDE bridge: selection, diagnostics, diff viewer, 파일 열기·저장 같은 IDE 기능을 에이전트와 연결한다.

참고 문서:

- Claude Code VS Code integration: https://code.claude.com/docs/en/ide-integrations
- Claude Agent SDK agent loop: https://code.claude.com/docs/en/agent-sdk/agent-loop
- Claude Agent SDK streaming input: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- Claude Agent SDK streaming output: https://code.claude.com/docs/en/agent-sdk/streaming-output

## 3. 기존 제품 맥락

현재 앱 기반:

- Electron 42, React 18, TypeScript.
- Claude 실행 경로는 `src/main/pty/claude-pty.ts`.
- `@lydell/node-pty`로 셸을 띄운 뒤 `claude` 또는 `claude --resume <id>`를 실행한다.
- 렌더러 터미널 UI는 `src/renderer/src/terminal/Terminal.tsx`이며 xterm.js를 사용한다.
- `src/main/sessions.ts`는 `~/.claude/projects` 아래 Claude transcript를 읽어 세션 목록을 만든다.
- 앱은 이미 사건 폴더, 원격 SSH 세션, 파일트리, PDF/HWP/CSV/Markdown 뷰어, 작업환경 저장·복원, Claude로 파일 드래그앤드롭을 지원한다.

설계상 결론:

- 터미널을 제거하지 않는다.
- 새 에이전트 패널을 Claude의 기본 고수준 UI로 추가한다.
- 기존 터미널은 고급 기능, 호환성, 장애 대응용 fallback으로 항상 남긴다.
- `jurisupport-plugins`, Claude 설정, MCP, hooks, transcript history와의 호환성을 유지한다.
- 로컬 사건과 SSH 원격 사건 흐름을 모두 지원한다.

## 4. 제품 원칙

- 송무 업무 우선: 일반 챗봇이 아니라 법률 기록 검토와 서면 작성에 맞는 차분한 작업 화면이어야 한다.
- 에이전트 상태 가시화: 파일 읽기, 검색 실행, 초안 작성, 명령 실행, 권한 대기, 완료, 실패, 질문 대기 상태가 구분되어야 한다.
- 변경은 검토 가능해야 한다: 파일 변경은 diff로 확인하고 승인할 수 있어야 한다.
- 컨텍스트는 감사 가능해야 한다: 어떤 사건 폴더, 문서, 선택 영역, PDF 페이지, 터미널 출력이 Claude에게 전달되었는지 보여준다.
- 터미널 지식은 선택 사항이어야 한다: 일반 흐름은 버튼과 패널만으로 가능해야 한다.
- 기존 기능 회귀는 금지한다: xterm 터미널 기반 Claude 사용 흐름은 그대로 작동해야 한다.

## 5. 범위

1차 범위:

- `legal-terminal` 내부의 새 그래픽 Agent Panel.
- Claude 세션 생성, 프롬프트 전송, 응답 스트리밍, 중단, 재개, 닫기.
- 기존 파일트리와 뷰어에서 파일·폴더·PDF 페이지·문서 선택 영역 첨부.
- Read, Grep, Bash, Edit, Write, MCP 호출, 법률 도구 호출 상태 카드.
- 권한 요청 UI와 Plan mode 검토 UI.
- Diff 미리보기, 승인, 거절.
- 기존 Claude transcript 기반 세션 히스토리.
- Claude plugin 관리 그래픽 UI.
- 지원되지 않는 기능을 위한 터미널 fallback.

1차 제외 범위:

- VS Code 자체를 대체하는 기능.
- 공개 배포용 VS Code extension 패키지.
- 모바일·웹 원격 제어.
- 모든 파일 작업에 대한 완전한 checkpoint rewind. MVP에서는 앱이 중재한 변경만 checkpoint로 기록한다.

## 6. 사용자 경험 명세

### 6.1 레이아웃

기본 배치:

- 현재 터미널이 열리는 오른쪽 작업 패널 슬롯에 Agent Panel을 열 수 있다.
- 작업 패널 탭은 `terminal` 또는 `agent` 타입을 가질 수 있다.
- cwd와 세션 컨텍스트가 있는 터미널 탭은 Agent 탭으로 전환할 수 있다.
- Agent 탭에서는 "터미널로 열기" 버튼을 제공해 같은 사건 폴더의 xterm 기반 Claude로 이동할 수 있다.

Agent Panel 구성:

- 헤더: 세션 제목, 사건 배지, cwd 또는 원격 배지, 모델·상태, 히스토리 버튼, 터미널 전환 버튼.
- 타임라인: 사용자 메시지, Claude 응답, 도구 실행 카드, 권한 카드, diff 카드, plan 카드.
- 컨텍스트 바: 첨부 파일, 선택 영역, PDF 페이지 범위, 터미널 출력 스니펫.
- 프롬프트 박스: 멀티라인 입력, send/stop, slash menu, attach menu, 권한 모드 선택, 컨텍스트 표시.

### 6.2 진입점

필수 진입점:

- 기존 터미널 새로 열기 주변에 "새 Agent" 버튼을 추가한다.
- 사건 대시보드 액션에 "Agent로 열기", "Claude 브리핑", "`/brief-protocol` 초안"을 추가하거나 기존 액션을 Agent Panel로 라우팅한다.
- 파일트리에서 파일을 Agent Panel로 드롭하면 즉시 전송하지 않고 첨부 칩으로 추가한다.
- 뷰어에서 "현재 문서 질문", "선택 영역 첨부", "PDF 현재 페이지 첨부" 액션을 제공한다.
- 세션 목록에서는 과거 Claude 세션을 Agent 또는 Terminal로 재개할 수 있다.

새 Claude 세션 기본값:

- M1-M4 기간에는 Agent Panel을 opt-in으로 둔다.
- opt-in은 사용자가 "새 Agent" 또는 "Agent로 열기"를 눌렀을 때만 그래픽 Agent Panel을 여는 방식이다.
- default는 기존 "새 Claude/터미널" 진입도 Agent Panel을 먼저 여는 방식이다.
- M4 diff approval이 안정화되기 전에는 Agent Panel이 일부 편집을 완전히 중재하지 못할 수 있으므로 opt-in이 안전하다.
- M4 이후에는 새 Claude 세션의 기본값을 Agent Panel로 전환하고, 터미널은 명시적 fallback으로 제공한다.

### 6.3 프롬프트 박스

필수 요소:

- Send / Stop 버튼.
- 권한 모드 segmented control:
  - Ask: 편집과 명령 실행은 승인 필요.
  - Plan: 읽기 중심 탐색 후 실행 전 계획을 제시.
  - Accept edits: 파일 편집은 자동 승인하되 Bash는 승인 필요.
  - Terminal: 현재 컨텍스트를 xterm 터미널에서 연다.
- Slash menu:
  - `/plan`
  - `/compact`
  - `/resume`
  - `/mcp`
  - `/plugins`
  - `/brief-protocol`
  - `/cold-start-interview`
- 컨텍스트 표시:
  - 첨부 개수.
  - 활성 선택 영역.
  - 가능한 경우 예상 컨텍스트 크기.

### 6.4 Claude plugin 관리 UI

Claude plugin 관리는 terminal fallback이 아니라 그래픽 UI로 제공한다.

필수 기능:

- 설치된 plugin 목록.
- plugin 활성/비활성 상태.
- plugin 업데이트 확인.
- plugin 설치 경로 또는 URL 입력.
- plugin 제거 또는 비활성화.
- plugin별 제공 command/skill 요약.
- 문제 발생 시 진단 로그 보기.

구현 방침:

- UI는 그래픽으로 제공하되, 실제 동작은 Claude CLI의 `plugin|plugins` 명령 또는 Claude 설정 파일을 안전하게 감싼다.
- 고급 명령이나 예외 상황은 터미널 fallback으로 열 수 있다.
- `jurisupport-plugins`는 별도 중요 plugin group으로 표시한다.
- 법률 업무에 중요한 PII hook, korean-law MCP, songmu-legal skill 상태를 한눈에 확인할 수 있게 한다.

### 6.5 메시지 타임라인

지원해야 하는 메시지 타입:

- 사용자 메시지: 프롬프트와 첨부 목록.
- Claude 응답: 스트리밍 Markdown.
- Thinking block: 엔진이 제공하는 경우 기본 접힘 상태로 표시.
- 도구 카드:
  - 도구 이름, 상태, 대상 파일·명령, 경과 시간.
  - 입력·출력은 펼쳐볼 수 있다.
  - 환경변수, 토큰, 키처럼 민감한 문자열은 표시 전에 마스킹한다.
- 권한 카드:
  - 제안된 작업.
  - 위험 라벨.
  - 이번만 허용, 세션 중 항상 허용, 거절, Claude에게 지시 버튼.
- 계획 카드:
  - Markdown 미리보기.
  - 편집 가능한 Markdown 탭으로 열기.
  - 계획 승인, 계획 수정 요청.
- Diff 카드:
  - 파일 경로.
  - 추가·삭제 요약.
  - side-by-side diff 열기.
  - 적용, 거절, 수정 요청.

### 6.6 파일 참조와 첨부

지원할 참조 형식:

```text
@path/to/file
@path/to/file#L10-L40
@path/to/folder/
@record.pdf#page=3
@record.pdf#pages=3-8
@terminal:<title>
```

동작 규칙:

- 파일을 프롬프트 박스로 드래그하면 첨부 칩으로 추가한다.
- MVP에서는 드롭 즉시 전송하지 않는다.
- 첨부는 전송 전 제거할 수 있다.
- 민감 파일은 첨부 전에 차단한다.
- 큰 PDF는 전체 파일보다 페이지 또는 범위 선택을 기본으로 유도한다.
- 첨부 칩에는 파일명뿐 아니라 경로 또는 사건 내 상대 위치를 표시한다.

### 6.7 Diff 검토

MVP 동작:

- 앱이 중재하는 편집은 메모리 또는 임시 파일에 제안본을 만든다.
- 렌더러는 디스크의 현재 내용과 제안본을 side-by-side diff로 연다.
- 사용자는 적용, 거절, 제안본 수정 후 적용을 선택할 수 있다.
- 사용자가 제안본을 수정해 적용하면 원래 Claude 제안과 실제 적용 내용이 다르다는 이벤트를 세션에 남긴다.

Fallback 동작:

- Claude Code 내부가 파일을 직접 변경해 앱이 사전 차단하지 못한 경우, 변경 감지 후 사후 diff와 되돌리기 옵션을 제공한다.
- 어떤 작업을 구조화 이벤트로 해석할 수 없으면 terminal fallback 경고를 표시하고 xterm 세션을 계속 사용할 수 있게 한다.

### 6.8 세션 히스토리

필수 기능:

- 기존 session index와 transcript scan을 재사용한다.
- 로컬 세션과 원격 세션을 구분한다.
- 사건번호, 사건명, 의뢰인, cwd, transcript title, session id로 검색한다.
- Agent로 재개 가능한 세션은 Agent로 열고, 불가능한 세션은 Terminal로 연다.
- transcript의 AI 제목이 바뀌면 탭 제목도 갱신한다.

### 6.9 Checkpoint

MVP:

- 승인된 편집 묶음마다 checkpoint를 생성한다.
- checkpoint에는 변경 파일 경로, before hash, after hash, timestamp, session id, prompt id를 기록한다.
- UI는 "checkpoint diff 보기"와 "이 편집 묶음 되돌리기"를 제공한다.

후속:

- checkpoint에서 대화 fork.
- 코드만 rewind하고 대화는 유지.
- 코드와 대화를 함께 rewind.

## 7. 기술 아키텍처

### 7.1 주요 컴포넌트

Main process:

- `src/main/agent/agent-service.ts`: 세션 registry, 엔진 선택, lifecycle 관리.
- `src/main/agent/agent-types.ts`: main/preload/renderer가 공유할 이벤트·명령 타입.
- `src/main/agent/agent-sdk-engine.ts`: Claude Agent SDK 기반 구조화 엔진.
- `src/main/agent/agent-pty-engine.ts`: 기존 PTY 기반 호환 엔진.
- `src/main/agent/agent-checkpoints.ts`: 편집 checkpoint 저장.
- `src/main/agent/agent-context.ts`: 파일, 선택 영역, PDF 페이지, 터미널 출력 컨텍스트 구성.

Preload:

- `window.api.agent` namespace를 추가한다.

Renderer:

- `src/renderer/src/agent/AgentPanel.tsx`
- `src/renderer/src/agent/AgentTimeline.tsx`
- `src/renderer/src/agent/PromptBox.tsx`
- `src/renderer/src/agent/ContextChips.tsx`
- `src/renderer/src/agent/ToolCard.tsx`
- `src/renderer/src/agent/PermissionCard.tsx`
- `src/renderer/src/agent/DiffCard.tsx`
- `src/renderer/src/agent/SessionHistoryDialog.tsx`

### 7.2 엔진 전략

1차 구현 엔진: Claude Agent SDK.

결정:

- 첫 구현부터 `@anthropic-ai/claude-agent-sdk`를 추가한다.
- 기존 PTY 엔진은 제거하지 않고 fallback으로 유지한다.
- SDK 엔진은 Agent Panel의 기본 구조화 엔진으로 사용한다.

SDK를 선택하는 이유:

- Claude Code와 유사한 autonomous loop를 구조화된 방식으로 사용할 수 있다.
- streaming input mode는 장기 실행 대화, queued message, interrupt, permission request, session management에 적합하다.
- streaming output은 partial text와 tool-call event를 제공하므로 터미널이 아닌 UI 구현에 적합하다.

CLI 구조화 출력 점검 결과:

- 로컬 설치 Claude Code CLI `2.1.161`은 `--output-format stream-json`, `--input-format stream-json`, `--include-hook-events`, `--include-partial-messages`, `--permission-mode`, `--allowedTools`, `--disallowedTools`를 지원한다.
- 따라서 SDK 없이도 구조화 stream을 직접 점검할 수 있다.
- 다만 diff/permission UI에 충분한 실제 event payload인지는 임시 폴더에서 read/edit/bash 시나리오를 실행해 샘플 JSONL을 수집해야 확정된다.
- 이 점검은 M0에서 수행하되, 구현 기본 방향은 SDK 엔진으로 둔다.

호환 엔진: 기존 PTY.

사용 목적:

- 현재 동작 보존.
- CLI-only 기능 지원.
- plugin 관리, shell shortcut, edge case 대응.
- SDK 또는 stream-json 엔진이 지원하지 못하는 상황의 탈출 경로 제공.

한계:

- PTY 출력은 화면 지향이며 이벤트 지향이 아니다.
- 전체 TUI 출력을 안정적으로 파싱해 권한·diff UI로 바꾸는 것은 취약하다.
- MVP에서는 PTY 출력을 무리하게 파싱하지 말고 세션 상태와 terminal fallback 중심으로 사용한다.

원격 SSH 엔진 방침:

- 원격 사건은 현재 터미널 흐름처럼 원격 사건 폴더 안에서 Claude를 실행하는 방식을 우선한다.
- 이유는 원격 경로, 원격 도구, 원격 `jurisupport-plugins`, 원격 Claude hooks, 원격 OneDrive/rclone 환경이 그대로 작동하기 때문이다.
- 로컬 앱은 UI controller 역할을 맡고, SSH로 원격 `claude`의 구조화 stream을 주고받는다.
- SFTP는 파일 미리보기, 첨부 선택, diff 표시, 적용 확인에 사용한다.
- 로컬에서 SFTP 파일만 읽어 Claude에 넘기는 방식은 네트워크 왕복과 경로 불일치가 커서 보조 경로로만 둔다.

### 7.3 이벤트 모델

모든 엔진은 렌더러에 같은 이벤트 stream을 제공해야 한다.

```ts
type AgentEvent =
  | { type: 'session:init'; sessionId: string; title?: string; cwd: string; source: 'local' | 'ssh' }
  | { type: 'message:user'; messageId: string; text: string; attachments: AgentAttachment[] }
  | { type: 'message:assistant_start'; messageId: string }
  | { type: 'message:assistant_delta'; messageId: string; text: string }
  | { type: 'message:assistant_done'; messageId: string }
  | { type: 'tool:start'; toolId: string; name: string; label: string; inputPreview?: string }
  | { type: 'tool:delta'; toolId: string; text?: string; inputJsonDelta?: string }
  | { type: 'tool:done'; toolId: string; outputPreview?: string; elapsedMs: number }
  | { type: 'permission:request'; request: AgentPermissionRequest }
  | { type: 'permission:resolved'; requestId: string; decision: 'allow' | 'reject' }
  | { type: 'diff:proposed'; proposal: AgentDiffProposal }
  | { type: 'diff:applied'; proposalId: string; checkpointId?: string }
  | { type: 'plan:proposed'; planId: string; markdown: string }
  | { type: 'status'; status: 'idle' | 'working' | 'waiting_permission' | 'waiting_user' | 'done' | 'error' }
  | { type: 'error'; message: string; recoverable: boolean }
```

### 7.4 IPC 표면

Preload API:

```ts
window.api.agent.create(opts)
window.api.agent.send(sessionId, input)
window.api.agent.interrupt(sessionId)
window.api.agent.close(sessionId)
window.api.agent.resume(sessionId, opts)
window.api.agent.approve(requestId, decision)
window.api.agent.applyDiff(proposalId, contentOverride?)
window.api.agent.rejectDiff(proposalId, reason?)
window.api.agent.listSessions(context?)
window.api.agent.onEvent(cb)
```

IPC channel:

- `agent:create`
- `agent:send`
- `agent:interrupt`
- `agent:close`
- `agent:resume`
- `agent:approve`
- `agent:applyDiff`
- `agent:rejectDiff`
- `agent:listSessions`
- `agent:event`

보안 규칙:

- 렌더러가 IPC를 통해 임의 shell command를 직접 실행할 수 없어야 한다.
- 파일 쓰기는 기존 main-process 파일 핸들러 또는 agent diff 승인 경로만 사용한다.
- 원격 SSH 작업은 기존 profile 구조를 재사용하며 private key를 렌더러에 노출하지 않는다.

### 7.5 IDE Bridge 대응 설계

`legal-terminal`은 VS Code의 숨겨진 IDE MCP 서버를 그대로 구현할 필요는 없다. 다만 같은 구조적 아이디어를 적용한다.

- socket 또는 server가 필요하면 local-only로 bind한다.
- 세션마다 랜덤 token을 생성한다.
- token은 사용자 전용 권한으로 저장한다.
- 에이전트에 노출하는 도구는 좁게 제한한다.
  - 활성 문서 조회.
  - 선택 영역 조회.
  - 가능한 경우 diagnostics 조회.
  - diff 열기.
  - 승인된 컨텍스트 첨부 읽기.
  - 승인된 편집 적용.
- 내부 UI RPC와 모델이 호출할 수 있는 tool API를 분리한다.

MVP에서는 별도 MCP 서버 대신 Electron IPC로 충분하다. Claude/SDK 통합상 MCP가 필요할 때만 추가한다.

## 8. 권한과 안전

기본 모드: Ask.

권한 분류:

- Read-only: 파일 읽기, grep, PDF page extraction, transcript 읽기.
- Edit: write, patch, move, delete, create file/folder.
- Execute: Bash, PowerShell, 외부 CLI, network tool.
- External: browser, web search/fetch, JuriSupport API, 법원·도서관 검색.
- Sensitive: `.env`, credentials, private key, token store, 법률 PII export.

규칙:

- Ask mode에서 read-only tool은 deny rule에 걸리지 않으면 자동 실행 가능하다.
- Ask mode와 Plan mode에서 편집은 승인 필요.
- Bash는 narrow allow rule에 맞지 않으면 승인 필요.
- 일반 빌드에서 `bypassPermissions` 계열 옵션은 노출하지 않는다.
- 원격 세션의 permission card와 diff card에는 remote badge를 표시한다.
- 법률 기록 첨부는 출처 경로와 페이지 범위를 표시해 사용자가 감사할 수 있어야 한다.

법률 PII 보호:

- PII는 주민등록번호, 외국인등록번호, 계좌번호, 전화번호, 주소, 이메일, 당사자 실명, 미성년자 정보, 건강·가족관계 정보처럼 개인을 식별하거나 법률상 민감한 정보를 말한다.
- 법률 PII 보호는 이런 정보가 의도치 않게 프롬프트, 첨부, tool output, 로그, 외부 검색, plugin 호출로 흘러가는 것을 막는 장치다.
- 앱 레이어 보호는 사용자가 보내기 전에 첨부 파일, 선택 영역, PDF 추출 텍스트, terminal snippet을 검사하고 경고·마스킹·차단한다.
- Claude hook 보호는 Claude 내부 tool 실행이나 plugin/MCP 호출 단계에서 한 번 더 검사한다.
- 결정: 양쪽 모두에서 보호한다. 앱 레이어는 사용자에게 보이는 사전 차단 역할을 하고, Claude hook은 에이전트 내부 동작의 마지막 방어선 역할을 한다.
- 앱은 hook이 설치·활성화되어 있는지 plugin 관리 UI에서 표시해야 한다.

## 9. 저장소와 데이터

제안하는 app data 파일:

- `agent-sessions.json`: agent tab과 세션 metadata.
- `agent-checkpoints/<sessionId>/<checkpointId>.json`: checkpoint metadata.
- `agent-checkpoints/<sessionId>/<checkpointId>/before/*`: 필요한 경우 before snapshot.
- `agent-settings.json`: 권한 모드, 패널 위치, 컨텍스트 기본값.

재사용할 기존 데이터:

- `~/.claude/legal-terminal-sessions.json`: Claude transcript metadata (구 `session-index.json` — SSH 호스트 간 세션 동기화를 위해 기기 공유 경로로 이동).
- workspace snapshot: 열린 탭과 현재 사건 상태.

## 10. MVP 마일스톤

### M0: 명세와 실현 가능성 확인

산출물:

- 본 명세서.
- 설치된 Claude binary 또는 Agent SDK가 macOS/Windows에서 필요한 구조화 이벤트를 제공하는지 확인.
- Claude Code CLI stream-json 샘플을 임시 폴더에서 수집해 tool, permission, edit 이벤트 payload를 확인.
- `@anthropic-ai/claude-agent-sdk` 추가.

수용 기준:

- SDK 엔진을 1차 구현 경로로 확정한다.
- PTY fallback의 역할과 한계가 문서화되어 있다.
- SDK 없이 CLI stream-json만으로 가능한 범위와 부족한 범위가 샘플로 확인되어 있다.

### M1: Agent Panel shell

산출물:

- 기존 좌우 작업 패널 시스템에 Agent tab type 추가.
- Header, timeline, context chips, prompt box.
- 선택한 엔진을 통한 세션 생성과 기본 send/receive.
- Terminal fallback 버튼.

수용 기준:

- 사용자가 사건을 열고 Agent 세션을 시작해 프롬프트를 보내고, 터미널이 아닌 화면에서 응답을 볼 수 있다.
- 같은 컨텍스트를 터미널로 열 수 있다.

### M2: Context attachment

산출물:

- 파일, 폴더, 선택 영역, PDF 페이지 범위, 터미널 출력 snippet 첨부.
- `@` fuzzy picker.
- 제거·위치 열기 기능이 있는 attachment chip.

수용 기준:

- 사용자가 복사·붙여넣기 없이 선택한 Markdown 범위나 PDF 페이지 범위에 대해 질문할 수 있다.

### M3: Tool card와 permission

산출물:

- tool start/done event 정규화.
- read/search/bash/edit 카드 렌더링.
- Ask/Plan/Accept edits 모드.
- permission prompt UI.

수용 기준:

- Ask mode에서 승인되지 않은 명령 실행이나 편집이 진행되지 않는다.

### M4: Diff approval

산출물:

- 제안 편집 capture.
- side-by-side diff view.
- accept/reject/modify.
- 기본 checkpoint.

수용 기준:

- 사용자가 제안된 문서 편집을 검토하고, 수정한 뒤 적용하거나 거절할 수 있다.
- 적용된 편집 묶음을 checkpoint에서 되돌릴 수 있다.

### M5: History와 resume

산출물:

- Agent session history dialog.
- 가능한 local transcript는 Agent로 resume.
- 지원되지 않는 세션은 Terminal로 resume.

수용 기준:

- 사용자가 사건번호로 이전 대화를 찾아 이어서 작업할 수 있다.

### M6: Plugin 관리 그래픽 UI

산출물:

- Claude plugin 목록 UI.
- `jurisupport-plugins` 상태 표시.
- plugin 설치, 업데이트, 비활성화, 제거 액션.
- plugin 제공 command/skill 요약.
- PII hook, korean-law MCP, songmu-legal skill 설치 상태 점검.

수용 기준:

- 사용자가 터미널 명령 없이 plugin 상태를 확인하고 기본 관리를 수행할 수 있다.
- plugin 작업 실패 시 원인과 terminal fallback 진입점이 표시된다.

## 11. 테스트 계획

Unit test:

- Agent event normalization.
- Attachment path/range parsing.
- Permission classification.
- Checkpoint metadata generation.

Integration test:

- Main/preload IPC contract.
- Local session create/send/interrupt/close.
- Diff proposal accept/reject.
- 기존 PTY terminal 동작 유지.

Manual QA:

- macOS local case folder.
- Windows local case folder.
- SSH remote case folder.
- `jurisupport-plugins` 명령이 terminal fallback에서 계속 작동.
- 큰 PDF page-range attachment.
- 민감 파일 차단.

회귀 검증:

- `npm run typecheck`
- `npm run build`

## 12. 결정 사항과 남은 확인

결정 사항:

- 첫 구현부터 Claude Agent SDK를 추가한다.
- 기존 PTY 엔진은 fallback으로 유지한다.
- Claude plugin 관리는 그래픽 UI로 만든다.
- 새 Claude 세션은 M1-M4 동안 Agent Panel opt-in으로 운영하고, M4 diff approval 안정화 후 Agent Panel을 기본값으로 전환한다.
- SSH 원격 사건은 원격 사건 폴더 안에서 Claude를 실행하는 방식을 우선한다.
- 법률 PII 보호는 앱 레이어와 Claude hook 양쪽에서 수행한다.

남은 확인:

- Claude Code CLI `stream-json` 실제 payload가 diff/permission UI에 충분한지 임시 폴더 실험으로 확인한다.
- Claude Agent SDK가 local/remote resume, permission callback, tool event, partial message를 현재 앱 요구 수준으로 제공하는지 확인한다.
- 원격 SSH 구조화 stream에서 Windows/macOS 줄바꿈, 인코딩, 장기 연결 안정성을 확인한다.
- Plugin 그래픽 UI가 직접 설정 파일을 편집해야 하는 범위와 CLI 명령으로 처리할 범위를 나눈다.

## 13. 권장 구현 순서

권장 순서:

1. Renderer Agent Panel shell과 IPC type부터 만든다.
2. 기존 terminal behavior를 건드리기 전에 engine abstraction을 추가한다.
3. `@anthropic-ai/claude-agent-sdk`를 추가하고 SDK engine을 구현한다.
4. Terminal fallback은 항상 유지한다.
5. CLI `stream-json` 샘플 수집으로 SDK fallback 또는 원격 SSH engine에 필요한 event mapping을 확정한다.
6. Auto-edit mode를 넓게 노출하기 전에 diff approval을 먼저 구현한다.
7. Plugin 관리 그래픽 UI를 추가하되, 고급·오류 상황은 terminal fallback으로 열 수 있게 한다.

이 순서는 현재 `legal-terminal`의 안정성을 유지하면서 Claude Code VS Code 스타일 인터페이스를 단계적으로 얹기 위한 것이다.
