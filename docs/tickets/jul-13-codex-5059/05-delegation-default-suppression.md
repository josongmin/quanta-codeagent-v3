# C5059-05 — Default-suppress unrequested delegation

> ## 구현 상태 (2026-07-13, feat/codex-5059-absorption) — hellaudit R2 완결성 갭 대부분 해소
> **✅ DONE (hellgate + hellaudit iterated, 111/0 green, 내 파일 tsc-clean):**
> - **SSOT를 @/shared로 이동**(slice 중립 leaf): `src/shared/delegation-policy.ts`(`DELEGATION_SUPPRESSION_POLICY` + pure `withDelegationPolicy`). @/subagent·@/tool·@/agent 전부 import 가능.
> - **knob 정식 등록(F2 해소)**: `QUANTA_SUBAGENT_DELEGATE_SUPPRESS` → `runtime-config.ts` loadFromEnv(`subagentDelegateSuppress: gateOn`) + `runtime-config/types.ts` + `knobs-a.ts` 인벤토리. **default-off 완결성 가드 통과**(직접 env-read 아니라 runtimeConfig 단일소스).
> - **팬아웃 툴 표면 4/4 배선(F1 대부분 해소)**: `agent`·`spawn_agent`·**spawn_batch**·**spawn_agents_on_csv** 전부 `*Description()`이 동일 SSOT 원자 project. 전부 default-OFF byte-identical(frozen-literal `.toBe` 4개로 추출드리프트 핀) + ON 정확조립.
> - **fc 등록**: `tools/feature-catalog/features/06-tier1/5059-subagent-delegation-suppression.yaml`, `bun fc validate` 내 항목 clean + `bun fc build`(1024 features) 반영.
> - 테스트 `subagent-delegation-suppression-hellgate.test.ts`(6/0): OFF byte-identical(4 surface frozen-literal)·ON 4-surface SSOT-lead·knob runtimeConfig·separator 정확조립. 뮤테이션-RED (a)(b)(c) 검증.
>
> **✅ 완료 — 시스템 프롬프트 fan-out 줄 게이팅 (confound 해소, 173/0 green):**
> facet `hasDelegationSuppress` 신설(`prompt-graph/types.ts` PromptContext+AtomMatcher, `contexts.ts` BASE 기본값 + body 크로스에 추가[288], `matches.ts` presenceKeys). `prompt-body.ts`에 `BODY_AFTER_PERSONA_TOOL_ROUTING_SUPPRESSED`(base에서 fan-out 3줄만 anchor-치환 파생=SSOT, 앵커 없으면 fail-loud). `atoms-body.ts`: **동일 atomId 두 mutually-exclusive variant** — `A_TOOL_ROUTING`(`when:{hasDelegationSuppress:false}`=기본=byte-identical) / `A_TOOL_ROUTING_SUPPRESS`(`when:{true}`). **런타임 배선**: `bodyRenderCtx`(prompt.ts)가 `runtimeConfig().subagentDelegateSuppress` 읽음 — env=세션상수라 static-per-session prefix 안정(ADR-0003), 캐시 무해.
> - **inert 아님 e2e 증명 + 영구 핀**: 실 `buildSystemPrompt()`가 OFF엔 `parallel_worker:true`, ON엔 `EXPLICITLY authorized` (synthetic 렌더는 inert여도 통과하므로 buildSystemPrompt 배선 테스트로 회귀 차단).
> - byte-identical-OFF: prompt-graph 288-ctx 완전성 가드 + byte-equivalence 테스트 146/0 통과.
>
> **C5059-05 완결 — 팬아웃 4/4 툴 + 시스템 프롬프트 줄 전부 한 knob(`QUANTA_SUBAGENT_DELEGATE_SUPPRESS`) 아래로. A/B confound 없음.**


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

