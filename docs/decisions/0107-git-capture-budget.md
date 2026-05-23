# ADR-0107: `GitBudget` 5-knob capture budget (Cursor `captureGitHistory` 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-23
- **관련 ADRs**: ADR-0105(같은 batch — env + log format), ADR-0025(git 1급 도구), Cursor `captureGitHistory` `CaptureBudget`
- **참조**: `src/tool/git/_budget.ts`(`GitBudget` + helpers), `tests/unit/git-env-and-budget-hellgate.test.ts`(HELL-11~17 = 7 적대)

## 맥락

Cursor `file-service` Rust NAPI의 `gix-snapshot` 크레이트는 history walk를 5-knob `CaptureBudget`으로 캡: `maxCommits / maxWallTimeMs / maxPackBytes / targetDurationMs / consecutiveOverBudget`. 5-stage 머신(RefStore → Commit → PackTree → PackBlob → Pack) 각 단계가 budget 체크 — unbounded walk가 latency / memory를 폭파시키는 거대 monorepo에서 결정적.

우리 git 도구는 `-n <N>` cap + runner 30s timeout만 — typed budget interface 부재. 결정성/예측가능성 제한.

## 결정

### Part A — `GitBudget` interface (`src/tool/git/_budget.ts`)

Cursor `CaptureBudget` 5 필드를 verbatim mirror:
- `maxCommits?: number` — `git log -n <N>` 변환(callsite 책임)
- `maxWallTimeMs?: number` — AbortSignal 융합(아래)
- `maxOutputBytes?: number` — stdout cap(callsite 책임)
- `targetDurationMs?: number` — 텔레메트리 hint(enforcement 아님)
- `consecutiveOverBudget?: number` — 멀티-런 상태(one-shot 도구는 무시)

closed-port — 도구가 opt-in.

### Part B — `applyBudget(parent, budget)` 헬퍼

`parent?: AbortSignal` + `budget?: GitBudget` → `{ signal: AbortSignal | undefined; cleanup: () => void }`. 

- budget 미설정 ⇒ `parent` 그대로 반환(zero overhead).
- `maxWallTimeMs` 설정 시 fused AbortController — parent abort OR 시간 만료 중 먼저 win.
- hard ceiling 60s(`MAX_WALL_TIME_HARD_MS`) — 사용자가 분 단위 mis-type(`5 * 60000`)해도 cap.
- 잘못된 값(NaN/음수/0) ⇒ no-op pass-through.
- cleanup() finally 필수 — long-lived parent에 listener 누수 방지.

### Part C — 헬퍼 함수

- `resolveMaxCommits(explicit, budget, default)` — min(explicit, budget.maxCommits) 또는 default.
- `crossedTarget(elapsedMs, budget)` — `targetDurationMs` 초과 시 true(boolean 텔레메트리).

### Part D — 노출

`src/tool/git/index.ts`에서 `applyBudget` / `crossedTarget` / `resolveMaxCommits` / `GitBudget` 타입 export.

## 결과

- 7 hellgate 통과: no-budget pass-through / `maxWallTimeMs` 발화 / parent abort propagation / hard clamp / 잘못된 값 / `resolveMaxCommits` min 선택 / `crossedTarget` strict greater 비교.
- 기존 9 git 도구는 본 ADR로 byte-identical(opt-in 미사용). callsite가 `budget` arg를 명시적으로 받으면 활성.

## 한계

- `maxPackBytes` / `consecutiveOverBudget`는 **forward-compat 타입 슬롯** — Cursor의 5-단계 머신을 우리가 직접 구현 안 함(`gix-snapshot` 같은 Rust 크레이트 부재). interface는 1:1 미러해서 미래 포팅 가능성 유지.
- `targetDurationMs`는 enforcement 아님 — caller가 telemetry로 surface해야 user-visible.
- 60s hard ceiling은 우리 default — 정말 긴 작업은 budget 미지정으로 runner의 native 30s에 위임.
