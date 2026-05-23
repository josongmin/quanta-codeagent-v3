# ADR-0121: Auto-checkpoint policy for the shadow git ODB

- **상태**: Accepted (2026-05-24)
- **관련 ADRs**: ADR-0108 (Shadow git ODB foundation), ADR-0116 (branch-search anchor — 첫 `ShadowOdb` consumer), ADR-0118 (rewind impl + 안전망), ADR-0119 (`shadow_rewind` / `shadow_snapshots` 첫-class agent tool 노출)
- **참조**:
  - `src/agent/checkpoint-policy.ts` — 신규 슬라이스 (closed enum + DI oracle + per-(workspace,turn) dedup + `withAutoCheckpoint` wrap)
  - `src/agent/checkpoint-wiring.ts` — composition-root opt-in helper (default-OFF, byte-identical-when-unwired)
  - `src/agent/types.ts` — `AgentConfig.shadowCheckpoint` slot + `FeaturesConfig` literal-union 확장
  - `src/tool/types.ts` — `ToolContext.turnId?` 서가운드 (per-(workspace,turn) dedup 의 turn 키)
  - `tests/unit/checkpoint-policy-hellgate.test.ts` — 20 case
- **SOTA 레퍼런스**: Hermes (opt-in / pre-destructive / 1-per-turn), Cline (every-tool / no dedup), Codex (per-turn / verify boundary), Cursor (verify boundary, gix-snapshot 내부)

## Context

ADR-0108/0116/0118/0119 는 storage port + tools + 안전망 + agent surface 를 모두 출하했다. 그러나 anchor (`ShadowOdb.registerHead`) 는 *caller 가 명시적으로 등록할 때만* 잡힌다 — branch-search anchor (ADR-0116) 와 사용자가 호출하는 `shadow_rewind` (ADR-0119) 만 consumer 다.

industry SOTA 는 전부 **automatic checkpoint with policy** 를 가진다:

| 시스템 | 정책 | grain |
|---|---|---|
| Cline | 매 tool use 전 anchor | 최세분 (스팸 위험) |
| Hermes | 매 destructive op 전 anchor, turn 단위 dedup | "1 per dir per turn" invariant |
| Codex / Cursor | verify 성공 boundary 에서 anchor | 최조분 (per-turn) |

quanta 는 그 4 패턴 중 하나도 자동으로 제공하지 않는다. 본 ADR 이 닫는 갭이다.

## Decision

5 part. 전부 새 surface 추가 — 기존 코드 mutation 0 (`AgentConfig`/`ToolContext`/`FeaturesConfig` 각각 1 필드/1 키 추가가 예외, 전부 OPTIONAL).

### Part 1 — `CheckpointPolicy` port (`src/agent/checkpoint-policy.ts`)

**Closed enum** `CheckpointTriggerMode` 4-arm:

```ts
"off"               // default — no auto-anchor (byte-identical with today)
"pre-destructive"   // before mutating tool, dedup per (workspace, turn) — Hermes
"per-mutating"      // before every mutating tool call, NO dedup — Cline
"per-turn"          // once at end of turn, dedup per (workspace, turn) — Codex
```

확장은 audit-time concern — 모든 exhaustive switch 가 compile error.

**Pluggable oracle** `DestructivenessOracle = (tool, call, ctx) => boolean`. Default 는 `tool.isReadOnly()` 를 trust (tool-author contract); throwing `isReadOnly` 는 fail-open (oracle returns `false`).

**Policy port** `CheckpointPolicy`:
- `shouldAnchorBefore(tool, call, ctx): Promise<boolean>` — NO-THROW (oracle 실패 → false)
- `shouldAnchorAfterTurn(turnId, workspace): Promise<boolean>` — NO-THROW (빈 turnId → false)
- `recordAnchored(key: DedupKey): void` — anchor 실제 잡힐 때 dedup set 에 기록

**Default implementation** `defaultCheckpointPolicy(cfg)` — 내부 `Set<string>` 로 (workspace, turnId) 페어 추적. `mode==="off"` 면 두 predicate 모두 false (port 미접촉).

**Wrap** `withAutoCheckpoint(inner, policy, cfg, resolveTool)` — `EffectChannel → EffectChannel`. Inner 의 `execute` 가 throw 하면 wrap 도 그대로 throw (도구 에러 swallow 금지). `odb.registerHead` 가 throw 하면 swallow (observability 가 도구 호출을 깨면 안 됨).

### Part 2 — `AgentConfig.shadowCheckpoint` slot (`src/agent/types.ts`)

`shadowOdb` 와 **별개** top-level slot:

```ts
shadowCheckpoint?: { mode: CheckpointTriggerMode; oracle?: DestructivenessOracle }
```

storage port 와 policy 는 **decouple**: 사용자가 `shadowOdb` 만 wire 해도 `branch_search` / `shadow_rewind` / `shadow_snapshots` 는 동작; auto-anchor 는 명시적 opt-in 일 때만 활성.

`FeaturesConfig` literal-union 에 `"shadowCheckpoint"` 알파벳 자리에 추가 (`"shadowOdb"` 바로 앞).

### Part 3 — `ToolContext.turnId?` seam (`src/tool/types.ts`)

`exactOptional` 형식 OPTIONAL string. policy 의 (workspace, turn) dedup 키. 부재 ⇒ dedup 불가 → per-turn 모드 안전하게 skip (스팸 안전), pre-destructive 모드는 매 destructive call 마다 anchor (no dedup window). 도구 슬라이스가 `@/agent` 를 import 하지 않게 duck-typed.

### Part 4 — Wiring helper `wireCheckpointedEffectChannel` (`src/agent/checkpoint-wiring.ts`)

Dispatch seam (`dispatch.ts`) 는 **수정 안 함** (user in-flight). composition root 가 1 줄로 opt-in:

```ts
const channel = wireCheckpointedEffectChannel(localChannel, config, resolveTool)
```

3 단 short-circuit (`shadowCheckpoint` 부재 / `shadowOdb` 부재 / `mode==="off"`) ⇒ inner 그대로 반환 (byte-identical). 모두 wired + mode ≠ off 인 경우만 policy 구성 + wrap.

### Part 5 — 20-case hellgate (`tests/unit/checkpoint-policy-hellgate.test.ts`)

6 블록:
- **A. mode="off" — byte-identical (3)**: A1/A2/A3 — destructive call/withAutoCheckpoint wrap/read-only call 전부 false + port 미접촉
- **B. Default oracle (3)**: B4/B5/B6 — readonly=true→false / readonly=false→true / isReadOnly throws→false (fail-open)
- **C. mode="pre-destructive" (4)**: C7/C8/C9/C10 — destructive→true / readonly→false / second-call-same-turn dedup→false / new-turn 다시 true
- **D. mode="per-mutating" (3)**: D11/D12/D13 — every destructive→true (no dedup) / readonly→false / 5 sequential → 5 anchors
- **E. mode="per-turn" (3)**: E14/E15/E16 — after-turn true once / dedup→false on 2nd same-turn / different turnId 다시 true
- **F. withAutoCheckpoint wrap (4)**: F17/F18/F19/F20 — registerHead BEFORE inner.execute / inner throw → wrap re-throws / registerHead throw → swallowed + inner still runs / 빈 turnId → per-turn skips

모든 케이스 hand-rolled fake `ShadowOdb` + fake `EffectChannel` + fake `Tool` 로 hermetic — 실 git binary / 실 FS / 실 registry 의존 0.

## Default-OFF posture

```
config.shadowCheckpoint 부재
  ⇒ wireCheckpointedEffectChannel returns inner (short-circuit 1)
  ⇒ EffectChannel byte-identical
  ⇒ 모델 / 도구 / dispatch path 전부 변화 0
```

HELL-A2 가 정확히 이 경로를 sealing — `mode="off"` policy 로 wrap 해도 inner 와 byte-identical (extra call 0).

`shadowCheckpoint` 가 wired 됐어도 `shadowOdb` 부재면 (short-circuit 2) wrap 안 잡힘 — 잘못 설정된 페어가 legacy caller 를 깨지 않게 fail-OPEN.

## Alternatives rejected

1. **per-edit shadow file backup** (Claude Code 의 `~/.claude/file-history/` 패턴)
   - 우리 storage 는 git-commit granularity — dedupe-by-tree 가 per-file backup 의 recovery 와 동치
   - 거부 — 파일 단위 backup churn (디스크/IO) 없이 같은 recovery 성취

2. **LLM message boundary 에서 auto-checkpoint**
   - 메시지는 turn 보다 coarse — 한 turn 안의 partial-tool-call recovery 가 불가능
   - 거부 — turn boundary (per-turn 모드) 가 이미 메시지보다 fine-grain

3. **always-on with no opt-out**
   - Hermes posture (opt-in) 와 어긋남; default-OFF 가 byte-identical 보장
   - 거부 — RFC §1.2 default-OFF override

4. **anchor INSIDE the tool's execute** (도구 자체가 자기 anchor 책임)
   - plane separation 위반 (policy 는 도구 *바깥* 에 있어야 함; 도구는 storage 를 모르는 게 정상)
   - 거부 — `EffectChannel` 와이어가 정확히 그 분리를 위한 keystone

5. **registry-aware wrap (도구 객체를 wrap 이 직접 보유)**
   - wrap 이 `@/tool` registry 를 import 하면 slice fence 위반
   - 채택 = `ToolResolver` (`(name) => Tool | undefined`) 함수 주입; composition root 가 `(name) => registry.get(name)` 슬라이스 공급

6. **shouldAnchorBefore 가 record 까지 같이 처리**
   - record 호출 책임을 wrap 으로 외부화하면 wrap 이 "anchor 시도" 와 "anchor 실패" 를 구별해야 함 — 시도 단계에서 record 함으로써 dedup window 가 I/O 실패와 무관해짐 (concurrent caller 가 두 번 시도하지 않도록 안전)
   - 거부 — 현재 디자인 (`recordAnchored` 명시적 호출) 이 wrap 의 contract 를 더 narrow 하게 유지

## SOTA++ 자리매김

| 시스템 | "off" | "pre-destructive" | "per-mutating" | "per-turn" | verify-based | DI oracle | per-(ws,turn) dedup |
|---|---|---|---|---|---|---|---|
| Cline | ✗ (always on) | ✗ | **✓** | ✗ | ✗ | ✗ | ✗ |
| Hermes | ✓ (opt-in) | **✓** | ✗ | ✗ | ✗ | ✗ | ✓ (per dir) |
| Codex | ✗ | ✗ | ✗ | **✓** | ✓ | ✗ | ✓ |
| Cursor 3.2 | ✗ (always) | ✗ | ✗ | ✗ | **✓** | ✗ | N/A |
| **quanta** | **✓ default** | **✓** | **✓** | **✓** | (ADR-0122) | **✓** | **✓** |

= "shadow-ODB auto-checkpoint 의 4 SOTA 정책 (off / pre-destructive / per-mutating / per-turn) 을 단일 closed-enum 으로 노출하면서, per-(workspace,turn) dedup 과 DI destructiveness oracle 까지 갖춘 최초 OSS 구현". 4 정책 모두 default-OFF 가 byte-identical 임을 hellgate (HELL-A2) 가 sealing.

## Follow-up (이 ADR 이 닫지 않음)

- **verify-based mode** (`"on-verify-success"` arm 추가) — Codex/Cursor 의 verify boundary 정책. mark-and-anchor on verify 성공. ADR-0122 follow-up (Agent B/C round).
- **dispatch.ts 1-line 와이어** — user in-flight 작업 마치고 나서 composition root 에서 `wireCheckpointedEffectChannel` 호출.
- **OTel attribute** — `agent.checkpoint.{mode, deduped, anchor_failed}` span attribute. 자동 anchor 가 모드별로 몇 번 잡혔는지 audit.
- **registry-backed default resolver** — `(name) => registry.get(name)` 한 줄을 helper 로 expose.
- **MapBacked DedupSet eviction** — 장수 daemon 에서 turn count 가 매우 크게 자라면 LRU eviction. 현재는 세션당 turn 수 ≤ maxTurns 라 simple Set 으로 충분.
