# Multi-Auth Fleet (jun-20)

> **SSOT for this workstream.** 티켓은 `./tickets/` 아래로 분리한다.
> 범위는 "ChatGPT-OAuth 계정 여러 개를 bench fleet에 안전하게 배선하는 것"이다.
> 목적은 CPU 확장이 아니라 **OAuth throttle 분리**다.

---

## 0. One line

`QUANTA_BENCH_AUTH_FILE` 단일 계정 가정을 `AuthPool + chunk lease`로 올려서,
여러 OAuth 계정으로 병렬 SWE-bench fleet를 돌리되 warm-box reuse와 fail-closed
보안을 유지한다.

## 1. Why (measured, not hypothetical)

- 현재 full-remote / pool 진입점은 단일 `QUANTA_BENCH_AUTH_FILE`만 읽는다:
  `src/apps/bench/cli.ts`.
- 현재 pool도 "shared OAuth login rate"를 병목으로 본다:
  `src/apps/bench/remote/pool.ts`.
- 운영 기록상 한 계정에 box 수와 per-box concurrency를 같이 얹으면
  `generation_error` / 429 burst가 난다. `docs/journal-jun-20.md`에는
  `6 boxes x 6 concurrency = 36 loops on one token`이 명시돼 있다.
- 같은 문서에 `known-safe ~= 6 total`이 적혀 있고, leaderboard 기록에는
  `3 boxes were over-saturating shared OAuth -> throttled to 1 box, concurrency=3`
  라고 남아 있다.
- 반대로 `docs/mining-jun20-runblock.yaml`에는 이미
  `QUANTA_BENCH_AUTH_FILE 계정분리 (동시런 OAuth rate-limit=generation_error 해소)`
  가 인프라 fix로 기록돼 있다.

즉 문제는 "한 박스가 약하다"가 아니라 "여러 run이 같은 OAuth 계정을 공유한다"다.

## 2. Decision

채택:

- **routing unit = chunk**
- **allocation = per-chunk AuthLease**
- **execution = box-sticky preference, not hard pin**
- **operator escape hatch = one-instance microchunks**

비채택:

- **per-box fixed account pinning**
  - 단순하지만 warm idle box 재사용성이 나빠진다.
  - 박스가 idle이어도 같은 account box가 아니면 못 쓰는 경직성이 생긴다.
- **per-instance account routing inside one `bench run` process**
  - 현재 box-side auth는 `~/.quanta/auth/chatgpt.json` 하나다.
  - 문제별 account mixing을 하려면 runner/provider/token-store 전부
    per-task credential aware로 갈아엎어야 한다.
  - 현재 seam을 버리는 대수술이라 Phase 1 범위가 아니다.

핵심 판단:

> account는 chunk 시작 전에 lease 받고, box는 가능한 같은 account를 계속 쓰되,
> 필요하면 다음 chunk에서 다른 account로 갈아탈 수 있어야 한다.

## 3. Negative invariants

- refresh token / id token은 계속 **박스로 보내지 않는다**. 지금처럼
  stripped `access_token`만 ship한다.
- `QUANTA_BENCH_AUTH_POOL`이 **unset**이면 기존 단일
  `QUANTA_BENCH_AUTH_FILE` 경로는 byte-identical 유지.
- account backoff / cooldown은 **per-account**여야 한다. 한 계정의 429가
  다른 계정을 멈추면 안 된다.
- warm-box reuse는 유지한다. 다만 reuse는 **same-account preference**일 뿐
  hard requirement가 아니다.
- hidden oracle / benchmark label은 scheduler 입력으로 금지한다.
- `bench run` 내부의 per-instance auth switching은 Phase 1에서 하지 않는다.
  문제별 라우팅이 필요하면 **one-instance chunk**를 사용한다.

## 4. Architecture

```text
AuthPool manifest
  -> AuthPoolResolver
  -> AuthLeaseManager
       acquire(requestedSlots, runId)
       release(accountLabel, result)
  -> Pool worker
       prefer warm idle box with same accountLabel
       ship stripped token for this chunk
       run bench chunk
       report 429/success back into lease manager
```

### 4.1 Manifest shape

```yaml
accounts:
  - label: acct-a
    auth_file: /Users/me/.quanta/auth/chatgpt-a.json
    max_parallel: 6
    max_boxes: 1
    cooldown_base_sec: 90
    weight: 1
    disabled: false
  - label: acct-b
    auth_file: /Users/me/.quanta/auth/chatgpt-b.json
    max_parallel: 6
    max_boxes: 1
```

`max_parallel`은 "이 계정이 동시에 감당하는 agent loop 수"다.
pool worker는 `requestedSlots = per-box patch-gen concurrency`로 lease를 요청한다.

### 4.2 Why chunk lease is the right seam

- 지금도 token은 chunk마다 다시 읽어서 ship한다.
- 지금도 chunk는 runId-scoped box dir로 격리된다.
- 지금도 box는 한 번에 한 chunk만 grading lock을 가진다.

즉 현재 구조는 이미 **per-chunk credential injection**에 맞춰져 있다.

## 5. Execution policy

- 기본:
  - `workers = min(readyAccounts, requestedWorkers, chunkCount)`
  - `perBoxConcurrency = min(account.max_parallel residual, requestedConcurrency)`
- 권장:
  - `1 account -> 1 active box`
  - `chunk size ~= per-box concurrency`
- 문제별 병렬을 강하게 원하면:
  - dataset을 `1 instance per chunk`로 쪼갠다.
  - scheduler는 그 microchunk들을 계정 풀에 분산한다.

즉 "per-instance routing" 대신 "microchunk routing"으로 같은 효과를 싸게 얻는다.

## 6. Code seams

- `src/apps/bench/cli.ts`
  - `QUANTA_BENCH_AUTH_FILE` 단일 입력을 `AuthSource` resolver로 일반화
- `src/apps/bench/remote/pool.ts`
  - `authJsonProvider(): string`를 `acquireLease(): Promise<AuthLease>` 계열로 승격
- `src/apps/bench/remote/box-session.ts`
  - stripped token ship seam 재사용
  - status snapshot에 `accountLabel` 추가
- `src/apps/bench/remote/full.ts`
  - single full-remote path도 같은 auth source를 쓰게 통합

## 7. Ticket map

- [tickets/00-backlog.md](tickets/00-backlog.md)
- [tickets/T-1-auth-pool-manifest-and-resolver.md](tickets/T-1-auth-pool-manifest-and-resolver.md)
- [tickets/T-2-auth-lease-manager.md](tickets/T-2-auth-lease-manager.md)
- [tickets/T-3-pool-account-aware-scheduler.md](tickets/T-3-pool-account-aware-scheduler.md)
- [tickets/T-4-microchunk-routing.md](tickets/T-4-microchunk-routing.md)
- [tickets/T-5-full-remote-auth-parity.md](tickets/T-5-full-remote-auth-parity.md)
- [tickets/T-6-observability-and-rollout.md](tickets/T-6-observability-and-rollout.md)

## 8. Success criteria

- multi-account pool이 single-account throttle confound 없이 동작한다.
- one account가 429여도 다른 account는 계속 진행한다.
- single-auth path regression 0.
- box reuse / lease release / chunk requeue에서 account slot leak 0.
- operator가 "어떤 account가 몇 slot 쓰는지 / cooling인지 / 어느 chunk가 어느 account인지"
  바로 볼 수 있다.
