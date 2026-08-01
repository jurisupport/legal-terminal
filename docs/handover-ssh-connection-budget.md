# SSH 연결 예산·다중화 핸드오버

## 목적

앱이 서버의 SSH 접속 슬롯을 고갈시켜 **사용자가 같은 서버에 터미널로 들어가지 못하게 되는** 장애가 반복되고 있다. 1차 원인(ssh2 풀 누수)은 v0.1.173에서 해결됐으나 증상이 재발했고, 2차 조사에서 **원인이 달랐다.** 이 문서는 2차 장애 데이터와 v0.1.174(`bc6468c`) 코드 리딩을 근거로, 남은 구조적 문제와 후속 작업 범위를 전달한다.

선행 문서: [`handover-ssh-connection-leak.md`](./handover-ssh-connection-leak.md) — 1차 장애(ssh2 풀 누수). **해결 완료**, 배경 파악용으로만 읽으면 된다.

## 1차와 2차는 원인이 다르다

| | 1차 (2026-07-28) | 2차 (2026-08-01) |
| --- | --- | --- |
| 증상 | `kex_exchange_identification: Connection closed` | 동일 |
| 클라이언트 열린 연결 | **41개** (전부 앱 PID) | **0개** (5초간 반복 샘플링) |
| 재시도 성공률 | 일부 성공 | **10회 전부 실패** |
| 앱 상태 | legal-terminal 5일 연속 실행 | 실행 중이나 연결 0 |
| 원인 | 앱의 ssh2 연결 누수 | **앱 아님 — 서버측** |
| 조치 | 앱 종료로 즉시 복구 | 원격 복구 **불가** |

증상이 같아서 1차와 같은 원인으로 오인하기 쉽다. 실제로 2차는 앱과 무관했다.

### 2차 장애 관측 데이터

| 확인 항목 | 관측값 |
| --- | --- |
| TCP 680 도달 | 성공 |
| SSH 배너 수신 | 10회 시도 전부 실패 |
| 종료 지점 | `Connection closed` / `Connection reset by peer` 혼재 |
| `lsof -nP -i TCP@182.225.243.14` | 0개 (10회 반복 샘플링 전부 0) |
| 다른 포트 (22 / 44 / 5900 / 443 / 80) | 전부 closed — **우회 경로 없음** |
| 설치 앱 버전 | v0.1.174 (1차 수정 `504107a` 포함) |

**판정 근거:** `MaxStartups` 기본값은 `10:30:100`이다. 이 한도에 걸린 상태라면 재시도 중 확률적으로 일부가 성공해야 한다. 10회 전부 실패 + 클라이언트 연결 0개는 이 패턴과 맞지 않는다.

macOS의 `sshd`는 launchd 소켓 활성화 방식이다. **launchd가 TCP를 accept한 뒤 `sshd` 프로세스 스폰에 실패하면 정확히 이 증상**(연결은 되는데 배너 없이 즉시 끊김, 100% 실패)이 나온다. 서버측 자원 고갈(디스크·메모리·프로세스 슬롯) 또는 `sshd` 비정상을 의심해야 한다.

> 이 판정은 클라이언트측 관측만으로 도출했다. **서버에 접근 가능해지면 `/var/log/system.log`의 sshd 항목과 `df -h`, `sysctl kern.num_tasks`로 확인하는 것이 첫 작업이다.**

## 현재 구조

SSH를 여는 서브시스템이 **5개이고, 서로를 모른다.**

| 서브시스템 | 파일 | 연결 지점 | 성격 | 상한 |
| --- | --- | --- | --- | --- |
| SFTP 원격 파일 | `src/main/remoteFs.ts` | ssh2 라이브러리 | 장기 유지 | **4** (1차 수정으로 도입) |
| 폴더 탐색·검색 | `src/main/ssh.ts` | 4곳 | 일회성 | 없음 |
| rclone 동기화 | `src/main/sync.ts` | 2곳 | 일회성 + 장기 | 없음 |
| 세션·기록 조회 | `src/main/sessions.ts` | 5곳 | 일회성 | 없음 |
| 에이전트 실행 | `src/main/agent/agent-service.ts` | 8곳 | 일회성 + 장기 | 없음 |
| 터미널 탭 | `src/main/pty/claude-pty.ts` | 1곳 | 장기 유지 | 탭 수만큼 |

CLI 기반 연결 지점만 **20곳**이고, `ssh` 인자를 만드는 함수가 **4벌로 중복 정의**돼 있다 (`ssh.ts:270`, `sync.ts:41`, `sessions.ts:425`, `agent-service.ts:226`, `claude-pty.ts:83`). 정책을 한 곳에서 바꿀 수 없는 상태다.

## 남은 문제

### P0-1. SSH 연결 다중화(ControlMaster)를 전혀 쓰지 않는다

전 저장소에서 `ControlMaster` / `ControlPath` / `ControlPersist` 사용처가 **0건**이다.

결과: 폴더 목록 한 번, 검색 한 번, 세션 조회 한 번, 에이전트 인증 확인 한 번이 **각각 별개의 TCP 연결 + 별개의 sshd 프로세스 + 별개의 인증 왕복**을 만든다. 사용자가 폴더 트리를 훑는 동안 수십 개의 연결이 순차적으로 생겼다 사라진다. 각 연결은 짧지만, `sshd`의 `MaxStartups`는 **인증 완료 전(pre-auth) 동시 연결 수**를 세므로 짧고 잦은 연결이 특히 불리하다.

`ControlMaster`를 켜면 이 20개 지점이 **하나의 TCP 연결 위 채널로 합쳐진다.** 서버 슬롯 소비가 1/N로 줄고, 인증 왕복이 사라져 체감 속도도 개선된다. 투입 대비 효과가 가장 큰 항목이다.

### P0-2. 서버가 무방비다

`sshd_config`가 기본값이면 `MaxStartups 10:30:100`, `ClientAliveInterval 0`이다. 후자가 특히 문제다. **노트북이 네트워크를 바꾸거나 절전에 들어가면 서버는 죽은 세션을 인지하지 못하고 슬롯을 계속 점유한다.** 2차 장애 당시 클라이언트 IP가 바뀐 정황(모바일 테더링, IPv6)이 있었다.

1차 핸드오버는 서버 보강을 "완충재이므로 앱 수정을 대체하지 않는다"고 낮게 봤다. **2차 장애는 앱과 무관했으므로 이 평가를 상향해야 한다.** 앱이 완벽해도 서버가 기본값이면 같은 증상이 재발한다.

### P0-3. 장애 시 복구 경로가 없다

2차 장애에서 **원격으로 손댈 방법이 전혀 없었다.** 열린 포트가 680 하나뿐인데 그게 막힌 상태였다. 물리적 접근 외에 방법이 없다는 것은 운영상 단일 장애점이다. 코드 문제가 아니지만 우선순위는 P0다.

### P1-1. 전역 연결 예산이 없다

`remoteFs`만 상한 4를 갖는다. 나머지 5개 서브시스템은 상한이 없고 서로의 사용량도 모른다. 1차 핸드오버의 요구사항 8번(`[검토]` 서버당 동시 연결 예산)이 **미착수 상태로 남아 있다.**

### P1-2. keepalive가 절반에만 걸려 있다

`ServerAliveInterval=30`이 있는 곳은 `claude-pty.ts:89`와 `agent-service.ts:233` **둘뿐**이다. `ssh.ts`, `sync.ts`, `sessions.ts`의 일회성 명령에는 없다.

이 경로들은 `execFile`의 `timeout`(8~30초)에만 의존한다. 로컬 `ssh` 프로세스는 죽지만 **네트워크가 끊긴 채 죽으면 서버측 `sshd`는 FIN을 못 받아 슬롯을 계속 잡고 있는다.** `ConnectTimeout`은 TCP 연결 단계만 덮고 배너·인증 단계는 덮지 않는다는 점도 같이 봐야 한다.

### P2. 관측 수단이 없다

1차 때 41개가 쌓이는 동안 앱은 아무 신호도 내지 않았다. 지금도 마찬가지다. 현재 활성 연결 수를 앱 안에서 볼 방법이 없어, 매번 사용자가 `lsof`를 치는 것으로만 진단된다.

## 구현 방향

### 1단계: `ssh` 인자 생성을 한 모듈로 통합

4벌 중복을 `src/main/sshOptions.ts` 하나로 모은다. 이후 모든 정책 변경이 한 곳에서 이뤄지도록 하는 **선행 리팩터링**이며, 그 자체로는 동작을 바꾸지 않는다.

```ts
export type SshUsage = 'oneshot' | 'interactive'

export function sshCommonArgs(profile: SshLike, usage: SshUsage): string[] {
  const args: string[] = []
  if (profile.port) args.push('-p', String(profile.port))
  if (profile.identityFile) args.push('-i', profile.identityFile)
  args.push('-o', 'ServerAliveInterval=30')      // P1-2: 전 경로 적용
  args.push('-o', 'ServerAliveCountMax=3')
  args.push('-o', 'StrictHostKeyChecking=accept-new')
  if (usage === 'oneshot') args.push(...controlMasterArgs(profile))  // P0-1
  return args
}
```

### 2단계: 일회성 명령에만 ControlMaster 적용

**적용 대상을 나누는 것이 중요하다.**

- `oneshot` (`BatchMode=yes` 단발 명령 — `ssh.ts`, `sync.ts`, `sessions.ts`, `agent-service.ts`의 상태 확인류): 공유 마스터에 합류시킨다. 개수가 많고 수명이 짧아 **이득의 대부분이 여기서 나온다.**
- `interactive` (`claude-pty.ts`의 터미널 탭, `agent-service.ts`의 에이전트 실행 세션): 전용 연결을 유지한다. 마스터가 끊기면 물린 세션이 전부 죽으므로, 사용자 작업이 걸린 장기 세션을 공유 마스터에 얹는 것은 위험하다.

```ts
function controlMasterArgs(profile: SshLike): string[] {
  if (process.platform === 'win32') return []   // Windows OpenSSH는 미지원
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlSocketPath(profile)}`,
    '-o', 'ControlPersist=60'
  ]
}
```

주의할 점:

- **Windows OpenSSH는 ControlMaster를 지원하지 않는다.** 앱은 Windows를 지원하므로(`resolveWindowsOpenSsh()`) 반드시 플랫폼 분기해야 한다. 분기 없이 넣으면 Windows에서 전 원격 기능이 죽는다.
- **`ControlPath`는 유닉스 소켓 경로 길이 제한(macOS 약 104바이트)에 걸린다.** `%r@%h:%p` 같은 토큰을 쓰면 호스트명이 길 때 초과한다. 프로필 식별자의 해시를 짧은 파일명으로 만들어 `os.tmpdir()` 아래에 두는 편이 안전하다.
- **마스터 소켓은 앱 종료 시 정리한다.** `ControlPersist=60`이 있어도 종료 시 `ssh -O exit`로 명시적으로 닫는 경로를 `before-quit`에 넣는다.
- 마스터가 죽은 상태의 stale 소켓 파일이 남으면 이후 연결이 실패할 수 있다. `ControlMaster=auto`는 대체로 처리하지만, 실패 시 소켓 파일을 지우고 1회 재시도하는 폴백을 둔다.

### 3단계: 전역 연결 예산 (P1-1)

`remoteFs`의 상한 4를 **프로세스 전역 세마포어로 확장**해 CLI 경로까지 포함시킨다. ControlMaster가 들어가면 실제 TCP 수가 크게 줄지만, 상한은 **누수가 남아 있어도 서버를 죽이지 않게 하는 최후 방어선**이므로 별개로 필요하다.

### 4단계: 관측성 (P2)

활성 연결 수와 마스터 소켓 상태를 진단 화면에 노출하고, 임계치 초과 시 경고 로그를 남긴다.

## 서버측 보강 (앱 수정과 병행)

Mac mini(`Haui-Macmini.local`)의 `/etc/ssh/sshd_config`:

```
MaxStartups 100:30:200
LoginGraceTime 20
ClientAliveInterval 30
ClientAliveCountMax 3
```

`ClientAliveInterval`이 핵심이다. 클라이언트가 네트워크 변경·절전으로 사라져도 서버가 죽은 세션을 90초 안에 회수한다. 2차 장애의 재발을 직접 막는 항목이다.

적용: `sudo launchctl kickstart -k system/com.openssh.sshd`

## 운영 복구 경로 (P0-3)

SSH가 막혔을 때 들어갈 **대체 경로를 반드시 확보한다.** 후보:

- TeamViewer 무인 접속 (맥북에는 설치돼 있음, Mac mini 설정 여부 확인 필요)
- 다른 포트에 두 번째 `sshd` 인스턴스 — 첫 번째가 죽어도 살아남도록 별도 launchd 서비스로
- 화면 공유(VNC) 포트 개방

현재는 어느 것도 없다.

## 검증

### 재현 — ControlMaster 효과 측정

수정 전후로 같은 조작(폴더 트리 10단계 탐색 + 세션 목록 조회)을 하며 서버에서 연결 수를 센다.

```bash
# 서버에서
sudo lsof -nP -iTCP:680 -sTCP:ESTABLISHED | wc -l
```

수정 후 이 값이 **조작 횟수와 무관하게 상수**로 유지되어야 한다.

### 회귀 테스트

기존 `scripts/verify-ssh-connection-pool.mjs` 관례를 따라 `verify-ssh-options.mjs`를 추가한다. 실제 서버 없이 검증 가능해야 한다.

- `oneshot` 인자에 `ControlMaster=auto`가 포함되고 `interactive`에는 포함되지 않는다.
- `process.platform === 'win32'`일 때 ControlMaster 관련 인자가 **하나도** 포함되지 않는다.
- `ControlPath`가 100바이트를 넘지 않는다 (호스트명이 긴 프로필로 검증).
- 모든 경로에 `ServerAliveInterval`이 포함된다.

### 수동 확인 (릴리스 전)

앱을 24시간 이상 켜 두고 원격 기능을 반복 사용한 뒤 서버에서 연결 수가 예산 이하인지 확인한다. 중간에 **노트북 네트워크를 한 번 바꿔서**(Wi-Fi → 테더링) 2차 장애 조건을 재현하고, 서버가 죽은 세션을 회수하는지 본다.

## 결정이 필요한 사항

- **ControlMaster 적용 범위**: 위 제안은 일회성 명령만. 터미널 탭까지 묶으면 슬롯을 더 아끼지만 마스터 장애 시 전체 세션이 동시에 끊긴다. 사용자 영향이 큰 쪽이므로 별도 판단이 필요하다.
- **`ControlPersist` 길이**: 짧으면 마스터가 자주 재생성되어 이득이 줄고, 길면 유휴 연결이 오래 남는다. 60초는 출발점일 뿐이다.
- **전역 예산값**: ControlMaster 도입 후 실측을 보고 정한다. 지금 숫자를 확정할 근거가 없다.
- **Windows 대응**: ControlMaster를 못 쓰므로 Windows는 개선 효과가 없다. 별도 대책(연결 수 상한 강화 등)을 둘지, 현 상태를 수용할지.

## 부록: 장애 시 진단 순서

증상이 같아도 원인이 다르므로 **순서대로** 확인한다. 1차와 2차를 가르는 것이 1번이다.

```bash
# 1. 클라이언트 연결 수 — 이 값이 갈림길이다
lsof -nP -i TCP@182.225.243.14 | wc -l
```

- **10개 이상** → 앱 누수 (1차 유형). 아래로 진행.

  ```bash
  osascript -e 'tell application "legal-terminal" to quit'   # kill -TERM 은 안 먹힌다
  ssh -p 680 -o BatchMode=yes haheebong@182.225.243.14 hostname
  ```

  `kill -9`는 저장되지 않은 작업이 유실되므로 AppleScript quit이 실패할 때만 쓴다.

- **0개에 가까움** → 서버측 (2차 유형). **원격 복구 불가, Mac mini 직접 접근 필요.**

  ```bash
  # 판정 보강: 10회 재시도해 전부 실패하면 MaxStartups가 아니다
  for i in $(seq 1 10); do ssh -o ConnectTimeout=6 -o BatchMode=yes \
    haheebong@182.225.243.14 -p 680 "echo OK" 2>&1 | tail -1; done

  # Mac mini에서
  df -h /
  sudo launchctl kickstart -k system/com.openssh.sshd
  sudo lsof -nP -iTCP:680 | wc -l
  ```
