# 사건관리 구현 기록 · 2026-10-01

계획: `case-management-20260930.md`의 W00~W18. 구현·검증은 별도 작업공간에서 진행했으며 원래 작업폴더의 미커밋 변경을 보존했다. 운영 배포·운영 DB migration·실제 사건 변경은 수행하지 않았다.

## 기준선과 변경 범위

- terminal: `codex/case-management-20261001`, `v0.1.239` / `b44850a` 기반. 당시 origin/main은 이보다 오래된 0.1.198 소스였으므로 배포판을 기준으로 삼았다.
- JuriSupport: `codex/case-management-20261001`, `8c0fa82` 기반.
- 기존 reviewAt·기한 분류·완료 근거·하위업무/사건 종결 검토를 재사용했다. 새 상태 enum, 별도 할일 DB, 새 패키지는 추가하지 않았다.

## 사용자에게 달라지는 동작

1. 사건 카드에서 내 다음 할일을 선택하고 바로 작업환경으로 이동한다. 열린 할일이 없는 진행 사건도 표시한다.
2. 오늘 요약에서 마감·재확인, 오늘 선택, 직전 선택일의 미완료, 앞으로 7일, 계획 미정 업무를 구분한다. 오늘 선택은 3개를 권장하지만 더 선택할 수 있다.
3. 대기 사유와 재확인일을 함께 저장·해제하며 실제 기한은 보존한다. 재확인일이 지난 업무는 처리 전까지 남는다.
4. 밀린 사건을 하나씩 처리하고 중간에 나가도 정리 위치를 이어간다. 건너뛰기는 업무를 완료하거나 기한을 바꾸지 않는다.
5. 기일기록의 선택한 후속 조치를 열린 할일로 등록한다. 기록 자체의 저장과 후속 업무 완료를 구분한다.
6. 허용된 담당자를 조회·지정한다. 개인/비공개 업무의 대상은 본인이며 공개 범위를 몰래 확대하지 않는다.
7. 기존 Agent에서 다음 행동 하나를 제안받고 직접 수정·저장한다. 요청 전송과 후속 할일 저장은 각각 명시적인 사용자 조작이다.
8. 실제 완료 이력의 날짜가 있는 업무만 ‘오늘 완료 기록’에 표시한다. 이력 없는 항목은 전체 기록에 유지하고 날짜를 추정하지 않는다.

## 중요한 구현 경계

- 업무 사실은 JuriSupport Task에 남고, 대표 선택·오늘 선택·정리 위치만 이 PC 설정에 저장한다. 토큰 교체 시 개인 선택은 초기화된다.
- `Task.waitingFor`만 nullable 필드로 추가했다. 기한 자동 경고는 KST 날짜 기준이며 저장 시각을 실제 법정시각으로 단정하지 않는다.
- 기일은 기존 dashboard 기일 API를 MCP로 연결해 전체 페이지를 확인한다. 조회 도중 KST 날짜가 바뀌거나 일부 페이지가 실패하면 전체 성공으로 표시하지 않는다.
- 계정 전환 시작·종료를 모든 앱 창에 알리고 이전 연결의 응답·개인 설정 저장을 거절한다.
- 자동 작업환경 저장은 사건 ID를 구분한다. 같은 폴더의 다른 사건을 복원하지 않으며, 이전 저장본은 명시적 사건 ID가 일치할 때만 사용한다.
- 후속 생성의 불명확한 응답은 원문 참조로 재조회한다. 웹은 계정·원문별 미확정 시도를 보존하고, 기일기록은 해당 기록에 시도·생성 ID를 보존한다. 여러 기기의 동시 생성에 대한 서버 멱등키 보장은 추가하지 않았다.

## 구현 파일

- [사건별 계산](../src/shared/caseManagement.ts), [개인 설정](../src/main/settings.ts), [작업환경 저장](../src/main/workspace.ts).
- [앱 연결](../src/renderer/src/App.tsx), [사건 카드](../src/renderer/src/dashboard/CasesDashboard.tsx), [오늘 업무](../src/renderer/src/dashboard/TodayTodos.tsx), [하나씩 정리](../src/renderer/src/dashboard/CaseRecovery.tsx).
- [대기·담당·근거](../src/renderer/src/dashboard/TodoDetails.tsx), [기일 후속 업무](../src/renderer/src/hearing/HearingRecordPanel.tsx), [AI 제안 검토](../src/renderer/src/NextActionProposal.tsx).
- [서버 연결](../src/main/jurisupport.ts), [preload 계약](../src/preload/index.ts).

## 확인한 검사

- terminal typecheck·production build, 계산·설정·연결·계정·기일 페이지·사건별 저장·Agent 문맥 검사.
- 실제 App 합성 프로필: 기존 49개 및 새 사건관리 31개 확인. UI 기존 61개·사건관리 25개, 기일 후속 업무 22개 확인. 실제 네트워크와 사용자 프로필 접근은 차단했다.
- JuriSupport API 75개, MCP 28개, 웹 새 흐름 7개 테스트. API/MCP/web typecheck·build, 수정 영역 lint.
- 별도 임시 PostgreSQL에서 additive migration, 이전 행의 null/default 보존, 대기·충돌 rollback·담당 후보 범위 확인.
- 독립 검토에서 계정 전환·같은 폴더의 다른 사건·복원 실패·늦은 저장·웹 중복 생성 등의 결함을 발견해 보완했다.
- 화면은 일반 창과 앱 최소 창 크기에서 확인했다. Windows 실행 검증은 수행하지 않았으며 macOS 검사만으로 Windows 통과를 주장하지 않는다.

## 운영 반영 순서

1. JuriSupport의 `20261001000000_add_task_waiting_for` migration을 대상 배포 환경의 기존 절차로 적용한다. 기존 reviewAt migration을 다시 만들지 않는다.
2. API를 배포해 대기 사유·담당 후보/저장 검증·기일 pagination·완료일 읽기 응답을 반영한다.
3. MCP에 `list_upcoming_hearings`, `list_task_assignees`, 새 Task 인자를 반영한다.
4. 웹 및 terminal 배포 산출물을 준비하고 실제 연결의 읽기/저장 왕복을 확인한다. 이번 작업에서는 이 운영 배포를 실행하지 않았다.
5. 사용자가 고른 사건으로 복귀→첫 작업, 대기→재확인, 기일→후속 흐름을 점검한다. 실제 사용자 점검은 아직 하지 않았다.

구버전 서버에서는 기존 업무 조회를 유지하며 미지원 대기·담당 저장을 성공한 것처럼 표시하지 않는다. 롤백은 앱/API 버전 복귀와 새 UI 비활성화로 수행하고 새 nullable 데이터를 삭제하지 않는다.

최종 확인: 변경 파일 정리 후 위 검사 묶음을 다시 실행해 통과했다. 기존 폴더 안전성 검사의 소스 문자열 일치 조건은 실제 재사용 조건을 실행하는 사건·폴더 분리 검사로 보강했다. 패키지/lockfile 변경은 없다.
