# ADR-0140: Background-subagent caller wire — ADR-0145 (renumbered from ADR-0130) helper를 loop에 노출

> **Note 2026-05-24**: This ADR's "ADR-0130" sibling has been renumbered to ADR-0145 (collision with `0130-extracted-source-absorption-roadmap.md`). All "ADR-0130" mentions below refer to the now-ADR-0145 background-subagent helper landing.

- **상태**: Accepted (2026-05-24)
- **관련 ADRs**: ADR-0145 (background subagent helper — sibling helper-only landing; renumbered from ADR-0130), ADR-0119 (`shadow_rewind` 첫-class tool 노출 — 동일한 caller-wire 패턴 적용 1차 사례), ADR-0125 (turn-diff wiring consolidation — deferred-wire family 통과 의례), ADR-0083 (branch-search default-OFF gate — 미러 패턴), ADR-0011 (legacy sequential subagent)
- **참조**:
  - `src/agent/types.ts` — `AgentConfig.subagentBackground?: { readonly scheduler }` slot + `FeaturesConfig` Pick 갱신
  - `src/agent/tier1/index.ts` — `buildSubagentBgBlock` 배럴 (ADR-0130에서 이미 추가)
  - `src/agent/features.ts` — `buildSessionFeatures` composer에 1-line `extraTools.push(...)` 추가
  - `src/agent/tier1/subagent-bg.ts` — ADR-0130 helper (duck-typed cast는 본 ADR로 무의미해졌으나 byte-identical 보장 위해 그대로 둠)
  - `tests/unit/subagent-background-wire-hellgate.test.ts` — 6-case 봉인 (barrel re-export / slot type / Pick type / off / on / 동일 instance)

## Context

ADR-0130은 `BackgroundSubagentScheduler` helper + 3 LLM-facing tool (`subagent_fork` / `subagent_poll` / `subagent_await`) + per-subsystem builder (`buildSubagentBgBlock`)를 plane-clean하게 착륙시켰지만, **caller wire를 의도적으로 미터치**로 남겼다 (deferred-wire posture, voice-match ADR-0124 / ADR-0128 / ADR-0125 / ADR-0119). 그 결과:

1. `AgentConfig`에 슬롯이 없어 caller가 scheduler를 주입할 typed surface가 부재 — duck-typed cast를 통해서만 통과.
2. `FeaturesConfig` Pick 멤버에 부재 → `buildSessionFeatures`의 narrow contract 외부에 머무름.
3. 결과적으로 `extraTools`에 3 tool이 절대 등재되지 않음 — helper는 존재하나 loop는 도달 불가.

ADR-0119가 ADR-0118 (shadow rewind port-level) 의 follow-up으로 정확히 같은 caller-wire를 닫았듯, 본 ADR이 ADR-0130 의 same closure를 닫는다.

## Decision

4 surgical edit. 기존 mutation 0 (`features.ts` 의 2-line composer 추가 + tier1 imports 1심볼만 예외, 둘 다 inline 주석으로 SOLID OCP 유지).

### Part 1 — `src/agent/types.ts` `AgentConfig` 슬롯 + Pick 갱신

`shadowCheckpoint` 직후 (alphabetic, top-level):

```ts
subagentBackground?: { readonly scheduler: BackgroundSubagentScheduler }
```

`BackgroundSubagentScheduler` import은 ADR-0130 helper landing 시 이미 alphabetic에 들어와 있어 import 변화 0.

`FeaturesConfig` Pick 유니온에 `"subagentBackground"` 1줄 추가 (shadowOdb 직후, alphabetic) — `buildSessionFeatures(config: FeaturesConfig)` 가 슬롯을 narrow하게 읽도록 보장.

### Part 2 — `src/agent/tier1/index.ts` 배럴

ADR-0130 helper PR에서 이미 알파벳 위치에 `export { buildSubagentBgBlock } from "./subagent-bg"` 등재. 본 ADR은 그 export가 그대로 살아있음을 hellgate로 봉인.

### Part 3 — `src/agent/features.ts` 2-line wiring

`buildShadowBlock` 호출 직후 한 줄 + 주석:

```ts
// ADR-0140 — background-subagent tools (default-OFF: empty when subagentBackground absent)
extraTools.push(...buildSubagentBgBlock(config))
```

기존 builder pipeline 의 모양은 건드리지 않음 (SOLID OCP — `buildShadowBlock` 의 호출 패턴 그대로 mirror).

Imports은 `tier1` barrel의 알파벳 위치에 `buildSubagentBgBlock` 1심볼 추가.

### Part 4 — 6-case hellgate (이미 작성됨)

`tests/unit/subagent-background-wire-hellgate.test.ts`:

- **(1)** tier1 barrel re-export 봉인 (`buildSubagentBgBlock` 타입 검사)
- **(2)** `AgentConfig.subagentBackground` 슬롯 type-shape 봉인 (compile-time assignment)
- **(3)** `FeaturesConfig` Pick 유니온이 `"subagentBackground"` 포함함 봉인 (compile-time)
- **(4)** 슬롯 부재 ⇒ 3 tool이 `extraTools` 에 없음 (default-OFF byte-identical)
- **(5)** 슬롯 wired ⇒ 3 tool 모두 `extraTools` 에 등재
- **(6)** wired tool이 동일 scheduler 인스턴스에 바인딩됨 (fork → poll observable)

## Default-OFF posture

```
config.subagentBackground 부재
  ⇒ buildSubagentBgBlock(config) returns []
  ⇒ extraTools 변화 0
  ⇒ ToolRegistry byte-identical
  ⇒ 모델은 3 tool 의 존재 자체를 모름 (tool catalog 에 없음)
```

`shadowOdb` (ADR-0116/ADR-0119) 와 정확히 동일한 default-OFF 게이트. assembly auto-registration 없음 — 호출자가 의식적으로 `config.subagentBackground = { scheduler: defaultBackgroundSubagentScheduler({runner}) }` 박을 때만 활성.

## Alternatives rejected

1. **`AgentConfig.subagent` 블록에 nest** (`subagent.background?`).
   - `subagent` block은 sequential subagent (ADR-0011) 의 enable + filter. background scheduler는 INTENT-DISTINCT — caller가 sequential 없이 background만 wire할 수 있어야 함 (e.g. CI long-poll surface).
   - 거부 — top-level slot 으로 두 capability를 직교화.

2. **`subagent-bg.ts` 의 duck-typed cast 제거 + 직접 `config.subagentBackground` 읽기**.
   - 본 ADR이 슬롯을 type-level에 등재하므로 더 이상 cast가 필요 없음.
   - 그러나 helper 모듈은 본 ADR과 독립적으로 byte-identical을 보장해야 함 (helper-only landing의 deferred-wire 원칙). cast 코드는 `AgentConfig & SubagentBackgroundConfigSlot` 의 union이 새 슬롯과 structurally compatible이라 그대로 동작 — 제거는 cosmetic이며 follow-up.
   - 채택 = cast 유지 (helper 모듈 미터치, ADR 분리 원칙 유지).

3. **`buildSessionFeatures` 외부에서 wire** (예: `apps/agent/assemble.ts` 가 직접 `subagentBgTools(scheduler)` 호출).
   - tier1 builder pattern을 우회 → 다른 Tier-1 capability와 inconsistent. composer가 single materialization seam인 contract 위반.
   - 거부 — composer 내부에서 mirror pattern.

4. **scheduler를 `apps/agent` bootstrap에서 자동 생성**.
   - default-OFF 원칙 위반. 모든 caller에 background scheduler가 silently 생성됨 → ToolRegistry 변화. ADR-0130 의 "auto-wire 안 함" 명시 위반.
   - 거부 — caller가 의식적으로 inject. bootstrap helper는 별도 follow-up.

## SOTA++ 자리매김

ADR-0130의 helper-only landing이 surface 자체를 SOTA++ 위치에 놓았다 (Cursor `force_background_subagent` + typed error code + list/prune). 본 ADR은 그 helper를 loop에 도달 가능하게 만드는 closure — caller-wire가 닫혀야 SOTA++가 비로소 *실현*된다. ADR-0118 → ADR-0119 의 closure 페어와 동일한 패턴.

## Follow-up (이 ADR이 닫지 않는 것)

- **`apps/agent` bootstrap helper** — opt-in builder (`withBackgroundSubagent(config, {runner})`) 로 ergonomic wire. 본 ADR은 raw slot만 노출.
- **`subagent-bg.ts` duck-typed cast cleanup** — 이제 type-level 슬롯이 있으므로 cast 제거 가능 (cosmetic refactor).
- **CLI `/spawn-bg` slash command** — long-running task detach UX (ADR-0130 follow-up와 동일).
- **plan-queue integration** (ADR-0128) — `pausedReason="subagent_running"` 을 scheduler의 running list와 sync.
- **persistent scheduler** — process restart 살아남게 snapshot store 패턴.
