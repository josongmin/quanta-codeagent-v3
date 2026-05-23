# ADR-0110: Git observability wiring helpers (opt-in seam for ADR-0102/0106)

- **상태**: Accepted
- **날짜**: 2026-05-23
- **관련 ADRs**: ADR-0102(`turn_diff_updated` event + emitter), ADR-0106(SessionMeta git fingerprint), ADR-0094(ChatGPT OAuth — `src/agent/loop.ts` in-flight 트랙)
- **참조**: `src/agent/git-observability/index.ts`(barrel + composite), `src/agent/git-observability/session-fingerprint.ts`(Part A), `src/agent/git-observability/turn-diff-emit.ts`(Part B), `tests/unit/git-observability-wiring-hellgate.test.ts`(16 적대)

## 맥락

ADR-0102와 ADR-0106는 **contract + 모듈**까지만 만들고 loop wiring은 의도적으로 deferred:

- ADR-0102: `src/agent/turn-diff/`(captureTurnStart / computeTurnDiff / buildTurnDiffEvent)는 존재하나 `src/agent/loop.ts`가 emit 안 함.
- ADR-0106: `captureGitFingerprint(runner, cwd)`는 존재하나 session 생성 시 호출 안 함 — `SessionMeta.gitSha/gitBranch/gitOriginUrl`은 항상 undefined.

두 정합 모두 같은 이유로 보류: `src/agent/loop.ts`는 ADR-0094 ChatGPT OAuth 트랙에서 동시에 수정 중(M state)이라, 같은 batch에서 추가 mutation을 더하면 머지 충돌과 회귀 위험.

본 ADR은 이 follow-up을 **loop 미수정** 방식으로 해소한다: 캘러(앱/CLI bootstrap)가 명시적으로 옵트인 wire-up하도록 헬퍼 슬라이스를 새로 만든다. 미래에 loop이 잠잠해지면 `runAgent({ gitObservability?: GitObservability })` 같은 옵트인 config 필드로 흡수 가능(본 ADR 범위 밖).

## 결정

### Part A — `wireSessionGitFingerprint`(`src/agent/git-observability/session-fingerprint.ts`)

`SessionMeta` → `Promise<SessionMeta>` non-destructive 래퍼.

- 입력 meta **미터치** — shallow clone 후 `gitSha/gitBranch/gitOriginUrl`만 attach.
- 내부에서 `captureGitFingerprint(runner, meta.cwd, signal)` 호출. 실패 시 빈 fingerprint → clone 그대로 반환(throw 없음).
- 각 필드는 정의된 경우에만 attach — `{ gitSha: undefined }` 같은 noisy key 회피.

### Part B — `wireTurnDiffEmit`(`src/agent/git-observability/turn-diff-emit.ts`)

턴 단위 state machine.

```
{ startTurn(i): Promise<void>; endTurn(i): Promise<AgentEvent | null> }
```

- `startTurn(i)`: `captureTurnStart` → 성공 시 `anchors[i] = sha`. 이미 anchor 있으면 no-op(idempotent — side-conversation으로 loop 재진입 시 anchor 보존).
- `endTurn(i)`: anchor 없으면 `null` 즉시 반환. 있으면 `computeTurnDiff({runner, cwd, fromSha: anchors[i], maxUnifiedBytes?, signal?})` → null 시 `null`, payload 시 `buildTurnDiffEvent(i, payload)` 반환.
- `WireTurnDiffOpts.runner/cwd/maxUnifiedBytes/signal` 모두 옵트인 DI — closed-port.

### Part C — `wireGitObservability` 컴포지트(`src/agent/git-observability/index.ts`)

단일 `WireTurnDiffOpts`로 두 헬퍼 묶음. 캘러가 "git observability 통째로 활성"을 원할 때 한 줄로 끝.

```ts
const obs = wireGitObservability({ runner: defaultGitRunner, cwd })
const meta = await obs.fingerprintMeta(baseMeta)
await obs.turnDiff.startTurn(i)
// ... turn body ...
const ev = await obs.turnDiff.endTurn(i)
if (ev !== null) emit(ev)
```

부분 사용은 barrel의 개별 export(`wireSessionGitFingerprint`, `wireTurnDiffEmit`) 직접 import.

## 결과

- 16 hellgate 통과:
  - `wireSessionGitFingerprint` 6 (full / non-repo / immutability / spawn-error / signal-forward / detached HEAD).
  - `wireTurnDiffEmit` 9 (no-anchor / no-change / event shape / startTurn 멱등 / multi-turn 격리 / spawn-error / `maxUnifiedBytes` forward / discriminator 검증 / signal-forward).
  - `wireGitObservability` 1 (composite 정상 동작).
- `src/agent/loop.ts` 미수정 — ADR-0094 트랙과 결합도 0.
- `src/agent/turn-diff/`, `src/session/git-fingerprint.ts`, `src/session/types.ts`, `src/stream/types.ts` 모두 재사용만 — 직전 흡수(0102/0106) byte-identical.
- biome 0 errors / 0 warnings, tsc 우리 슬라이스 0 errors.

## 한계 / 미래 작업

- **loop 통합은 본 ADR 범위 밖.** 캘러(앱/CLI/엔트리포인트)가 명시적으로 호출해야 emit이 발생. ADR-0094 트랙이 잠잠해진 뒤 후속 ADR에서 `runAgent({ gitObservability?: GitObservability })` 같은 옵트인 필드 + loop 안에서 `obs.turnDiff.startTurn(turnIndex)` / `endTurn(turnIndex)` 호출 + emit wiring 추가 권장.
- `wireSessionGitFingerprint`는 **한 번** 호출되도록 의도(세션 시작 시) — turn 도중 branch switch / commit은 `wireTurnDiffEmit`이 turn별로 본다. 세션 메타를 매 turn 갱신하는 사용은 본 ADR 비대상(별도 ADR 필요 시).
- 두 헬퍼는 모두 best-effort — git 실패가 silent. 캘러가 "git 실패 시 알림"을 원하면 상위에서 status 검출 로직 추가 필요.
- `WireTurnDiffOpts.cwd`는 wiring 시점에 고정 — 턴 중간 cwd 변경(예: 도구가 cwd를 옮김)은 미지원. 의도된 단순화(loop가 cwd 변경을 metadata로 보존하지 않음).
