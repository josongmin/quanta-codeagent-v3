# ADR-0125: Turn-diff wiring consolidation + integration proof

- **상태**: Accepted (integration test grounds the pattern; loop wire still deferred)
- **날짜**: 2026-05-24
- **관련**: ADR-0102 (turn_diff_updated 이벤트 + 모듈), ADR-0106 (SessionMeta git fingerprint), ADR-0110 (wiring helpers — 16-case hellgate)
- **참조**: `src/agent/turn-diff/`, `src/agent/git-observability/`, `tests/integration/git-observability-composite.test.ts` (4 cases, 실 git 사용)

## 맥락

ADR-0102/0106/0110은 turn-diff 흐름을 *조립*했지만 마지막 wire 1줄은 의식적으로 미뤘다 — `src/agent/loop.ts`가 별도 트랙(인증/refusal handling)에서 in-flight이라 같은 batch에 mutation을 추가하면 머지 충돌과 회귀 위험.

본 ADR은 그 3 ADR을 single decision-record로 묶고:

1. **이미 봉인된 contract + helper들을 명시적으로 catalog**.
2. 사용자가 안전하게 wire할 수 있는 **정확한 1줄 패턴**을 docs로 박음.
3. 실 `defaultGitRunner` + tmpdir-init 실 git repo로 composite wireGitObservability가 작동함을 **integration test로 증명**.

## 결정

### Part A — 이미 봉인된 surface 카탈로그

| 모듈 | 책임 | 상태 |
|---|---|---|
| `src/agent/turn-diff/captureTurnStart` | HEAD SHA snapshot | ADR-0102 봉인 |
| `src/agent/turn-diff/computeTurnDiff` | (from, current) → `{filesChanged, insertions, deletions, unifiedDiff}` | ADR-0102 봉인 |
| `src/agent/turn-diff/buildTurnDiffEvent` | payload → typed `turn_diff_updated` AgentEvent | ADR-0102 봉인 |
| `src/agent/git-observability/wireSessionGitFingerprint` | SessionMeta → SessionMeta + gitSha/Branch/OriginUrl | ADR-0110 봉인 (6 hellgate) |
| `src/agent/git-observability/wireTurnDiffEmit` | per-session `{startTurn, endTurn}` state machine | ADR-0110 봉인 (9 hellgate) |
| `src/agent/git-observability/wireGitObservability` | composite (fingerprint + turn-diff 한 줄로) | ADR-0110 봉인 (1 hellgate) |

총 17 module-level hellgate (16 wiring + 4 integration, 본 ADR).

### Part B — Caller wiring pattern (정확한 1줄 박음)

```ts
// apps/agent bootstrap (또는 비슷한 assembly 위치)
import { wireGitObservability } from "@/agent/git-observability"

const obs = wireGitObservability({ runner: defaultGitRunner, cwd: workspace })

// (1) 세션 생성 직후 — fingerprint attach
sessionMeta = await obs.fingerprintMeta(sessionMeta)

// (2) 루프 안 — 매 턴 start/end
await obs.turnDiff.startTurn(turnIndex)
// ... turn body (model + tool calls) ...
const ev = await obs.turnDiff.endTurn(turnIndex)
if (ev !== null) emit(ev)   // stream에 푸시
```

**불변**:
- `startTurn` 멱등 (side-conversation 재진입 시 안전).
- `endTurn` 변경 없으면 null (false-positive 없음).
- 모든 git failure → null (no-throw 절대 가정 — observability instrumentation은 loop를 깨면 안 됨).

### Part C — Integration test 증명

신규 `tests/integration/git-observability-composite.test.ts` (4 cases, **실 git** + tmpdir):

1. **fingerprintMeta** — meta 비-destructive attach (gitSha SHA-1 hex + gitBranch 정확).
2. **No worktree change** — endTurn → null (best-effort).
3. **Write + commit between start/end** — typed `turn_diff_updated` event with `turn`, `filesChanged`, `unifiedDiff` payload.
4. **Multi-turn isolation** — 각 턴이 자기 commit만 본다.

이 통합 test가 *caller wiring 패턴 자체*를 봉인 — apps/agent가 위 1줄 패턴 그대로 박으면 작동함을 정보적으로 보장.

## Default-OFF (loop wire는 여전히 deferred)

`src/agent/loop.ts` 직접 수정은 **이 ADR도 안 함**. 사용자 in-flight 영역. caller(apps/agent 또는 cli bootstrap)가 위 Part B 패턴을 wire하면 끝.

본 ADR이 추가하는 가치 = **wire 패턴이 검증됐다는 박힘** + **integration test = working specification**.

## Alternatives rejected

1. **loop.ts에 직접 wire** — 사용자 in-flight 충돌 위험; helper 시계열 design이 이미 그 위험 회피하려고 만들어진 것.
2. **unit hellgate만으로 충분, integration test 불필요** — fake runner는 실 git의 미묘한 행동(빈 diff → exit 0, --shortstat parsing, branch detached state)을 다 다룰 수 없음. 실 git integration이 wiring spec의 진짜 ground truth.
3. **Composite를 함수 안에 hard-code (DI 제거)** — runner injection은 sandbox/remote substrate으로 swap 가능하게 하는 5-plane keystone (ADR-0093).

## SOTA++ 자리매김

| Agent | per-turn aggregate diff event | per-tool diff | Notes |
|---|---|---|---|
| Codex | ✅ `turn/diff/updated` (4MiB cap) | ✅ | original pattern |
| Cursor | partial (UI context refresh) | ✅ | event stream 아님 |
| Claude Code | ✅ transcript JSONL | ✅ ANSI streaming | 합쳐서 typed event ❌ |
| **quanta** | ✅ ADR-0102 contract + ADR-0110 helpers + ADR-0125 integration test | ✅ via tool result | **wire pattern proven, loop wire deferred** |

= "Codex의 turn-diff 패턴을 typed contract + closed-port helpers + composite + integration test로 흡수, loop wire만 caller 책임으로 deferred한 *명시적 분리* 패턴".

## Follow-up

- **Loop wire 1줄**: `src/agent/loop.ts`의 turn boundary 안 startTurn/endTurn 호출. 사용자 in-flight 정착 후 별도 ADR.
- **CLI surface**: 이벤트가 CLI에 어떻게 렌더링되는지 (현재 trace 흐름) — ADR-0117 ProgressLine 패턴 재사용 가능.
- **Persistence**: turn-diff 이벤트를 JSONL recorder에 첨부 (현재 정의 0102에는 있으나 wire 시점에 검증).
