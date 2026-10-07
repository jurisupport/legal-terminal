# 폰 작업 동기화·출처 표시 배포 결과

2026-10-07 요청에 따라 Android 0.1.7(12)과 PC 0.1.255를 배포했다.

## 배포 상태

- Android: 연결된 SM-F966N에 같은 서명의 Release APK를 업데이트 설치했다. 앱 데이터를 지우지 않았으며 기존 초기 설치 시각과 0.1.7/12 갱신을 확인했다.
- Google Play: 기존 내부 테스트 트랙에 0.1.7(12)을 저장 및 출시했다. 화면의 `내부 테스터에게 제공됨`을 확인했다. 지정 테스터가 없어 수신 대상은 아직 없고, 공개 프로덕션 출시는 하지 않았다.
- PC: [0.1.255 정식 릴리스](https://github.com/jurisupport/legal-terminal/releases/tag/v0.1.255)를 최신 버전으로 공개했다. Windows 설치형·포터블, Mac Apple Silicon DMG·ZIP, Intel Mac ZIP과 업데이트 정보 파일이 모두 업로드됐다.
- [PC 배포 검사](https://github.com/jurisupport/legal-terminal/actions/runs/37586016031)는 전 작업 성공이다. 릴리스 소스는 `3a73f130e67aab65eef6c581e7076e3e19d5d8c1`이다.

## 변경 내용과 주요 파일

| 영역 | 파일 | 결과 |
| --- | --- | --- |
| 폰 저장·표시 | Android `app/src/main/assets/android-interface-sample.html` | 공유 작업의 열림 상태와 작업별 생성 기기 보존, 확인된 폰 대화 표시 |
| 폰 원격 기록 | Android `app/src/main/java/com/jurisupport/legalterminal/mobile/MainActivity.java` | 공유 탭·세션 인덱스 읽기·병합·쓰기에서 출처 유지 |
| PC 목록 발견 | `src/main/workspace.ts` | 열림 상태가 빠진 기존 폰 기록도 과거 작업 목록에서 발견 |
| PC 출처 저장 | `src/main/sessions.ts`, `sessionSyncData.ts`, `caseActivityData.ts`, `workLogData.ts` | 세션·사건·폴더·작업일지에서 확인된 출처 보존 |
| PC 표시·이어열기 | `src/renderer/src/App.tsx`, `CaseSidebar.tsx/.css`, `dashboard/CasesDashboard.tsx`, `workspaceSessions.ts`, `env.d.ts`, `src/shared/workspaceAgentTabs.ts` | 열린 작업·과거 작업의 `폰` 표시, 모든 이어열기 경로와 다시 저장에서 출처 유지 |
| 인용 버튼 | `src/renderer/src/App.tsx`, `scripts/verify-html-quote.mjs` | HTML 내부 포커스 이동을 창 이탈로 잘못 처리하던 문제 수정 |

기존 세션·작업환경 구조에 선택적 생성 기기 필드를 추가했다. 새 저장소나 의존성은 추가하지 않았다. 생성 기기가 확인되지 않은 과거 작업은 추정하지 않는다. [PC 전체 변경 파일](https://github.com/jurisupport/legal-terminal/compare/v0.1.253...v0.1.255)

## 검증

- Android: scaffold/화면 동작/공유 동기화 검사 19개, Java 테스트 26개, Release APK·AAB 빌드, lint 오류 0개. 기존 앱과 서명 일치 및 빌드 결과의 화면 소스 일치 확인.
- PC: 타입 검사·빌드, 메타데이터 병합, 서버 교환, 작업환경 왕복, 모든 과거 작업·대시보드 이어열기 경로, 사이드바와 복원 UI 검사.
- 배포 서버: Windows 설치 후 실행 검사, Mac 두 아키텍처의 기능·프로젝트·작업 복원·HTML 인용·미디어 검사 및 패키징 모두 통과.
- 최초 0.1.254 후보의 Mac 인용 검사 실패를 추적해 iframe 포커스 이동 시 드래그 상태가 취소되는 기존 결함을 재현했다. 드래그 8단계 동안 버튼을 숨기는 검사와 iframe 포커스 이탈 검사를 추가하고 0.1.255에서 모두 통과했다. 검사 조건을 완화하지 않았다.

## 적용 범위

- 현재 설치된 PC 앱은 자동 교체하거나 재시작하지 않았다. 새 PC 설치본으로 업데이트해야 PC의 표시·조회 수정이 적용된다.
- 과거 폰 기록의 열림 상태는 폰에서 다시 저장할 때 갱신된다. 새 PC는 이전 형식도 조회한다.
- 과거 기록에 생성 기기가 없으면 `폰` 표시는 붙지 않는다. 새 작업부터 확인 가능한 출처를 남긴다.
- 사용자 실제 사건에 대한 유료 AI 호출은 검증에 사용하지 않았다.

Android 산출물·소스 스냅샷·해시·설치 및 Play 검증 기록은 `/Users/haheebong/Documents/korean-legal-terminal-android/output/mobile-origin-0.1.7-12/`에 있다. PC 배포 API 검증 기록은 배포 작업폴더의 `.omx/releases/v0.1.255-verification.json`에 있다. 기존 개발 작업폴더의 다른 변경을 보존했고, 출처·HTML 수정도 해당 작업폴더에 반영하고 검증했다.
