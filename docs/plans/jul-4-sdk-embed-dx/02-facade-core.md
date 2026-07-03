# Phase 2 — façade 코어 `createAnalysisAgent`

## 기능 / 왜

- (기능) 133필드 AgentConfig를 ~10필드 옵션으로 감싼 진입 함수.
- (왜) 소비자가 `runAgent` 조립 세부(base 9필드 + 27 optional slot)를 몰라도 되게.

## Tasks

2.1 **`src/sdk/embed.ts`** — `createAnalysisAgent(opts): AnalysisAgent`.
   - `@/host/runtime/agent-config-assembler#assembleAgentConfig(req, env)` 직접 사용(어딧 G: apps/agent shim 금지).
   - required core 조립(MASTER §C): `llm, registry, stream, permission, messages, system, cwd, maxTurns, signal`.
   - optional wire-slot은 프로파일(Phase 4)이 결정 — Phase 2는 전부 미주입(OFF).
2.2 **옵션 타입** `AnalysisAgentOptions` — 공개 문 re-export 타입만 참조(어딧 C).
2.3 **LLM 주입 first-class**: `opts.llm` 우선 → 없으면 `pickProvider(env)`+`tryCreateLLM(provider,{model,apiKey},env)` → null이면 `NoCredentialError`(Phase 7).
2.4 **기본값**: `system ??= buildSystemPrompt(cwd)`, `maxTurns ??= 200`, `registry = new ToolRegistry([...tools?, ...(includeDefaultTools ? buildDefaultTools() : [])])`, `signal`은 내부 AbortController(→ `agent.abort()`).

## 계약 (verified 시그니처)

- `runAgent(cfg: AgentConfig): Promise<AgentOutcome>` (`loop/entry.ts:12`)
- `assembleAgentConfig(req, env)`: `req={mode, base, ...}` → `base: RuntimeAgentConfigBase`, adds modePolicy+budgetMeter (`agent-config-assembler.ts:39,832`)
- `tryCreateLLM(provider, CreateLLMOptions, env): LLMPort|null` (`llm/factory.ts:540`)
- `buildSystemPrompt(cwd)`, `buildDefaultTools()`, `ToolRegistry` (`@/agent`, `@/tool`)

## Hellgate

- RED: `embed.test.ts` — fakeLlm 물린 `createAnalysisAgent().run("hi")`가 `outcome.reason` 반환(Phase 6 하네스 선행 or 인라인 fake).
- 적대 어딧 R1-3: (a) base 필수필드 누락 시 tsc 에러(빈틈), (b) 크레덴셜 3소스(llm/apiKey/env) 우선순위, (c) mode 미지정 시 기본 프로파일.

## Acceptance

- [ ] `createAnalysisAgent({cwd,model,llm:fake}).run("x")` → `AgentOutcome`.
- [ ] llm/apiKey/env 전무 → `NoCredentialError`.
- [ ] tsc·biome green (sdk paths).

## Files

- `src/sdk/embed.ts`, `src/sdk/types.ts` (신설)
- `tests/unit/sdk/embed.test.ts` (신설)
