# SSH 연결 누수 핸드오버

> **상태: 해결됨 (v0.1.173, 커밋 `e316b9e`·`504107a`, 2026-07-29).**
> 이 문서가 다루는 ssh2 풀 누수는 `src/main/sshConnectionPool.ts`로 분리·수정됐고 `scripts/verify-ssh-connection-pool.mjs`로 회귀 검증된다.
> 2026-08-01 같은 증상이 재발했으나 **원인이 달랐다**(서버측). 남은 구조적 과제와 후속 작업은 [`handover-ssh-connection-budget.md`](./handover-ssh-connection-budget.md)로 이어진다. 이 문서는 배경 파악용으로 읽는다.

## 목적

원격 파일 패널이 사용하는 ssh2 연결이 앱 실행 기간 동안 회수되지 않고 누적되는 문제를 정리하고, 재발을 막는 연결 수명주기 설계를 후속 작업자에게 전달한다.

이 문서는 v0.1.171(`9f8d555`) 기준 코드의 실제 동작과 2026-07-28에 관측된 장애 데이터를 근거로 한다. **근본 원인 절의 시나리오는 코드 리딩으로 도출한 것이며, 런타임 계측으로 재현 확인하는 것이 첫 작업이다.**

## 관측된 사실

2026-07-28, macOS에서 `ssh -p 680 haheebong@182.225.243.14` 접속이 100% 실패했다.

| 확인 항목 | 관측값 |
| --- | --- |
| TCP 680 도달 | 성공 (네트워크·방화벽 정상) |
| SSH 배너 수신 | 5회 시도 전부 실패 |
| `ssh -v` 종료 지점 | `kex_exchange_identification: Connection closed by remote host` |
| 열린 연결 수 | **41개 ESTABLISHED, 전부 PID 62481 = `legal-terminal`** |
| 소켓 큐 | 41개 모두 Recv-Q 0 / Send-Q 0 (유휴 상태로 살아 있음) |
| 앱 가동 시간 | 5일 8시간 51분 |
| 별도 `ssh` 자식 프로세스 | 없음 |

연결 41개가 전부 앱 프로세스 자신의 소켓이었고 자식 `ssh` 프로세스가 없었으므로, 누수 주체는 `ssh.ts`의 CLI 경로가 아니라 **`remoteFs.ts`의 ssh2 라이브러리 연결**이다.

서버(`Haui-Macmini.local`)의 `sshd`가 동시 연결 제한(`MaxStartups`, 기본 `10:30:100`)에 걸려 신규 연결을 배너 교환 전에 끊고 있었다. 기존 41개는 살아 있고 신규만 실패하는 패턴이 이 증상과 일치한다.

`SIGTERM`은 무시됐고(Electron 앱), `osascript -e 'tell application "legal-terminal" to quit'`로 정상 종료하자 41개가 한꺼번에 반납되며 SSH 접속이 즉시 복구됐다.

증상의 핵심은 **앱이 서버의 SSH 접속 슬롯을 고갈시켜 사용자가 같은 서버에 터미널로 접속하지 못하게 만든다**는 점이다. 앱 자체 기능 장애보다 파급이 크다.

## 코드 위치와 현재 구조

- 연결 풀 본체: [`src/main/remoteFs.ts`](../src/main/remoteFs.ts)
  - `pool` 선언: 40행 — `Map<string, Promise<{ client, sftp }>>`, 키는 `profileId`
  - `connect()`: 368–403행 — `new Client()` 생성과 이벤트 배선
  - `removeConnection()`: 405–410행
  - `getConnection()`: 412–433행 — 모든 원격 작업의 진입점
  - `buildConfig()`: 332–366행 — `readyTimeout: 20000`, `keepaliveInterval: 20000`
  - `disposeRemote()`: 518–526행
- 종료 훅: [`src/main/index.ts`](../src/main/index.ts) 2586–2590행 — `app.on('before-quit')`
- CLI 기반 별도 경로: [`src/main/ssh.ts`](../src/main/ssh.ts) — `execFile('ssh', …)`. 자식 프로세스가 끝나면 소켓이 회수되므로 **이번 누수와 무관하다.** 다만 같은 서버의 연결 슬롯을 함께 소비한다는 점은 상한 설계에 고려해야 한다.

`getSftp()`/`getConnection()` 호출 지점은 `remoteFs.ts` 안에서만 15곳이다. 디렉터리 목록, 파일 읽기/쓰기, stat, 자동 푸시 타이머 등이 서로 독립적으로 호출하므로 **동시 호출은 예외가 아니라 정상 동작**이다.

## 근본 원인

### 1. `getConnection()` 재진입 시 발생하는 고아 연결 (주 원인)

```ts
async function getConnection(profileId: string): Promise<{ client: Client; sftp: SFTPWrapper }> {
  const existing = pool.get(profileId)
  if (existing) {
    try {
      return await existing          // (A) 다수 호출자가 같은 promise에서 대기
    } catch {
      removeConnection(profileId, existing)   // (B) reject 시 대기자 전원이 여기로
    }
  }
  const fresh = connect(profileId)   // (C) 대기자 수만큼 새 소켓 생성
  pool.set(profileId, fresh)         // (D) pool에는 마지막 것만 남는다
  try {
    return await fresh
  } catch (e) {
    removeConnection(profileId, fresh)
    throw e
  }
}
```

N개의 호출자가 (A)에서 같은 pending promise를 기다리는 중에 그 연결이 **실패**하면, 전원이 (B)를 지나 각자 (C)를 실행한다. 소켓 N개가 새로 열리지만 (D)의 `pool.set()`은 마지막 하나만 남기고 앞의 것들을 조용히 덮어쓴다.

덮어써진 N-1개는 이후 정상적으로 `ready` → `resolve`되어 **살아 있는 연결이 되지만 어떤 코드도 참조하지 않는다.** `keepaliveInterval`이 20초마다 패킷을 보내 서버가 끊지도 않으므로 `client.on('close')`가 영원히 발동하지 않고, 앱이 종료될 때까지 ESTABLISHED로 남는다.

이 경로는 **네트워크 순단, `readyTimeout` 초과(20초), 서버 `sshd` 재시작, 노트북 절전 복귀** 때마다 트리거된다. 한 번에 대기자 수만큼 누수되므로 5일간 41개라는 관측치와 규모가 맞는다.

한 번 누수가 시작되면 서버 슬롯이 줄어 다음 연결이 더 쉽게 실패하고, 실패가 다시 누수를 부르는 **자기 가속 구조**라는 점이 중요하다.

### 2. 누수를 영구화하는 구조적 요인

주 원인을 고쳐도 아래가 남으면 다른 경로로 같은 증상이 재발한다.

- **`removeConnection()`이 소켓을 닫지 않는다.** pool의 Map 엔트리만 지운다(409행). pool에서 빠진 client는 그 순간 회수 불가능한 고아가 된다. 소유권 이전 없이 참조만 버리는 구조다.
- **`pool.set()`이 기존 엔트리를 무조건 덮어쓴다.** 덮어쓰기 전 이전 연결을 `end()`하지 않는다.
- **유휴 만료도 최대 수명도 없다.** 한 번 맺은 연결은 앱 생명주기 내내 유지된다. 5일 실행이 곧 5일짜리 연결이다.
- **런타임 중 정리 경로가 사실상 없다.** `disposeRemote()`의 유일한 호출처는 `before-quit`(index.ts 2589행)뿐이다. 프로필 변경, 장시간 유휴, 창 닫기 등에서 회수가 일어나지 않는다.
- **연결 수 상한과 관측 수단이 없다.** 41개가 쌓이는 동안 앱은 아무 신호도 내지 않았다. 사용자가 다른 경로로 SSH를 시도해 실패하고 나서야 발견됐다.

## 설계 요구사항

후속 구현이 만족해야 할 조건. `[필수]`는 이번 수정에서 반드시 충족한다.

1. `[필수]` **profileId당 살아 있는 ssh2 연결은 최대 1개다.** 어떤 동시성·실패 조합에서도 이 불변식이 깨지지 않아야 한다.
2. `[필수]` **소유권 규칙: pool에서 제거되는 모든 client는 반드시 닫힌다.** 참조를 버리는 코드 경로가 존재해서는 안 된다. `pool.delete()`와 `client.end()`를 한 함수로 묶어 개별 호출을 금지한다.
3. `[필수]` **연결 실패 시 재시도는 single-flight로 합류시킨다.** 대기자 N명이 각자 재연결하지 않고 하나의 재시도를 공유해야 한다.
4. `[필수]` **프로세스 전역 하드 상한**을 둔다. 상한 도달 시 새 연결을 만드는 대신 에러를 던지고 경고를 남긴다. 누수가 남아 있더라도 서버 슬롯 고갈까지는 가지 않게 하는 최후 방어선이다.
5. `[권장]` **유휴 타임아웃**(예: 5분 무사용 시 `end()`)과 **최대 수명**(예: 1시간)을 둔다. 장시간 실행 시나리오에서 연결이 무한정 늙지 않게 한다.
6. `[권장]` **관측성**: 현재 활성 연결 수를 로그·진단 화면에서 확인할 수 있게 한다. 임계치(예: 3개) 초과 시 경고 로그를 남긴다.
7. `[권장]` **종료 경로 보강**: `before-quit` 외에 프로필 변경·설정 저장 시점에도 해당 profileId의 연결을 정리한다. `before-quit`은 `SIGTERM`에서 실행되지 않으므로 여기에만 의존하지 않는다.
8. `[검토]` `ssh.ts`의 CLI 경로와 합산한 서버당 동시 연결 예산을 정한다. 두 경로가 같은 `sshd` 제한을 공유한다.

## 구현 방향

한 가지 안이며, 요구사항을 만족하면 다른 구조도 무방하다.

핵심은 **연결 상태를 promise가 아니라 명시적 엔트리로 들고, 폐기를 단일 함수로 강제**하는 것이다.

```ts
interface PoolEntry {
  client: Client
  sftp: SFTPWrapper
  createdAt: number
  lastUsedAt: number
}

const pool = new Map<string, PoolEntry>()
const inflight = new Map<string, Promise<PoolEntry>>()   // single-flight 전용
const MAX_TOTAL_CONNECTIONS = 4

// 폐기는 이 함수를 통해서만 한다. pool.delete()의 개별 호출을 금지한다.
function discard(profileId: string, entry: PoolEntry | undefined, reason: string): void {
  if (!entry) return
  if (pool.get(profileId) === entry) pool.delete(profileId)
  try {
    entry.client.end()
  } catch {
    /* best effort */
  }
  // end()에 서버가 응답하지 않는 경우를 대비한 강제 회수
  setTimeout(() => {
    try {
      entry.client.destroy()
    } catch {
      /* best effort */
    }
  }, 3_000).unref?.()
  log.warn(`[remoteFs] 연결 폐기 (${reason}), 잔여 ${pool.size}`)
}

async function getConnection(profileId: string): Promise<PoolEntry> {
  const live = pool.get(profileId)
  if (live && isUsable(live)) {
    live.lastUsedAt = Date.now()
    return live
  }
  if (live) discard(profileId, live, 'stale')

  // 요구사항 3: 대기자 전원이 하나의 재시도를 공유한다
  const pending = inflight.get(profileId)
  if (pending) return await pending

  if (pool.size >= MAX_TOTAL_CONNECTIONS) {
    throw new Error(`원격 연결 상한(${MAX_TOTAL_CONNECTIONS}) 초과`)
  }

  const attempt = connect(profileId)
    .then((entry) => {
      // 경합으로 그 사이 다른 엔트리가 들어왔다면 새 것을 버린다 (요구사항 1)
      const current = pool.get(profileId)
      if (current && current !== entry) {
        discard(profileId, entry, 'race-loser')
        return current
      }
      pool.set(profileId, entry)
      return entry
    })
    .finally(() => {
      inflight.delete(profileId)   // 성공·실패 모두에서 반드시 해제
    })

  inflight.set(profileId, attempt)
  return await attempt
}
```

주의할 점:

- `inflight`의 해제는 반드시 `finally`에서 한다. 실패 경로에서 누락되면 영구 교착이 된다.
- `connect()`의 기존 `failConnection`은 `client.destroy()`를 호출하므로 실패한 연결 자체는 이미 정리된다(383행). 문제는 실패가 아니라 **성공한 뒤 버려지는 연결**이다. 위 `race-loser` 분기가 그 경로를 막는다.
- `isUsable()`은 소켓 생존 여부를 확인해야 한다. ssh2는 half-open을 즉시 알려주지 않으므로 `createdAt`/`lastUsedAt` 기반 만료(요구사항 5)와 함께 쓰는 편이 안전하다.
- 유휴 회수 타이머는 `unref()`로 걸어 앱 종료를 막지 않게 한다.

## 검증

### 재현 (수정 전 확인)

계측이 먼저다. 현재 코드에서 누수가 실제로 이 경로로 발생하는지 확인한다.

1. `remoteFs.ts`에 연결 생성·폐기 로그를 임시로 추가한다.
2. 원격 파일 패널을 연 상태에서 서버 `sshd`를 재시작하거나, 방화벽으로 680 포트를 20초 이상 차단해 `readyTimeout`을 유도한다.
3. 차단 해제 후 연결 수를 센다.

```bash
lsof -nP -iTCP | grep -c "182.225.243.14:680"
```

동시 대기자가 여러 개인 상태에서 이 값이 1을 넘어 증가하면 재현이다.

### 회귀 테스트

`ssh2`의 `Client`를 목으로 대체해 다음 시나리오를 단위 테스트로 고정한다. 실제 서버 없이 검증 가능해야 한다.

- 동시 호출 10개 중 첫 연결이 실패 → **생성된 Client 인스턴스 수가 2를 넘지 않고, 최종 살아 있는 연결이 정확히 1개**여야 한다. (주 원인 직접 검증)
- pool에서 교체된 엔트리는 예외 없이 `end()`가 호출돼야 한다.
- 상한 도달 시 새 Client를 만들지 않고 에러를 던져야 한다.
- `inflight`가 실패 후에도 비워져 다음 호출이 정상 진행돼야 한다.

`package.json`에 테스트 스크립트가 정의돼 있지 않다. 기존 `scripts/verify-*.mjs` 방식(예: [`scripts/verify-record-outline.mjs`](../scripts/verify-record-outline.mjs))을 따르는 편이 저장소 관례에 맞는다.

### 수동 확인 (릴리스 전)

앱을 24시간 이상 켜 두고 원격 패널을 반복 사용한 뒤:

```bash
lsof -nP -iTCP | grep -c "182.225.243.14:680"
```

`MAX_TOTAL_CONNECTIONS` 이하를 유지해야 한다.

## 결정이 필요한 사항

- **상한값**: profileId당 1개는 확정. 프로세스 전역 상한을 몇으로 둘지, `ssh.ts`의 CLI 연결까지 합산할지.
- **유휴 타임아웃 길이**: 짧으면 재연결 지연이 사용자에게 노출되고, 길면 슬롯을 오래 점유한다.
- **상한 초과 시 UX**: 조용히 에러를 던질지, 사용자에게 알릴지.
- **서버측 보강 여부**: 앱 수정과 별개로 `sshd_config`의 `MaxStartups`를 올릴지. 근본 해결이 아니라 완충재이므로 앱 수정을 대체하지 않는다.

## 부록: 현장 대응 절차

같은 증상이 재발했을 때의 즉시 조치.

증상 — 포트는 열려 있는데 SSH가 `kex_exchange_identification: Connection closed by remote host`로 실패.

```bash
# 1. 원인 확인 (10개를 넘으면 누수 상황)
lsof -nP -iTCP | grep -c "182.225.243.14:680"

# 2. 정리 — kill -TERM 은 이 앱에 먹히지 않는다
osascript -e 'tell application "legal-terminal" to quit'

# 3. 복구 확인
ssh -p 680 -o BatchMode=yes haheebong@182.225.243.14 "hostname"
```

`kill -9`는 저장되지 않은 작업이 유실되므로 AppleScript quit이 실패할 때만 사용한다.
