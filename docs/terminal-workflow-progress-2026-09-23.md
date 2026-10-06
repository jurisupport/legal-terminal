# 터미널 앱 동향 반영 — 진행 현황과 남은 과제

작성일: 2026-09-23  
최종 갱신: 2026-09-25  
대상: legal-terminal  
범위: 이번 대화에서 조사·선정하고 구현한 터미널 작업환경 개선 과제

## 1. 현재 상태

선정한 다섯 과제 중 **네 과제의 구현과 자동 검증을 완료했다.** PDF 인용과 확인 대기 사건 기능은 사용자가 직접 확인했다. 과제 3은 [v0.1.235](https://github.com/jurisupport/legal-terminal/releases/tag/v0.1.235)로 배포했고 실사용하면서 보완하기로 했다. 과제 4는 즐겨찾기 버튼 대신 **선택 영역 인라인 지시·문장 자동완성**으로 변경하고 목업 방향으로 다듬었다. 사용자의 2026-09-25 배포 요청에 따라 [v0.1.238](https://github.com/jurisupport/legal-terminal/releases/tag/v0.1.238) 정식 배포를 완료했다.

| 순서 | 과제 | 구현·자동 검증 | 사용자 확인 | 다음 행동 |
|---|---|---|---|---|
| 1 | PDF 인용에 쪽번호와 원문 이동 연결 | 완료 | 완료 — “다 잘 됨” 확인 | v0.1.238에 원문 연결 포함·실사용 보완 |
| 2 | 확인이 필요한 사건 필터와 다음 작업 이동 | 완료 | 완료 — “다 잘 됨” 확인 | 유지·회귀검사 |
| 3 | 이번 AI 작업에서 변경한 문서 모아보기 | 완료 | 배포 후 실사용 중 보완하기로 결정 | v0.1.235 배포 완료·실사용 의견 수집 |
| 4 | 선택 영역 인라인 지시·문장 자동완성 | 완료 | 수정본 배포 요청 | v0.1.238 정식 배포 완료·실사용 보완 |
| 5 | 연결이 끊겨도 계속되는 SSH 작업 | 미착수 | — | 유지할 작업 범위와 기존 수단 조사 |

과제 3은 v0.1.234를 기준으로 별도 작업공간에서 v0.1.235로 배포했다. 과제 1·2는 해당 배포에 포함하지 않았다. 과제 4는 v0.1.237을 기준으로 v0.1.238로 배포했으며, 선택한 PDF의 원문 연결에 필요한 과제 1 코드를 함께 포함했다. 과제 2와 기존 작업 폴더의 병행 변경은 가져오지 않았다.

## 2. 조사 결과와 선택 이유

대표 터미널 앱의 공식 발표·문서를 살펴보고 기존 앱 기능과 비교했다. 공통적으로 여러 AI 작업의 상태 확인, 변경 결과 검토, 문서와 대화의 연결, 작업 재개 경험이 강조되고 있었다.

| 참고 제품 | 참고한 방향 | 우리 앱에 반영할 내용 |
|---|---|---|
| Warp | 여러 에이전트 지원, 선택한 내용 전달, 변경 검토 | PDF 인용 연결, 변경문서 모아보기 |
| cmux | 주의가 필요한 작업 알림과 해당 작업으로 이동 | 확인 필요 필터, 다음 확인 작업 |
| Wave | 문서·터미널 통합 작업공간, 지속되는 원격 세션 | 기존 문서 작업공간 활용, SSH 작업 유지 검토 |
| iTerm2 | 작업 상태 우선순위, 대화·비교·검토 연결 | 사건별 작업 확인과 변경 검토 |
| Ghostty | 검색·입력·스크롤·안정성 개선 | 기존 한글 입력·탐색·복원 품질 유지 |
| Windows Terminal | 명령 팔레트와 기능 발견성 | 기존 명령 진입점 활용, 즐겨찾기 검토 |

우리 앱에는 이미 명령 팔레트, 사건별 작업환경 복원, 알림, 개별 변경 비교·되돌리기, 슬래시 명령이 있었다. 이번 구현은 이 기능들을 재사용했으며 새로운 의존성을 추가하지 않았다.

참고 자료:

- [Warp — 여러 에이전트 지원과 변경 검토](https://www.warp.dev/blog/universal-agent-support-level-up-coding-agent-warp)
- [cmux — 알림과 작업 이동](https://cmux.com/docs/notifications)
- [Wave — 지속되는 SSH 세션](https://docs.waveterm.dev/durable-sessions)
- [iTerm2 — Claude Code 통합](https://iterm2.com/claude-code-integration.html)
- [Ghostty — 1.3.0 릴리스](https://ghostty.org/docs/install/release-notes/1-3-0)
- [Windows Terminal — 2026년 3월 업데이트](https://devblogs.microsoft.com/commandline/windows-terminal-preview-1-25-release/)

## 3. 완료한 과제

### 3.1. PDF 인용 쪽번호와 원문 이동

**사용 흐름:** PDF 문장 선택 → ‘Claude에 묻기’ → 문서명·쪽번호가 붙은 첨부 → 첨부 클릭 → 원문 해당 쪽.

구현 내용:

- 선택한 문장이 실제로 렌더링된 PDF 페이지에서 쪽번호와 파일 경로를 가져온다.
- 첨부 이름과 AI에 전달하는 내용에 PDF 쪽번호를 포함한다.
- 다른 페이지를 보고 있거나 원문 탭을 닫은 뒤에도 인용한 파일의 해당 쪽으로 이동한다.
- 기록뷰어가 다음 파일로 넘어갔을 때도 원래 인용 파일을 구분한다.
- PDF가 늦게 열려도 요청한 페이지 이동이 로딩 완료 과정에서 사라지지 않는다.
- 기존 Markdown 인용과 원문 이동은 유지한다.

적용 범위: 텍스트를 선택할 수 있는 PDF. 쪽번호는 **PDF 파일의 실제 페이지 순서**이며, 문서에 인쇄된 별도 쪽번호를 해석하는 기능이나 OCR은 추가하지 않았다.

상태: 구현·자동 검증·사용자 확인 완료. v0.1.238에 원문 연결을 포함해 배포했다.

### 3.2. 확인 필요 사건 필터와 다음 작업 이동

**사용 흐름:** 사건탭 열기(`⌘0`, Windows는 `Ctrl+0`) → ‘확인 필요만’ → ‘다음 확인 작업’.

구현 내용:

- 미해결 질문·승인 대기, 미확인 완료, 문서 업데이트가 있는 사건을 걸러서 보여준다.
- 다음 확인 작업을 누르면 해당 Agent·터미널 또는 변경 문서로 이동한다.
- 같은 사건의 여러 대기 작업과 다른 사건을 순서대로 이동할 수 있다.
- 사건이나 질문을 열어 본 상태와 실제 질문이 해결된 상태를 구분한다.
- 사건을 열었다고 숨겨진 다른 작업의 알림을 한꺼번에 지우지 않는다.
- 확인할 작업이 없으면 빈 상태를 표시하고 다음 이동 버튼을 비활성화한다.
- 완료 직후 상태가 연속으로 바뀌어도 미확인 완료 알림이 사라지지 않도록 보완했다.

상태: 구현·자동 검증·사용자 확인 완료.

### 3.3. 이번 작업 변경문서 모아보기

**사용 흐름:** Agent에게 문서 수정 요청 → 패널 상단 ‘이번 작업 변경 문서’ → 문서명 클릭으로 비교 → 문서 열기 또는 지원되는 변경 되돌리기.

구현 내용:

- 마지막 사용자 요청 이후 앱에서 확인한 적용된 변경을 문서별로 모은다.
- 같은 파일의 반복 수정은 한 항목으로 묶고, 다른 폴더의 동명 파일은 구분한다.
- 이전 요청의 같은 파일 변경과 이번 요청의 변경이 합쳐지지 않도록 수정했다.
- 다음 요청을 대기열에 넣는 것만으로는 목록을 초기화하지 않는다. 실제 새 요청이 시작되면 새 목록으로 바뀐다.
- 아직 적용되지 않은 제안, 실패·거절·취소된 Codex 변경, Claude의 오류·검토 대기 변경은 적용 목록에서 제외한다.
- Codex의 한 번에 여러 파일 수정 결과를 파일별 이벤트로 분리하고 각 파일의 변경 비교를 표시한다.
- 기존 문서 열기·비교·개별 되돌리기를 재사용한다.
- Agent 작업 중에는 되돌리기를 비활성화한다. 현재 파일에서 대상 내용을 찾지 못하거나 여러 위치에 동일한 내용이 있으면 자동 저장하지 않는다.
- 목록 접기와 좁은 창 배치를 지원한다.

현재 범위:

- 목록은 **현재 대화에서 앱이 수신한 변경 이벤트**를 기준으로 한다. 모든 파일시스템 변경을 별도로 추적하는 감사 기록은 아니다.
- 앱 재시작 후 과거 변경 이력을 복원하는 기능은 추가하지 않았다.
- 자동 되돌리기에 필요한 정보가 있는 변경에만 되돌리기 버튼을 제공한다. 패치만 받은 변경에 전체 원문 복구를 약속하지 않는다.
- 여러 문서를 한꺼번에 되돌리는 작업 전체 체크포인트는 별도 과제로 남겼다.

상태: 구현·자동 검증 완료. 사용자가 배포 후 실사용하면서 보완하도록 명시적으로 요청했다. v0.1.235 정식 배포를 완료했으며 실사용 중 보완한다.

### 3.4. 선택 영역 인라인 지시·문장 자동완성

**사용 흐름:** 왼쪽 문서에서 문장 선택 → `⌘J` / `Ctrl+J` 또는 ‘이 부분에 지시’ → 짧은 지시 입력 → `Enter` → 오른쪽 Agent에서 답변 확인.

구현 내용:

- 왼쪽 뷰어와 오른쪽 Agent 패널의 역할을 유지하고, 선택한 문장 아래에 작은 입력창을 붙인다. 아래 공간이 부족하면 위로 배치한다.
- 2026-09-25 사용자 의견에 따라 목업에 가까운 테두리 없는 2행 입력, 간결한 헤더·세션 선택으로 다듬었다. 선택 강조는 입력 중에도 유지하며, 입력창은 원문 영역 안에서 스크롤·창 크기 변경을 따라간다.
- 문서명·PDF 쪽번호·사건과 받을 Agent 세션을 표시한다. 선택할 수 있는 대상은 같은 사건의 반대쪽 패널에 있는 Agent다.
- 입력창을 열 때 선택 내용·원문 위치·대상 세션을 고정한다. 다른 Agent 탭을 눌러도 대상이 저절로 바뀌지 않으며, 대상 선택란에서 명시적으로 변경할 수 있다.
- 보낼 Agent가 없으면 해당 사건과 기존 기본 제공자를 사용해 새 세션을 만든다. 원격 사건은 기존 SSH 프로필과 사건 폴더를 유지한다.
- 선택한 세션의 최근 지시 중 입력한 앞부분과 일치하는 짧은 한 줄 문장을 우선 제안한다. 이력이 없어도 `반박`·`요약`·`인용`으로 시작하는 목업의 기본 지시를 제안하며 `Tab`으로 완성한다. 별도 추천 모델이나 전역 즐겨찾기 저장소는 추가하지 않았다.
- 기존 Agent 전송·대기열을 재사용한다. 오른쪽 입력창에 작성하던 내용과 첨부는 유지하고, 답변·승인·대화 기록은 기존 Agent에서 처리한다.
- `Shift+Enter` 줄바꿈, `Esc` 닫기, 한글 조합 중 오발송 방지, 연속 Enter 중복 전송 방지를 적용했다.
- 대상 세션 종료·다른 사건으로 이동·인증 또는 전송 실패 시 입력을 보존하고 오류를 표시한다. 다른 세션으로 임의 전송하지 않는다.

현재 범위: 양쪽 패널이 있는 작업화면의 선택 가능한 문서. 분리된 단독 문서 창은 기존 인용 동작을 유지한다. 자동완성은 기본 문장 3개와 선택한 세션의 지시 이력을 사용하며, 문서 내용을 분석해 실시간으로 생성하는 기능은 아니다. PDF는 원래 지면을 유지하므로 아래 문단을 밀어내는 목업의 재배치 대신 선택 위치에 붙는 입력창을 사용한다.

상태: 구현·자동 검증 완료. 목업 방향으로 수정한 뒤 사용자가 다시 배포를 요청했다. v0.1.238 정식 배포와 macOS·Windows 파일 업로드를 완료했다.

## 4. 검증 현황

| 검증 | 결과 | 범위 |
|---|---|---|
| 타입 검사·프로덕션 빌드 | 통과 | 최신 구현 포함 |
| 관련 기능 회귀검사 | 통과 | 인용, PDF 로딩·페이지 이동, 사건탭·대기 상태, Agent 진행 상태·질문·사건 맥락 등 |
| PDF 인용·확인 대기 화면검사 | 15개 통과, 콘솔 오류 0 | 두 기능의 기존 동작과 좁은 창 배치 |
| 변경문서 화면검사 | 27개 통과, 콘솔 오류 0 | 문서별 집계, 요청 구분, 비교·문서 열기, 되돌리기 취소·성공, 좁은 창 배치 |
| 변경문서·Codex 이벤트 회귀검사 | 통과 | 다중 파일, 실패 제외, 원격·Windows 경로 처리, 변경 비교 파싱, 되돌리기 조건 |
| 인라인 지시 타입 검사·빌드 | 통과 | v0.1.237 기반 별도 작업공간의 최종 구현 |
| 인라인 지시 전달·대상·PDF 회귀검사 | 통과 | 사건·세션 고정, 대기열, 기존 입력·첨부 보존, 생성·인증·실패 처리, 원문 연결 |
| 인라인 지시 화면검사 | 67개 통과, 콘솔 오류 0 | 기본·이력 자동완성, PDF·Markdown 선택 강조, 스크롤·창 크기 변경, PDF 재렌더링·다른 쪽 분리, 단축키·한글 조합·전송·오류·세션·원격 맥락 |
| 사용자 직접 확인 | 첫 두 과제 완료 | PDF 인용, 확인 필요 사건 기능 |

화면검사는 실제 Electron 렌더러와 preload를 사용하되 합성 자료와 대체된 앱 내부 통신으로 수행했다. 실제 AI·SSH 서비스 연결을 모두 검증한 결과는 아니다. Windows 앱을 직접 실행한 검증도 이번 대화에서는 수행하지 않았다.

검사 결과와 화면:

- [PDF 인용·확인 대기 검사 결과](/Users/haheebong/Documents/korean-legal-terminal/output/playwright/terminal-workflow/result.json)
- [변경문서 검사 결과](/Users/haheebong/Documents/korean-legal-terminal/output/playwright/changed-documents/result.json)
- [변경문서 데스크톱 화면](/Users/haheebong/Documents/korean-legal-terminal/output/playwright/changed-documents/changed-documents-desktop.png)
- [변경문서 좁은 창 화면](/Users/haheebong/Documents/korean-legal-terminal/output/playwright/changed-documents/changed-documents-narrow.png)
- [인라인 지시 검사 결과](/Users/haheebong/.codex/worktrees/inline-selection-command/korean-legal-terminal/output/playwright/inline-selection/result.json)
- [인라인 지시 데스크톱 화면](/Users/haheebong/.codex/worktrees/inline-selection-command/korean-legal-terminal/output/playwright/inline-selection/inline-command-desktop.png)
- [인라인 지시 좁은 창 화면](/Users/haheebong/.codex/worktrees/inline-selection-command/korean-legal-terminal/output/playwright/inline-selection/inline-command-narrow.png)
- [목업 반영 후 기본 문장 완성 화면](/Users/haheebong/.codex/worktrees/inline-selection-command/korean-legal-terminal/output/playwright/inline-selection/inline-command-default-completion.png)
- [Markdown 여러 줄 선택 화면](/Users/haheebong/.codex/worktrees/inline-selection-command/korean-legal-terminal/output/playwright/inline-selection/inline-command-markdown.png)

이 결과 파일들은 로컬 검증 산출물이다. `output/`은 Git 추적 대상에서 제외되어 있다.

## 5. 남은 과제와 권장 순서

### 배포 후: 변경문서 모아보기 실사용 점검

- [ ] Agent에게 두 개 이상의 테스트 문서를 수정하도록 요청하고 목록에 각각 표시되는지 확인한다.
- [ ] 같은 문서를 여러 번 수정해도 목록이 중복되지 않고 비교 화면에는 변경이 남는지 확인한다.
- [ ] 문서명을 누르면 비교가 열리고, ‘문서 열기’가 올바른 파일로 연결되는지 확인한다.
- [ ] 되돌리기가 지원되는 테스트 변경에서 취소 시 유지, 승인 시 해당 문서 복구와 ‘되돌림’ 표시를 확인한다.
- [ ] 새 요청에서 이전 요청의 변경이 섞이지 않는지 확인한다.

이 점검은 배포 전 승인 조건이 아니라 실사용 중 보완할 항목이다. 문제가 발견되면 재현·수정·회귀검사 후 후속 버전에 반영한다.

### 배포 후: 인라인 지시 실사용

즐겨찾기 버튼안은 사용자의 의견에 따라 인라인 입력과 문장 자동완성으로 대체했다. 다음 항목은 구현 완료된 과제 4를 직접 확인할 때 사용한다.

- [ ] PDF 문장을 선택하고 `⌘J` / `Ctrl+J`로 입력창을 열어 문서명·쪽번호·받을 세션을 확인한다.
- [ ] 입력 중 원문의 선택 강조가 남고, 스크롤할 때 입력창이 선택 위치를 따라 움직이는지 확인한다.
- [ ] 오른쪽 Agent 입력창에 초안과 첨부를 남긴 채 인라인 지시를 보내고, 기존 초안이 유지되는지 확인한다.
- [ ] 같은 사건의 다른 Agent 탭을 열어도 받을 세션이 유지되고, 대상 선택란에서 바꾸면 지정한 세션으로 가는지 확인한다.
- [ ] 새 세션에서 `반박`·`요약`·`인용`을 입력해 기본 지시를 `Tab`으로 완성한다. 기존 세션에서는 앞서 보낸 짧은 지시가 우선 제안되는지 확인한다. 한글 조합 중 Enter가 곧바로 전송되지 않는지도 확인한다.
- [ ] Agent가 작업 중일 때 추가 지시가 대기열에 들어가는지, 세션이 없을 때 새 Agent에서 답변을 받는지 확인한다.
- [ ] 실제 원격 사건에서 SSH 연결과 원문 첨부를 확인한다.

자동 화면검사는 통과했지만 실제 AI·SSH 서비스 연결과 Windows 앱 직접 조작은 이번 검증에 포함하지 않았다. 위 목록은 배포 전 승인 조건이 아니라 실사용 중 확인·보완할 항목이다.

### 이후 개발: SSH 작업 유지와 재접속

목표: 원격 작업 중 네트워크가 끊기거나 로컬 앱이 종료되어도 원격 실행을 유지하고 다시 연결한다.

먼저 확인할 내용:

- 원격 터미널과 Agent 각각에서 유지해야 할 실행 상태를 구분한다.
- 기존 서버의 세션 유지 수단을 재사용할 수 있는지 확인한다.
- 연결 끊김, 노트북 잠자기, 앱 재시작, 사용자의 명시적 작업 종료를 구분한다.
- 재접속 시 같은 작업을 중복 실행하지 않고 현재 상태와 출력을 복구한다.

완료 기준: 연결 중단 전후 같은 원격 작업이 이어지고, 사용자가 종료한 작업은 종료된다. 실제 SSH 환경에서 검증해야 한다.

현재 있는 화면·대화 복원과 실행 중인 원격 프로세스의 생존은 구분한다. 구현 범위가 크므로 유지할 실행 상태와 기존 수단부터 확인한 뒤 착수한다.

## 6. 별도 확장 후보

아래 항목은 현재 합의한 다음 개발 범위에 포함하지 않는다.

- 작업 전체 체크포인트와 여러 문서 일괄 되돌리기: 동시 수정·충돌 처리 필요.
- 변경문서 이력 영속 저장과 재시작 후 복원: 저장 범위·보존 기간·재개 식별 기준 필요.
- 대규모 클라우드 Agent 운영: 앞선 기능의 실제 이용 효과를 확인한 뒤 검토.

과제 3의 v0.1.235 정식 배포를 완료했으며 실사용 중 보완한다. 격리 배포본의 관련 검사와 macOS·Windows 패키징, 정식 릴리스 전환을 확인했다. 로컬 종합 검증 결과와 실제 배포본 검증 결과는 구분한다.

## 7. 과제 3 배포 기록

- 기준 릴리스: v0.1.234.
- 배포 완료: [v0.1.235](https://github.com/jurisupport/legal-terminal/releases/tag/v0.1.235), 과제 3 변경문서 모아보기만 포함.
- 배포 결과: macOS Apple Silicon·Intel, Windows 설치본·포터블 모두 빌드·업로드 성공. 릴리스 자산 14개 및 두 업데이트 정보 파일의 버전·대상 파일 크기 일치를 확인했다.
- 배포 브랜치: `codex/release-v0.1.235`.
- 배포 커밋: `18078d115135b11f730cbb3a2153fcb3ff5c5f96`.
- 작업공간: `/Users/haheebong/.codex/worktrees/changed-documents-release/korean-legal-terminal`.
- [GitHub 배포 실행](https://github.com/jurisupport/legal-terminal/actions/runs/35785617963): 전체 작업 성공, 당시 정식 최신 릴리스 전환 완료.
- 격리 배포본 검증: 타입 검사·빌드·변경문서 및 Codex 회귀검사·기존 Agent 진행/질문/인용 검사 통과. 변경문서 화면검사 27개 통과, 콘솔 오류 0.
- 이번 배포 준비에서 Codex의 다른 작업·이전 요청 이벤트가 현재 목록에 섞이지 않도록 필요한 범위 검사를 함께 보완했다.
- 기존 작업 폴더의 버전·병행 변경은 유지했다. 후속 릴리스를 만들 때는 이 배포 태그의 계보를 기준으로 삼는다.

## 8. 구현 파일과 재검증 안내

다음 표는 원래 작업 폴더의 과제 1~3 파일이다. 과제 4는 아래 별도 작업공간에 있다.

| 영역 | 주요 파일 |
|---|---|
| PDF 인용·사건 필터·작업 이동 | [App.tsx](/Users/haheebong/Documents/korean-legal-terminal/src/renderer/src/App.tsx) |
| PDF 페이지 연결 | [PdfViewer.tsx](/Users/haheebong/Documents/korean-legal-terminal/src/renderer/src/viewer/PdfViewer.tsx), [RecordViewer.tsx](/Users/haheebong/Documents/korean-legal-terminal/src/renderer/src/viewer/RecordViewer.tsx) |
| 변경문서 목록·비교 연결·개별 되돌리기 | [AgentPanel.tsx](/Users/haheebong/Documents/korean-legal-terminal/src/renderer/src/agent/AgentPanel.tsx) |
| 변경 비교 파싱 | [diff.ts](/Users/haheebong/Documents/korean-legal-terminal/src/renderer/src/agent/diff.ts) |
| Codex 파일별 변경 이벤트·적용 판정 | [agent-service.ts](/Users/haheebong/Documents/korean-legal-terminal/src/main/agent/agent-service.ts) |
| 화면 배치 | [styles.css](/Users/haheebong/Documents/korean-legal-terminal/src/renderer/src/styles.css) |

주요 검증 스크립트:

- [인용 검사](/Users/haheebong/Documents/korean-legal-terminal/scripts/verify-agent-quote.mjs)
- [PDF 로딩·인용 페이지 검사](/Users/haheebong/Documents/korean-legal-terminal/scripts/verify-pdf-cancellation.mjs)
- [확인 대기 검사](/Users/haheebong/Documents/korean-legal-terminal/scripts/verify-case-attention.mjs)
- [Agent 진행 상태 검사](/Users/haheebong/Documents/korean-legal-terminal/scripts/verify-agent-progress.mjs)
- [변경문서 집계·되돌리기 검사](/Users/haheebong/Documents/korean-legal-terminal/scripts/verify-changed-documents.mjs)
- [Codex 파일별 변경 검사](/Users/haheebong/Documents/korean-legal-terminal/scripts/verify-codex-file-changes.mjs)
- [PDF·확인 대기 화면검사](/Users/haheebong/Documents/korean-legal-terminal/scripts/verify-terminal-workflow-ui.mjs)
- [변경문서 화면검사](/Users/haheebong/Documents/korean-legal-terminal/scripts/verify-changed-documents-ui.mjs)

프로젝트 폴더에서 재검증할 때는 타입 검사와 빌드를 먼저 수행한 후 해당 기능 검사와 화면검사를 실행한다.

```sh
npm run typecheck
npm run build
npm run verify:agent-quote
npm run verify:agent-progress
node scripts/verify-pdf-cancellation.mjs
node scripts/verify-case-attention.mjs
node --experimental-strip-types --no-warnings scripts/verify-changed-documents.mjs
node scripts/verify-codex-file-changes.mjs
node scripts/verify-terminal-workflow-ui.mjs
node scripts/verify-changed-documents-ui.mjs
```

문서의 사용자 확인 상태는 본 대화에서 받은 응답을 기준으로 기록했다. 향후 검증·개발·배포 후 해당 상태를 갱신한다.

### 과제 4 작업공간과 재검증

- 작업공간: `/Users/haheebong/.codex/worktrees/inline-selection-command/korean-legal-terminal`.
- 기준: v0.1.237, 배포 브랜치 `codex/release-v0.1.238`.
- 상태: 구현 커밋 `13e87ee`, 배포 커밋 `ff15f49`. 원래 작업 폴더의 기존 변경은 유지했다.
- [인라인 입력창](/Users/haheebong/.codex/worktrees/inline-selection-command/korean-legal-terminal/src/renderer/src/agent/InlineSelectionCommand.tsx): 입력·세션 선택·자동완성·실패 표시.
- [App.tsx](/Users/haheebong/.codex/worktrees/inline-selection-command/korean-legal-terminal/src/renderer/src/App.tsx): 선택 캡처·단축키·같은 사건 대상 연결·세션 생성.
- [AgentPanel.tsx](/Users/haheebong/.codex/worktrees/inline-selection-command/korean-legal-terminal/src/renderer/src/agent/AgentPanel.tsx): 기존 전송·대기열·지시 이력 재사용, 일반 입력창 보존.
- [MarkdownEditor.tsx](/Users/haheebong/.codex/worktrees/inline-selection-command/korean-legal-terminal/src/renderer/src/editor/MarkdownEditor.tsx), [styles.css](/Users/haheebong/.codex/worktrees/inline-selection-command/korean-legal-terminal/src/renderer/src/styles.css): 선택 위치와 입력창 배치.
- [PdfViewer.tsx](/Users/haheebong/.codex/worktrees/inline-selection-command/korean-legal-terminal/src/renderer/src/viewer/PdfViewer.tsx), [RecordViewer.tsx](/Users/haheebong/.codex/worktrees/inline-selection-command/korean-legal-terminal/src/renderer/src/viewer/RecordViewer.tsx): PDF 원문·쪽번호 연결에 필요한 선행 구현.

위 과제 4 작업공간에서 실행한다.

```sh
npm run typecheck
npm run build
node scripts/verify-inline-agent-submit.mjs
node scripts/verify-inline-selection-routing.mjs
node scripts/verify-inline-pdf-source.mjs
node scripts/verify-inline-selection-ui.mjs
```

기존 Agent 계정 전환·인증 대기열·모델 표시·사건 맥락·질문·변경문서·인용, Markdown 복사, 입력 포커스 검사도 통과했다. 기존 `verify-agent-working-input.mjs`는 이 작업공간에 `playwright-core`가 없어 실행하지 않았으며, 관련 작업 중 입력·대기열·초안 보존 동작은 새 Electron 화면검사에서 확인했다. 새로운 의존성은 추가하지 않았다.

## 9. 과제 4 배포 기록

- 사용자 배포 요청: 2026-09-25, 목업 방향 수정본.
- 기준 릴리스: v0.1.237.
- 배포 대상: [v0.1.238](https://github.com/jurisupport/legal-terminal/releases/tag/v0.1.238).
- 배포 커밋: `ff15f491581e1bcfea61bcbfa4ba2a82c42c4cec`.
- 상태: **정식 배포 완료**. 모든 빌드·자산 업로드 후 최신 정식 릴리스로 전환된 것을 확인했다.
- [GitHub 배포 실행](https://github.com/jurisupport/legal-terminal/actions/runs/36026404854).
- 사전 검증: 타입 검사·프로덕션 빌드·인라인 회귀검사, 릴리스 필수 및 Agent 회귀 12개 통과. UI 검사 67개를 통과한 renderer와 동일한 소스를 사용했다.
- 이후 macOS·Windows 배포 과정에서도 `npm run verify:inline-selection`으로 전송·대상 세션·PDF 원문 연결 회귀검사를 실행한다.
- 배포 결과: macOS Apple Silicon DMG·ZIP, Mac Intel ZIP, Windows 설치본·포터블 모두 빌드·업로드 성공. 전체 배포 작업 성공.
- 최종 확인: 자산 14개 모두 업로드 완료·크기 0 초과. `latest-mac.yml`과 `latest.yml`의 버전이 0.1.238이며 참조 파일과 크기가 실제 릴리스 자산과 일치한다.
- [배포 파일 검증 기록](/Users/haheebong/.codex/worktrees/inline-selection-command/korean-legal-terminal/output/release-v0.1.238-verification.json).
