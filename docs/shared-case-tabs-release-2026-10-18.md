# 사건탭 동기화 배포 — 2026-10-18

## 배포 상태

- PC 0.1.282: [배포 검사](https://github.com/jurisupport/legal-terminal/actions/runs/39091929818) 전 작업 성공 후 정식 최신 릴리스로 공개했다. Windows 설치형·포터블, Mac Apple Silicon DMG·ZIP, Intel Mac ZIP과 업데이트 정보 등 14개 자산이 게시되었다. 설치 파일 5개 다운로드 주소의 HTTP 200 및 크기, 두 업데이트 정보의 버전·파일 크기를 확인했다.
- Android 0.1.12 / 코드 17: 기존 [Google Play 내부 테스트](https://play.google.com/console/u/1/developers/5138121144862713057/app/4973092082272583457/tracks/4700885553305315748?tab=releases)에 출시했다. 화면에서 최신 출시 버전 0.1.12 (17), 내부 테스터에게 제공됨, 게시일 10월 18일 오후 12:12를 확인했다. 이전 코드 16은 이번 출시에서 제외했다. 테스터가 지정되지 않아 Play 자동 배포 수신 대상은 없으며 공개 프로덕션 출시는 하지 않았다.
- 배포 직후에는 기기에 설치하지 않았으나, 후속 설치 요청으로 아래 두 기기를 업데이트하고 실행을 확인했다.

## PC 배포 정본

최신 v0.1.279에 이번 변경만 통합했다. 기존 개발 작업폴더의 다른 미커밋 변경은 보존했다.

- 배포 작업폴더: `/Users/haheebong/.codex/worktrees/shared-case-tabs-release/korean-legal-terminal`
- 브랜치: `codex/release-v0.1.282`
- 커밋: `57ff6e78d3f54776ba2d076dd64b02eb507e6a68`
- [릴리스](https://github.com/jurisupport/legal-terminal/releases/tag/v0.1.282)
- 로컬 검증 기록: 배포 작업폴더의 `.omx/releases/v0.1.282/`

공유 사건의 자동 복원·순서·닫힘 보호·재시작 후 재전송을 추가했다. 최신 릴리스의 관찰 순서, 늦게 끝나는 저장과 닫기의 경쟁상태, Windows 원자적 저장 보호도 유지했다. 같은 작업 폴더에 연결된 등록 사건은 사건 ID로 분리하고 이전 기록은 소유권을 확인해 읽는다. 정렬은 열린 시각, NFC 경로, 사건 ID 순서다.

첫 후보 0.1.280에서는 Intel Mac의 UI 검사가 최근 사건 행이 나타난 직후 공유 목록 로딩 완료 전에 상태를 검사해 실패했다. 실패 당시 후속 화면에는 이미 열린 사건이 표시되어 있었다. 초기 조회를 의도적으로 지연한 재현 검사를 추가하고 공유 열림 상태까지 기다리도록 고쳤다. 기존 assertion은 유지했으며, 새 대기를 제거한 비교 실행은 같은 실패를 재현했다. 0.1.281에서 변경한 것은 검사와 버전 파일뿐이다. 0.1.280 태그는 이동하지 않았고 정식 최신 버전으로 공개하지 않았다.

0.1.281 후보에서는 빠른 사건 전환 도중 오래된 조회를 버리고 다시 조회하지 않는 경합을 추가로 재현했다. 0.1.282는 현재 계정·서버·활성 상태가 유지되는 경우 재조회를 한 번 예약한다. Windows 문서 인용 검사의 패널 닫힘 후 초점 이동도 지연 재현으로 확인해, 초점 이동이 끝난 뒤 네이티브 드래그를 수행하도록 했다. 좌표·타임아웃·기존 검사는 유지했고 선택 문장은 전체 일치로 강화했다. 두 실패는 수정 전 재현, 수정 후 통과했다. 0.1.281도 정식 최신 버전으로 공개하지 않았다.

PC 로컬 타입 검사·빌드, 신규 공유 상태/UI, 사건 선택, 작업환경 왕복·사건 구분, 닫기·관찰 경쟁상태, 저장 무결성, Electron UI, 기존 desktop/release-current/release-additions 묶음이 통과했다. 배포 CI에서 Windows 실제 설치·실행 검사와 두 Mac 환경 검사가 모두 통과했다. 최신 릴리스 API도 0.1.282를 가리킨다.

## Android 산출물과 검증

산출물 폴더: `/Users/haheebong/Documents/korean-legal-terminal-android/output/shared-case-tabs-0.1.12-17/`

- `legal-terminal-0.1.12-17.aab`: Play 업로드용
- `legal-terminal-0.1.12-17-release.apk`: 직접 설치용
- `verification.json`, `SHA256SUMS`, `validation/`: 검증·해시 기록
- `source-snapshot.tar.gz`, `source-sha256.json`: 민감한 설정을 제외한 최종 소스
- `baseline-change-report.md`, `release-notes-ko.txt`: 포함 범위와 출시 노트

화면 검증 31개, Java 단위 테스트 58개, scaffold 및 Release 빌드가 통과했다. lint 오류 0개, 기존 경고 56개다. APK/AAB 인증서는 기존 0.1.11 업로드 인증서와 같고 패키지·버전·debuggable=false 및 AAB 구조를 확인했다. 배포 파일의 웹 자산과 최종 소스가 일치하며, DEX에 사건 구분·공유·재전송 코드가 포함되어 있다.

현재 검증된 개발본의 기존 Claude 로그인 주소 호환·백그라운드 작업·대기 입력 복구 보완도 보존했다. 이 변경들은 별도 범위 보고서와 출시 노트에 명시했다. 새 의존성은 추가하지 않았다.

실제 사용자 사건을 이용한 유료 AI 호출과 두 기기의 실제 원격 동시 연결 검증은 하지 않았다. Google Play 공개 프로덕션 출시가 아닌 기존 내부 테스트 경로를 사용한다.

## 주요 변경 파일

- PC: `src/main/workspace.ts`, `src/shared/workspaceAgentTabs.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/CaseSidebar.tsx`, `src/renderer/src/env.d.ts`, `package.json`, `package-lock.json`, `.github/workflows/release.yml` 및 공유·닫힘·문서 선택 회귀검사.
- Android: `app/build.gradle.kts`, `check_android_scaffold.py`, `app/src/main/assets/android-interface-sample.html`, `app/src/main/java/com/jurisupport/legalterminal/mobile/MainActivity.java`, 공유 관련 검증 스크립트와 `.github/workflows/android-ci.yml`.
- 기존 공유 저장소·서명·배포 경로를 재사용했고 새 서버나 의존성은 추가하지 않았다.

## 후속 설치 결과

- Samsung SM-F966N: 0.1.11(16) → 0.1.12(17). 기존 앱 삭제 없이 업데이트 설치 Success, 실행 Status: ok를 확인했다. 최초 설치 시각·앱 데이터 경로·ceDataInode가 동일하다.
- Mac Apple Silicon: `/Applications/legal-terminal.app`의 0.1.272 → 0.1.282. GitHub 배포 ZIP의 SHA256과 복사된 app.asar를 확인했고, 실행 후 앱 정보에서 0.1.282를 확인했다. 기존 배포와 동일한 서명 정책이며 재서명이나 격리 속성 변경은 하지 않았다.
- 열린 작업환경을 저장한 뒤 설정·작업 기록 전체를 APFS 복제로 백업했다. 구버전이 정상 종료 요청과 TERM에도 남아 있어 백업 후 해당 앱 프로세스를 강제 종료하고 교체했다. 새 앱은 정상 실행됐다.
- Mac 이전 앱과 데이터 백업: `/Users/haheebong/Library/Application Support/legal-terminal-update-backups/20261018-124801`.
- 실제 사용자 사건을 열고 닫는 기기간 동기화 실사용 시험은 수행하지 않았다.


## Android 0.1.13 (18): 빈 상태 파일로 인한 동기화 재시도 수정

사용자 휴대폰 로그에서 `NativeBridge.listSharedWorkspaces`의 `org.json.JSONException: End of input at character 0`를 확인했다. 기존 연결 정보로 원격 폴더를 읽기 전용 점검한 결과, 공유 파일 159개 중 정상 JSON 158개와 0바이트 파일 1개였다. 문제 파일은 다른 정상 기록의 사건별/이전 경로별 키와 일치하지 않았다. 서버 파일은 수정·삭제하지 않았다.

변경 파일(Android 저장소):
- `app/src/main/java/com/jurisupport/legalterminal/mobile/MainActivity.java`: 개별 JSON 오류만 건너뛰고 통신 오류는 전달한다. 손상된 사건별 파일을 이전 경로별 상태로 대체하지 않고 불완전한 목록 여부를 반환한다.
- `app/src/main/assets/android-interface-sample.html`: 불완전한 목록에서는 정상 사건을 계속 적용하되, 누락을 근거로 한 자동 이관을 보류한다.
- `scripts/verify-shared-case-state.mjs`, `scripts/verify-shared-case-tabs.mjs`: 빈 파일·깨진 JSON·통신 실패·사건별 파일 우선순위·연속 조회·자동 이관 회귀 검증을 추가했다.
- `app/build.gradle.kts`, `check_android_scaffold.py`: 0.1.13 / 코드 18.

새 의존성이나 복구 저장소는 추가하지 않고 기존 목록 조회와 이관 조건만 보완했다. 변경 전 파일, 이번 수정만의 diff, 소스 스냅샷, 서명된 APK/AAB와 SHA256, 검증 결과는 `/Users/haheebong/Documents/korean-legal-terminal-android/output/shared-case-sync-repair-0.1.13-18/`에 있다.

검증: 수정 전 빈 파일 테스트가 동일 파싱 오류로 실패했고 수정 후 통과했다. CI의 동작 검사 31개와 scaffold 1개 모두 통과, 단위 테스트 58개 통과, release lint 오류 0개/기존 경고 56개, APK/AAB 빌드·서명 확인 완료. 설치된 0.1.12와 동일한 서명 키, 최종 패키지의 수정 코드 및 화면 자산 일치 확인. 독립 검토에서 이번 오류와 손상된 사건별 파일/자동 이관 고착 경로 PASS.

제한: 빈 파일 자체의 내용은 복원하지 않았다. 손상 파일이 있는 동안 기존 로컬 탭의 자동 이관은 보류되며 정상 공유 사건의 조회·동기화는 계속된다. 원래부터 실패하던 명시적 저장 요청은 오류로 유지한다. 휴대폰 USB가 진단 후 끊겨 수정 버전 설치와 실기기 수정 후 검증은 재연결 대기 중이다.

Play 내부 테스트 0.1.13 (18) 게시 완료: 10월 18일 오후 1:34, release 7. 기존 테스터 미지정 경고는 유지되므로 Play 자동 업데이트를 사용할 수 있다고 주장하지 않는다. 공개 프로덕션 배포는 하지 않았다.

### 휴대폰 0.1.13 설치 및 실행 확인

USB 재연결 후 SM-F966N에 0.1.12(17) → 0.1.13(18) 업데이트 설치 완료. APK SHA256이 검증 산출물과 일치하며 설치 결과 `Success`, 앱 시작 `Status: ok`를 확인했다. firstInstallTime·dataDir·ceDataInode가 동일해 기존 앱 데이터 저장소가 유지됐다.

새 앱 프로세스에서 실제 공유 목록 조회 3회(6,369 / 6,283 / 6,809ms)를 확인했다. 매회 같은 빈 파일 1개를 안전하게 건너뛰었으며 `bridge request failed`, `JSONException`, 프로세스 치명 오류는 모두 0건이었다. 서버 빈 파일은 삭제하지 않았다. 화면상 재시도 문구 및 PC와 휴대폰의 탭 목록 일치 여부는 별도로 직접 확인하지 않았으므로 UI 종단 검증 완료로 주장하지 않는다.

상세 근거: Android 저장소 `output/shared-case-sync-repair-0.1.13-18/validation/device-install-before.json`, `device-install-after.json`, `device-launch.txt`, `device-sync-after.json`, `device-sync-after.txt`.


## Android 0.1.14 (19) 및 닫힌 사건 재등장 복구

확인된 별도 원인과 처리:
- 원격 서버의 구형 Android 미등록 폴더 공유 기록 3개가 `workspaceOpen:true`로 남아 있었다. 같은 폴더의 등록 사건은 더 최근 `false`였으며, 현재 데이터 분리 원칙상 서로 다른 작업으로 조회됐다. 정확한 3개 파일만 기존 `.json.lock` 잠금을 잡고 백업한 뒤 `workspaceOpen`과 `savedAt`만 갱신했다. 등록 사건·문서·대화 내용은 바꾸지 않았다. 원격 백업: `~/.claude/legal-terminal-workspace-repair-backups/closed-legacy-20261018T105440Z/`.
- Mac 통합 테스트가 실제 공유 홈에 남긴 검사용 열린 기록 8개도 원본 백업 후 닫힘으로 갱신했다. 로컬 백업: `~/.claude/legal-terminal-workspace-repair-backups/test-fixture-close-20261018T105924Z/`. 앱을 실제 전면 활성화한 뒤 AX 상태에서 검사용 열린 사건 행이 0개가 됐고 공유 오류 표시도 없었다. 0.1.282는 포커스가 있을 때 20초 간격으로 재조회한다.
- PC 소스 작업트리의 `scripts/verify-media-ui.mjs`, `scripts/verify-hearing-tab.mjs`는 기존 격리 패턴으로 `os.homedir()`를 임시 홈에 연결했다. 제품 코드와 전체 HOME은 바꾸지 않았다. 미디어 검사 9개·기일 검사 20개 통과, 실제 공유 파일 39개의 개수와 mtime 해시가 검사 전후 동일했다.

휴대폰 수정:
- `android-interface-sample.html`: 현재 입력창의 오래된 캐시를 미전송 초안으로 다시 판단하지 않도록 수정했다. 대기 질문 삭제 등으로 메시지 배열 위치가 바뀌어도 jobId로 해당 답변을 계속 조회하며, 저장 완료 후 확인 요청 실패는 재시도한다. 미저장 문서·대기 질문·완료 확인 등 실제 닫기 보류 이유를 표시한다.
- `MainActivity.java`: 신뢰하는 앱 화면의 제한된 동기화 진단만 기기 로그에 전달한다. 사건명이나 문서 내용은 포함하지 않는다.
- 복구·공유 사건·스크롤 검증 및 scaffold/version 파일을 갱신했다. 검사 32개, 단위 테스트 58개 통과, release lint 오류 0/기존 경고 56. 새 의존성 없음.

0.1.14(19) 설치 성공과 기존 앱 데이터 저장소 유지 확인. 배포 전 최종 빌드에 진단 로그를 보완하여 동일 버전을 재설치했으며, 처음 설치한 빌드는 산출물의 `initial-installed-build/`에 보존했다. 최종 APK SHA256은 `86684fee6e4ce1ebd30cb6e0bde81adc15450f50c93c91c7c3ea903df7bfaa79`.

실기기 조회는 정상이나 마지막 진단은 열린 사건 2개, 닫기 보류 1개, 이유 `미저장 문서`다. 사용자는 작업을 마쳤다고 답했다. 실제 수정인지 읽기 화면 재직렬화로 생긴 오탐인지 추가 확인 중이며, 내용 삭제나 강제 닫기는 하지 않았다. 0.1.14 Play 배포는 아직 진행하지 않았다.

산출물: `/Users/haheebong/Documents/korean-legal-terminal-android/output/shared-case-close-repair-0.1.14-19/`.

### 0.1.14 최종 수정 및 실제 화면 검증 완료

추가 재현: 문서의 제목 공백/목록 탭/NBSP가 rich editor에서 재직렬화되면서 입력 없이 dirty로 바뀔 수 있었다. 실제 DOM이 마지막 반영 상태에서 바뀐 경우에만 동기화하도록 수정했다. 읽기·반복 조회·IME 취소·실제 한글 입력·최종 문자·체크박스·원본/서식 전환 회귀가 통과했다.

구형 Markdown 스냅샷의 형식 변형만 한정 복구한다. 비공백 본문 동일성, 실제 렌더러의 결과와의 정확한 일치, 별도 초안의 내용·기준 본문·원격 stat 일치를 확인한다. 기존 문서 히스토리에 정확한 이전 내용을 저장하고 확인한 후에만 복구하며, 진짜 수정·다른 최신 초안·충돌·저장 공간 오류는 보호한다. 새 스냅샷에는 버전 표시가 있어 실제 서식 편집에 재적용하지 않는다. 독립 검토 지적을 반영하고 전체 32개 검사 및 58개 단위 테스트, lint, 서명 빌드를 다시 통과했다.

최종 APK SHA256: `cea22ac2f3d847c5dbd48c16615bd4a592f80191a516e40a6ae8f485fcb08e0d`. 실제 휴대폰에 설치된 APK의 해시가 이 값과 동일함을 검증했다. 앱 저장소 identity가 유지됐다.

마지막 보류는 Markdown 형식 오탐이 아니라 일반 작업에 오래 남은 통화 텍스트의 깨진 원문 미리보기였다. 이미 설치된 scrcpy를 임시 앱 래퍼로 표시하여 CUA 키보드 조작으로 실제 휴대폰 화면을 확인했다. 기존 앱의 '저장 안 한 수정본' 히스토리 보관 경로로 임시 내용을 남기고 문서 탭을 닫았다. 서버 원본 파일의 SHA256·크기·mtime은 처리 전후 완전히 같다. 따라서 이 항목을 새 코드가 자동 복구했다고 주장하지 않는다.

휴대폰 사건탭 전체를 닫고 실제 화면에서 보류 표시가 사라진 것을 확인했다. 이후 자동 목록 조회 3회 이상 동안 `open:0,deferred:0,reasons:[]`, 새 bridge 오류 0, 치명 오류 0이었다. Mac도 남아 있던 빈 로컬 일반 질문 작업을 정상 '사건 닫기' 메뉴로 닫아 실제 AX상 열린 사건 0, 테스트 사건 0, 공유 경고 없음이 됐다. 자료 파일은 삭제하지 않았다.

Play 내부 테스트 0.1.14(19), release 8 게시 완료(10월 18일 오후 8:32). 테스터 미지정 경고는 기존 그대로이며 공개 프로덕션 배포는 아니다. PC 실행 파일은 0.1.282를 유지했고 변경은 검사 스크립트 두 개 및 잘못 남은 상태의 보존 복구다. Windows UI를 직접 조작한 검증은 하지 않았다.


## PC 0.1.285: 프로젝트 폴더 선택 중 사건 화면으로 이동하는 문제 수정

프로젝트 작성·폴더 선택 중 다른 기기의 사건 닫힘과 늦게 도착한 작업환경 복원이 현재 화면을 사건 화면으로 바꾸는 두 경로를 재현했다. 프로젝트·할일 화면에서는 원격 닫힘이 화면을 이동시키지 않으며, 백그라운드 복원은 대화를 선택하지 않는다. 비동기 읽기가 끝나는 시점의 현재 화면·사건을 확인한다. 사용자가 직접 사건을 열어 기존 복원 요청에 합류한 경우에는 명시적 선택을 반영한다. 일반 사건 화면에서 닫힌 탭의 옆 사건을 여는 기존 동작은 유지한다.

변경 파일:
- `src/renderer/src/App.tsx`: 화면 유지 조건과 진행 중 복원 요청의 명시적 활성화 여부.
- `scripts/verify-agent-tab-handover.mjs`, `scripts/verify-case-tab-selection.mjs`, `scripts/verify-project-ui.mjs`: 지연 복원·명시적 열기 합류·프로젝트/할일 화면의 원격 닫힘·로컬/원격 폴더 선택 회귀검사.
- `scripts/verify-media-ui.mjs`, `scripts/verify-hearing-tab.mjs`: 앞서 검증한 임시 홈 격리 수정 포함.
- `package.json`, `package-lock.json`: 0.1.285 및 배포 검사 연결.

기존 화면 전환·복원 함수에 필요한 조건만 추가했고 새 저장소·서버·의존성은 추가하지 않았다. 소스는 별도 작업트리의 `codex/fix-project-folder-focus` 브랜치이며 최종 커밋은 `f2678e18d568ec461f316f137512cd8c6c9cf16f`다. 기존 사용자 작업트리의 미커밋 변경은 보존했다.

검증: 수정 전 자동 복원 검사와 실제 렌더러의 로컬 닫힘/원격 복원에서 프로젝트 폼이 사라지는 것을 확인했다. 수정 후 타입 검사·빌드, 공유 사건·사건 관리·탭 선택·복원 합류·기일/분리 인용 회귀, 네 가지 로컬/원격 폴더 시나리오와 두 가지 Windows 폴더 경로 시나리오, 기존 프로젝트 동작 검사가 통과했다. 별도 코드 검토도 통과했다. Windows, Apple Silicon Mac, Intel Mac의 배포 필수 검사가 모두 통과했으며 Windows 설치본 설치·실행 검사도 성공했다.

실제 Mac의 0.1.284에서 새 프로젝트 테스트 폼에 이름·목표를 입력하고 네이티브 폴더 선택기로 `/private/tmp`를 연결했다. 백그라운드 갱신 후에도 입력과 폴더가 유지됐다. 테스트 폼은 저장하지 않고 취소했으며 실제 프로젝트에 남지 않았다. 최종 0.1.285의 제품 소스는 이 실기기 검사 버전과 동일하고 테스트 경로 모델·버전만 바뀌었다.

정식 배포: [v0.1.285](https://github.com/jurisupport/legal-terminal/releases/tag/v0.1.285), [전체 배포 검사 성공](https://github.com/jurisupport/legal-terminal/actions/runs/39187276809). 최신 릴리스·prerelease=false·자산 14개 게시 완료를 확인했다. Windows/Mac 업데이트 정보 파일의 0.1.285와 SHA256 일치도 확인했다. 앞선 0.1.283/0.1.284 후보는 실패한 사전 릴리스로 남겨 원인을 보존했으며 검사를 건너뛰지 않았다.

이 Mac의 `/Applications/legal-terminal.app`에 최종 0.1.285를 설치하고 앱 정보 화면에서 버전을 확인했다. 두 창의 작업환경을 저장하고 기존 데이터 전체·이전 앱을 백업했다. 앱 교체 시 설정·사건·프로젝트 파일 해시는 동일했다. 백업: `/Users/haheebong/Library/Application Support/legal-terminal-update-backups/20261019-105633-v0.1.285`. 설치본은 같은 커밋에서 로컬로 빌드했으며 CI 배포 ZIP과는 별도 산출물이다.

검증 기록: `/Users/haheebong/.codex/worktrees/shared-case-tabs-release/korean-legal-terminal/.omx/releases/v0.1.285/verification.json`. 한계: 사용자의 별도 Windows PC에는 직접 접속·설치하지 않았으며 Windows 실사용 화면을 직접 조작하지 않았다. 해당 PC는 0.1.285 업데이트가 필요하다.


## PC 0.1.286: 프로젝트 작업폴더를 지정하면 기존 사건처럼 바뀌는 문제 수정

사용자가 최종 확인한 재현 순서는 프로젝트 생성 후 작성서류/작업폴더 지정이다. 기존 공용 폴더 변경 함수가 프로젝트 이름과 경로를 선택한 사건 폴더명·경로로 바꾸고 사건 방문 기록에 추가했다. 폴더만 기준으로 저장·복원하던 상태도 기존 사건 대화를 불러올 수 있었다. 단순 참고 폴더 추가와는 다른 경로임을 구분해 수정했다.

선택한 폴더를 실제 작업폴더로 저장하되 프로젝트 이름·ID·기존 대화와 재개 ID를 유지한다. 프로젝트별 대화 저장소를 사건과 분리하고, 이전 저장 내용은 검증 후 복원하거나 보존 백업한다. 실행 중인 AI 작업·대기 지시가 있거나 다른 컴퓨터의 폴더인 경우에는 변경을 거절한다. 폴더 선택 자체는 AI 요청이나 종료 요약을 실행하지 않는다. 여러 창의 작업 경로는 함께 갱신하면서 각 창의 선택 화면을 유지한다. 변경 응답이 늦게 도착해도 이미 닫은 프로젝트를 다시 열거나 다른 사건을 변경하지 않는다.

주요 변경 파일:
- `src/renderer/src/App.tsx`, `src/renderer/src/dashboard/ProjectsDashboard.tsx`: 프로젝트 정보 유지, 작업폴더 변경 적용, 창 사이 반영, 지연 응답·복원 방어, 설정 편집 시 선택 경로 보존.
- `src/shared/project.ts`, `src/main/projectStore.ts`, `src/main/projectAgent.ts`: 작업폴더 영구 저장과 실제 로컬/SSH 경로 검증.
- `src/main/agent/agent-service.ts`, `src/main/index.ts`: 저장·실행 위치 변경 중 잠금과 동일 대화의 실행 경로 갱신.
- `src/main/workspace.ts`, `src/preload/index.ts`, `src/renderer/src/env.d.ts`: 프로젝트별 저장 키·목록·잠금·재시도·복원 범위.
- 프로젝트 저장소/런타임/UI, 작업환경 범위/복원, Claude 인증/모델 표시 검증 스크립트 8개 및 `package.json`, `package-lock.json`.

기존 저장소·검증·실행 연결을 재사용했고 새 의존성을 추가하지 않았다. 이름만 유지하는 우회 대신 실제 작업폴더 지정까지 지원한다. 최종 커밋: `cae27266b04505c3ce1f2c3651d46d6f490a1d9f`, 브랜치 `codex/fix-project-folder-identity`.

검증: 이전 버전에서 이름/경로 변경, 다른 사건 상태 복원, 프로젝트 저장 키 충돌, 작업폴더 저장 누락을 재현했다. 수정 후 로컬·SSH 폴더 지정/재시작/닫혔던 대상 폴더 재열기, 동일 폴더의 기존 사건 보존, 두 실제 Electron 창의 경로·포커스 유지, 지연 응답 후 닫힌 프로젝트 재등장 방지가 통과했다. 작업환경 범위·병합·동시 관찰·쓰기 무결성, AI 실행 변경 잠금, 전체 release-additions/release-current, 타입 검사·빌드도 통과했다. 별도 검토의 다중 창·닫힘 경쟁 지적을 수정하고 재검토 승인을 받았다. 한 차례 기존 파일 잠금 경쟁 검사가 실패했지만 검사 변경 없는 재실행에서 통과했으며 실패 로그도 보존했다.

[0.1.286 정식 배포](https://github.com/jurisupport/legal-terminal/releases/tag/v0.1.286), [전체 배포 검사](https://github.com/jurisupport/legal-terminal/actions/runs/39190266850)가 성공했다. Windows 설치본 설치·실행, Apple Silicon/Intel Mac 패키징을 포함해 필수 작업이 모두 성공했다. 최신 정식 릴리스와 자산 14개, Windows/Mac 업데이트 정보 파일의 버전·SHA256을 확인했다.

현재 Mac에 0.1.285 → 0.1.286 업데이트 설치 후 앱 정보 화면의 버전을 확인했다. 열린 두 창의 작업환경을 저장했고 앱·데이터 전체를 백업했다. 교체 전후 설정·사건·프로젝트 파일 해시가 동일하다. 백업: `/Users/haheebong/Library/Application Support/legal-terminal-update-backups/20261019-113225-v0.1.286`. 설치본은 배포 커밋의 로컬 빌드이며 CI ZIP과는 별도 산출물이다. 선택 원본 폴더를 이 과정에서 수정하거나 삭제하지 않았다.

연결된 원격 Mac의 Claude Code 2.1.299를 읽기 전용으로 확인했다. 실제 유료 AI 요청은 보내지 않았고, 사용자의 별도 Windows PC를 직접 조작하거나 설치하지는 않았다. 다른 PC는 0.1.286 업데이트 후 프로젝트를 다시 열어 작업폴더를 지정하면 된다. 상세 증거: `/Users/haheebong/.codex/worktrees/shared-case-tabs-release/korean-legal-terminal/.omx/releases/v0.1.286/verification.json`.
