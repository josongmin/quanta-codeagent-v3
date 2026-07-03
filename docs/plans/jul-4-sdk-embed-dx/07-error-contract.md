# Phase 7 — 에러 / 결과 계약

## 기능 / 왜

- (기능) 던지는 에러 taxonomy + `AgentOutcome`/`StopReason` 재수출.
- (왜) 소비자가 try/catch에서 뭘 잡을지, 결과의 `reason`을 어떻게 narrow할지 타입세이프하게.

## Tasks

7.1 **에러 클래스** `src/sdk/errors.ts`:
   - `NoCredentialError` — llm/apiKey/env 전무(Phase 2.3).
   - `AgentAbortedError` — signal/abort()로 중단.
   - `ToolRegistrationError` — 중복 name 등 registry 조립 실패(Phase 5).
   - 각 `name` 고정 + `instanceof` 가능.
7.2 **결과 재수출** — `AgentOutcome`(`reason, turns, messages, stopCategory?`), `StopReason`(`"completed"|"max_turns"|"aborted"|"error"`) 공개 문 노출([agent-outcome.ts:77](../../../src/agent/types/agent-outcome.ts)). `stopCategory`는 옵셔널 rich "왜".
7.3 **abort 매핑** — `agent.abort()` → 내부 signal → `outcome.reason==="aborted"` (throw 아님, `AgentAbortedError`는 pre-run 경로만).

## Hellgate

- RED: `errors.test.ts` — 각 에러 조건 재현 + outcome.reason 판별.
- 적대 어딧 R1-3: (a) abort가 throw인지 outcome인지 일관, (b) 에러 클래스가 dist에서 `instanceof` 유지(tsc target), (c) StopReason 유니온 완전성.

## Acceptance

- [ ] 크레덴셜 없음 → `NoCredentialError` throw.
- [ ] `abort()` → `outcome.reason==="aborted"`.
- [ ] `reason` switch exhaustive 타입체크.

## Files

- `src/sdk/errors.ts` (신설), `src/sdk/types.ts` (outcome 재수출)
- `tests/unit/sdk/errors.test.ts` (신설)
