# C5059-05 — Default-suppress unrequested delegation

> ## 구현 상태 (2026-07-13, feat/codex-5059-absorption) + hellaudit 결과
> **DONE (hellgate RED→GREEN, 3-lens 적대어딧):**
> - SSOT 정책 원자 `src/subagent/delegation-policy.ts`(`DELEGATION_SUPPRESSION_POLICY` + `withDelegationPolicy` + knob `QUANTA_SUBAGENT_DELEGATE_SUPPRESS`, default-OFF).
> - 2 primary 툴 배선: `agent`(`agent-tool.ts` `agentToolDescription()`) + 6-tool `spawn_agent`(`agent-tools-6.ts` `spawnAgent6Description()`). 둘 다 동일 SSOT 원자 project(패러프레이즈 0).
> - 테스트 `tests/unit/subagent-delegation-suppression-hellgate.test.ts`(6/0). **OFF byte-identical 검증됨**(어딧 R1: 두 description char-단위로 HEAD와 동일, drift 0). 하드닝: ON 정확조립 `.toBe`(separator 잡음) + OFF frozen-literal `.toBe`(추출 드리프트 잡음). 뮤테이션-RED (a)(b)(c) 확인.
>
> **⛔ 미완 — hellaudit F1 완결성 갭 (A/B 전 필수, 안 하면 confounded):**
> 정책이 팬아웃 표면 2/4만 커버. 나머지가 여전히 팬아웃 권장 → 모델이 안 눌린 쪽 사용 + A/B 오염:
> 1. **🔴 시스템 프롬프트 본문 `BODY-TOOL-ROUTING` atom** (`src/agent/prompt-graph/atoms-body.ts:295-304`, `when:` 없어 무조건 렌더): "fan out ... `parallel_worker:true`"를 명시 권장 → **툴은 억제/프롬프트는 권장 = 직접 모순, 최우선 confound.** 단 prompt-graph는 byte-identical 스냅샷/ADR-0410 민감 → 자체 RED로 신중히.
> 2. **spawn_batch** (`src/tool/subagent-batch/batch.ts:246`) + **spawn_agents_on_csv** (`src/tool/spawn-agents-csv/index.ts:79`): "Fan out one child per item/row" — 미배선. ⚠️ **@/tool은 @/subagent를 import 못 함(slice 경계)** → 이 둘 배선하려면 `delegation-policy.ts`를 `@/shared`(중립 leaf)로 이동해야 함(SSOT 유지 리팩터).
> 3. **🟡 F2 knob 미등록**: `QUANTA_SUBAGENT_DELEGATE_SUPPRESS`가 runtime-config 인벤토리(`knobs-a.ts`) 미등록 → `knob-default-off-completeness-guard` 우회. 자매 knob `QUANTA_SUBAGENT_TYPED_KIND`처럼 등록 + `gateOn` 경유로 전환.
>
> **권고 순서:** SSOT를 @/shared 이동 → batch/csv 배선(4/4 툴) → prompt-atom knob-gate(자체 RED) → knob 등록. 이후에만 A/B 유효.


- **Priority:** P0
- **Class:** TRUE-GAP
- **Effort:** S
- **Status:** READY
- **Dependencies:** none

## Goal

Use one prompt-policy source to make single-agent execution the default and allow subagent fan-out only when delegation is explicitly authorized and the work is structurally parallel.

## Current defect

The `agent` tool description recommends running many children, while neither the system prompt nor the 6-tool `spawn_agent` contract states when delegation is prohibited. This biases routine analysis toward unnecessary fan-out.

## Policy

Do not spawn unless the user, applicable repo rules, or an activated skill explicitly asks for subagents, delegation, or parallel agent work. Requests for depth, research, investigation, thoroughness, or detailed analysis are not authorization.

When delegation is authorized, spawn only if:

- subtasks are independent and meaningful;
- write sets are disjoint or children are read-only;
- parent synthesis ownership is explicit;
- expected wall-time benefit exceeds coordination cost.

## Ownership

- Put policy text in one prompt atom/directive SSOT, not duplicated across tool descriptions.
- `agent` and `spawn_agent` descriptions should describe mechanics. Any fan-out sentence must begin with the condition that delegation is already authorized.
- Wire the policy only when a subagent surface is exposed; do not add irrelevant prompt bytes to sessions without subagent tools.

## Rollout

1. Add an opt-in measurement arm first.
2. Compare current fan-out-biased prompt vs suppression policy.
3. If acceptance holds, make suppression the default and retain an explicit host override for dedicated multi-agent experiments.

## Metrics

- unauthorized/unnecessary spawn rate;
- task and verifier success;
- total tokens and wall time;
- duplicated exploration;
- write collisions/merge conflicts;
- child error propagation;
- parent synthesis failure;
- useful parallelism rate for explicitly authorized tasks.

## Acceptance

- A normal “inspect this deeply” case performs zero spawn.
- Explicit “use parallel subagents” still exposes and uses the existing fan-out paths.
- Repo/skill authorization is honored without requiring duplicate user text.
- Sequential tasks do not lose success rate.
- Explicitly parallel tasks retain useful wall-time improvement.
- Prompt snapshots prove the policy appears exactly once and default-OFF/override variants are deterministic.

## Non-goals

- Runtime prohibition of all model-initiated delegation.
- Removing subagent tools or concurrency support.
- Changing immediate slot-release semantics.
- Building a new orchestrator.

