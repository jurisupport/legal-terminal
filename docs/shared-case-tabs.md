# 모바일·PC 공통 사건탭

같은 원격 컴퓨터의 같은 SSH 사용자 계정에 연결한 기기들은 열린 사건 목록과 순서를 공유한다. 기존 `~/.claude/legal-terminal-workspaces/`의 사건별 파일을 사용하며 별도 서버나 의존성은 추가하지 않는다.

- 다른 기기에서 연 사건은 빈 사건도 열린 탭으로 나타난다. 자동 추가가 현재 선택한 사건을 바꾸지는 않는다.
- 순서는 처음 열린 시각(`workspaceOpenedAt`), 작업 폴더 경로, 등록 사건 ID 순서로 정한다. 대화나 문서를 보거나 자동 저장하는 일로 순서가 바뀌지 않는다. 닫힌 사건을 명시적으로 다시 열면 뒤에 추가된다.
- 사건을 닫아도 사건 파일과 대화 기록은 삭제하지 않는다. 다른 기기에 미저장 문서, 진행 중인 작업, 미전송 질문이나 첨부가 있으면 그 기기의 닫기를 보류한다.
- 사건 목록은 앱 시작·복귀·재연결 및 사용 중 20초 간격으로 갱신한다. PC는 사건을 선택할 때 AI 대화를 불러온다.
- 선택한 사건의 공유 AI 대화도 갱신한다. 다른 기기에서 닫은 대화는 작성·실행 중인 작업이 없으면 닫고, 명시적으로 다시 연 대화는 재전송 중에도 보호한다.
- 명시적인 열기·닫기는 기기 안에 보관하고 연결 복구 후 재전송한다. 같은 변경의 중복 전달과 오래된 자동 저장이 이미 닫힌 사건을 다시 열지 않도록 처리한다.
- 열림 상태가 없는 예전 기록은 과거 작업으로 남기며, 자동으로 열지 않는다.

공유 범위는 연결한 원격 컴퓨터의 사용자 계정이다. JuriSupport 로그인만으로 독립된 컴퓨터들의 로컬 파일을 동기화하는 기능은 아니다. 모바일에서 공유하려는 사건에는 작업 폴더가 연결되어 있어야 한다. 등록 사건은 사건 ID로 구분하므로 같은 폴더를 연결해도 섞이지 않는다. 이전 공유 파일과 사건별 파일이 함께 있으면 사건별 파일을 우선한다. 기기마다 창 크기·화면 배치·현재 선택은 유지한다. 두 앱 모두 이 변경이 포함된 버전으로 업데이트해야 한다.

## 변경 파일

- PC 저장·재전송: `src/main/workspace.ts`, `src/shared/workspaceAgentTabs.ts`
- PC 사건 목록·선택: `src/renderer/src/App.tsx`, `src/renderer/src/CaseSidebar.tsx`, `src/renderer/src/env.d.ts`
- PC 검사: `scripts/verify-shared-case-state.mjs`, `scripts/verify-shared-case-ui.mjs`, `scripts/verify-case-tab-selection.mjs`, `scripts/verify-agent-tab-handover-ui.mjs`, `scripts/verify-case-sidebar-ui.mjs`, `scripts/verify-case-attention.mjs`, `scripts/verify-agent-close-save-race.mjs`, `scripts/verify-workspace-case-scope.mjs`
- Android 저장·화면: 형제 저장소 `korean-legal-terminal-android`의 `app/src/main/java/com/jurisupport/legalterminal/mobile/MainActivity.java`, `app/src/main/assets/android-interface-sample.html`
- Android 검사: 같은 저장소의 `scripts/verify-shared-case-tabs.mjs`, `scripts/verify-shared-case-state.mjs`, `scripts/verify-shared-agent-tabs.mjs`, `scripts/verify-desktop-parity.mjs`, `scripts/verify-management.mjs`, `.github/workflows/android-ci.yml`

## 확인

PC의 주요 회귀검사:

```sh
node --experimental-strip-types --no-warnings scripts/verify-shared-case-state.mjs
node --experimental-strip-types --no-warnings scripts/verify-shared-case-ui.mjs
node --experimental-strip-types --no-warnings scripts/verify-case-tab-selection.mjs
node --experimental-strip-types --no-warnings scripts/verify-agent-tab-handover.mjs
npm run typecheck
npm run build
node scripts/verify-agent-tab-handover-ui.mjs
node scripts/verify-case-sidebar-ui.mjs
```

연결 실패·프로세스 재시작·중복 전송·프로필 별칭·한국어 경로·같은 시각의 정렬·작업 보호를 임시 저장소와 모의 연결로 검사한다. 실제 계정과 사건 자료를 사용한 원격 접속 및 앱 배포는 이 검사에 포함하지 않는다.
