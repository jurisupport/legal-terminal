# PC 안정화 — Android 핸드오버 우선 조치 결과

2026-09-28. `codex/release-v0.1.224`의 기존 작업트리에 우선 요청 3건을 반영했다. 기존 미커밋·미추적 변경을 보존했으며 릴리스 브랜치 병합, 버전 변경, 커밋, 공개 배포는 수행하지 않았다.

## 반영 내용

| 요청 | 변경 | 관련 파일 |
| --- | --- | --- |
| SFTP 서버 신원 확인 | 공통 `connect`의 `hostVerifier`에서 인증 전에 확인. 호스트·포트·키 종류별로 서버키를 보관하고 첫 연결은 지문을 보여 주는 네이티브 확인창을 사용한다. 기본 선택은 취소이며 거절·30초 만료·기존 키 변경은 실패한다. 만료 뒤 늦은 승인은 키를 저장하지 않는다. | `src/main/sshHostKeys.ts`, `src/main/remoteFs.ts` |
| 원본 보존 저장 | 같은 디렉터리에 독점 생성한 임시 파일로 업로드한다. 업로드 전 기준 정보, 업로드 크기, 교체 직전 원본 정보를 검사한다. 기존 파일은 POSIX rename 확장으로만 교체하며 미지원·실패 시 원본 삭제를 시도하지 않는다. 새 파일은 기존 대상을 덮어쓰지 않는 표준 SFTP rename을 사용한다. | `src/main/remoteFs.ts` |
| 권한·저장 결과 | 원본의 POSIX uid/gid/mode를 복원할 수 없으면 교체를 중단한다. 성공 기준 정보와 캐시는 완성된 임시 파일의 메타데이터를 사용하며 IPC가 원본 경로를 다시 조회하지 않는다. 기존 심볼릭 링크는 실제 대상을 저장한다. | `src/main/remoteFs.ts`, `src/main/index.ts` |
| 연결 중단 처리 | SFTP 종료 후에는 콜백이 오지 않는 요청을 추가하지 않는다. 진행 중인 요청은 채널 종료·시간 초과 시 실패하며 파일 핸들 닫기·임시 파일 정리의 대기에도 상한을 둔다. | `src/main/remoteFs.ts` |
| Agent 완료 판정 | 시작·진행·완료 및 비동기 도구 실행 이벤트가 이전 background snapshot을 갱신한다. 빈 snapshot 뒤 새 자식 작업이 있으면 부모 result로 종료하지 않는다. SSH의 비정상 코드·signal 종료는 이전 결과가 있어도 오류로 표시한다. | `src/main/agent/agent-service.ts` |

서버키는 프로필 설정과 분리한 앱 데이터의 `ssh-host-keys`에 저장한다. OpenSSH `known_hosts`와는 별도 저장소이며 처음 사용하는 기존 서버도 확인 대상이다. 키 교체를 앱에서 자동 승인하는 경로는 추가하지 않았다. API 계약은 [ssh2 공식 문서](https://github.com/mscdex/ssh2#client-methods), [SFTP 확장 문서](https://github.com/mscdex/ssh2/blob/master/SFTP.md), [Electron 확인창 문서](https://www.electronjs.org/docs/latest/api/dialog)를 확인했다.

PC Claude는 실행당 입력 하나를 전달하고 steer 시 기존 실행을 중단한 다음 큐에서 새 요청을 실행한다. Android journal 구조를 새로 도입하지 않고 이 실제 흐름을 회귀검사했다.

## 검증

- `npm run verify:remote-hardening`: 통과. 실제 로컬 ssh2 핸드셰이크에서 거절·변경·시간 초과 시 서버 인증 이벤트 **0회**, 승인 및 재접속, 신뢰 저장 범위, 늦은 승인 무효화를 확인했다.
- 같은 검사에서 업로드·크기 불일치·교체 미지원·교체 실패·충돌·원본 삭제·권한 복원 실패를 합성 재현했다. 원본 또는 다른 작성자의 변경이 보존되고, 연결이 유지될 때 임시 파일이 정리되는지 확인했다. 교체 직후 다른 작성자가 변경해도 반환 signature가 업로드 파일 기준인지 실제 IPC 함수로 확인했다.
- 실제 로컬 ssh2 서버가 WRITE 수신 중 연결을 끊도록 하여 저장이 실패로 끝나며 종료된 채널에 정리 콜백이 남지 않는지 확인했다. 리뷰에서 발견한 정리 무한 대기 문제를 이 검사로 방지한다.
- `node --experimental-strip-types --no-warnings scripts/verify-agent-progress.mjs`: 통과. SDK·SSH의 빈 snapshot→새 background 작업→부모 result 보류→자식 완료, foreground 작업의 비동기 전환, steer 1회 전달·늦은 result 무시, SDK 예외 및 SSH exit 1/SIGTERM을 검사했다.
- 기존 `verify-ssh-connection-pool.mjs`, `verify-ssh-options.mjs`, `verify-sync-unicode.mjs`, `verify-agent-mcp.mjs`, `verify-jurisupport-normalize.mjs`: 통과.
- `npm run typecheck`, `npm run build`, `git diff --check`: 통과. 별도 lint 명령은 이 저장소에 정의되어 있지 않다.

새 회귀검사는 `scripts/verify-remote-hardening.mjs`와 `package.json`의 실행 명령에 추가했다. Agent 검사는 기존 `scripts/verify-agent-progress.mjs`에 보강했다. 새 의존성은 추가하지 않았다.

## 남은 범위

- 같은 초·같은 크기의 수정 및 마지막 검사와 rename 사이의 경쟁은 SFTP 메타데이터만으로 검출할 수 없다. 강한 동시 편집 보장은 서버 revision/잠금 계약이 필요하다. rename 응답 전 연결이 끊긴 경우 성공 여부가 불명확할 수 있으므로 자동 재전송하지 않는다.
- 연결이 완전히 끊기면 서버에 `.legal-terminal-*.tmp`가 남을 수 있다. POSIX uid/gid/mode를 보존하지만 ACL·확장 속성·하드링크 관계나 서버 디스크의 전원 장애 내구성까지 보장하지 않는다.
- 추가 권고 항목인 **동일 프로필 ID의 host/user/port 변경 차단은 이번 3건과 별개로 남아 있다**. 현재 문서·draft 식별은 `ssh://profileId/path`이며 별도의 endpoint 스냅샷이 없다. 다른 프로필 ID끼리의 경로 격리와 동일 ID의 주소 변경 방지는 구별해야 한다.
- 기존 MCP 계정 전환·권한 검사는 실행했지만 REST/MCP의 모든 429·HTTP 200 제한 응답·불명확한 쓰기 응답, 재시작 복구·응답 ACK 전체 계약을 이번 작업에서 재검증한 것은 아니다.
- 실제 운영 SSH 서버·Claude CLI 버전 조합, 네이티브 확인창의 OS별 조작, Windows 입력 스트림·재시작 복구는 별도 실환경 검증이 필요하다.
