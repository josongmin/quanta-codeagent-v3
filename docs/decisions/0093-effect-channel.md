# ADR-0093: EffectChannel — relocatable effect boundary (M1 keystone)

- **상태**: Accepted (pure module + tests shipped, dispatch 배선은 follow-up)
- **출처**: [cursor-sota 구조 제안](../analysis/code-agent-loop/cursor-gap-plan.md) §2 "가장 중요한 단일 구조적 move" + Cursor `ExecServerMessage`/`ExecClientMessage` exec-delegation 흡수
- **참조**: [cursor.md](../analysis/code-agent-loop/cursor.md) §1, [cursor-deep-dives.md](../analysis/code-agent-loop/cursor-deep-dives.md)

## Context

quanta 현재 loop는 *decide*(orchestration: permission/HITL/plan-exit/hook)와 *do*(effect: `registry.run`)가 같은 함수 안에서 결합돼 있다. [src/agent/dispatch.ts](../../src/agent/dispatch.ts)의 `execute(call, config, ctx, onProgress)`(라인 333-370)가 `config.registry.run(...)`을 직접 호출 → effect가 loop와 같은 프로세스에 못박혀 있음.

Cursor의 구조적 교훈(`cursor-agent-exec`의 `ExecServerMessage`/`ExecClientMessage` oneof) = **엔진은 effect를 실행하지 않고, 같은 bidi stream에 typed exec 메시지로 클라에 위임한다.** 그 단일 경계가 execution을 **relocatable** 하게 만든다 — local in-process / sandboxed / remote worker, loop가 어디든 모름.

quanta는 server가 없지만 **같은 *구조적* 경계**를 만들 수 있다. server-blackbox 없이 typed·inspectable로.

## Decision

신규 plane-clean 모듈 `src/agent/effect-channel.ts`:

```ts
interface ToolRequest { readonly call: ToolUseBlock; readonly ctx: ToolContext; readonly execId?: string }
interface ToolResultEnvelope { readonly result: ToolResult; readonly durationMs: number; readonly execId?: string }
interface ToolExecutor { execute(call, ctx, onProgress?): Promise<ToolResult> }   // DI port
interface EffectChannel { execute(req, onProgress?): Promise<ToolResultEnvelope> }

class LocalEffectChannel implements EffectChannel { constructor(executor: ToolExecutor) ... }
```

**경계 의도**:
- Orchestration plane(dispatch/admissibility-gate) ──`ToolRequest`──► EffectChannel ──`ToolResultEnvelope`──► Orchestration
- 구현 swap만으로 substrate 변경: `LocalEffectChannel`(M1 default) → `SandboxEffectChannel`(Phase 2, wraps Local + `SandboxPolicy` 적용) → `RemoteEffectChannel`(future, PtyHost/cloud worker).
- 같은 call site, orchestration plane은 substrate를 모름.

**계약 (5)**:
1. **No-throw.** executor 예외(`Error`/non-Error) → `{ok:false, output: <msg>}` 정규화. dispatch.ts의 기존 no-throw 계약(AUDIT-FIX) 미러링 → streaming-dispatch의 allSettled 가정 유지.
2. **Pre-flight abort.** `req.ctx.signal.aborted` 진입 시 executor 호출 안 함, `{ok:false, output:"aborted..."}` 반환. loop의 cooperative cancel과 일치.
3. **`exactOptionalPropertyTypes`.** optional 필드(`execId`)는 absent면 envelope에서 **OMITTED**(never `field: undefined`). condition-spread 패턴.
4. **Pure passthrough.** `req.call`/`req.ctx`는 executor에 reference로 전달(clone/augmentation 없음). 채널은 input 검사 안 함 — orchestration plane 책임.
5. **Duration.** `durationMs` = non-negative integer (`Math.max(0, Math.round(...))`). 채널 진입 ~ executor 반환/throw.

## Default-OFF

**아무도 현재 LocalEffectChannel을 import하지 않음.** 채택은 follow-up:
- `dispatch.ts`의 `execute()`(라인 333-370) body를 `new LocalEffectChannel({execute: (call,ctx,op) => config.registry.run(call.name, call.input, ctx, op)}).execute({call, ctx})`로 wrap
- 채널의 정규화가 기존 `execute()`의 try/catch와 정확히 미러링 → registry-throw 경로 byte-identical
- 현재 redaction / typed-failure / evidence flattening은 **orchestration plane에 남음** — `dispatchToolInner`가 envelope를 `DispatchResult`로 wrap. 그게 plane 분리의 요점: 채널은 raw `ToolResult`+duration 반환, dispatch가 결과 처리.

## What this is NOT

- ❌ tool registry 아님. 채널은 `@/tool` registry / `@/permission` 0 import. executor를 DI로 받음.
- ❌ redaction / typed-failure surfacing / evidence flattening 하는 곳 아님. 그건 dispatch-layer concern.
- ❌ streaming primitive 아님. 진행 이벤트는 기존 `onProgress` callback(registry.run과 같은 모양). future BiDi/server-stream 변종은 이걸 wrap 가능. 오늘은 기존 호출 모양 보존 → 채택이 mechanical.

## Tests (TDD red→green)

[tests/unit/agent/effect-channel.test.ts](../../tests/unit/agent/effect-channel.test.ts) — **18 tests / 0 fail / 31 expects**. 5개 contract 전수 + interface compile-level + concurrency:
- Happy path: delegation/duration/sequential/concurrent
- No-throw: Error throw / non-Error throw / explicit ok:false passthrough
- Passthrough: call/ctx by reference / onProgress forwarding / onProgress-absent → executor sees undefined
- execId: surfaces verbatim / OMITTED when absent (exactOptional) / survives no-throw path
- Pre-flight abort: aborted signal → executor NOT called, ok:false
- Interface contract: `LocalEffectChannel` assignable to `EffectChannel`

회귀 가드: `bun test tests/unit/agent/` → **439 pass / 0 fail / 1214 expects** (27 파일).

## Alternatives rejected

1. **`execute()` 그대로 두기**: effect가 loop에 못박힘. sandbox/remote substrate 도입 시 dispatch 광범위 refactor 필요. 채널은 그 비용을 단일 경계로 prepay.
2. **AsyncIterable<EffectEvent> streaming 채널**: BiDi 우월하나 기존 `onProgress` 호출부 광범위 변경. M1은 채택 mechanical 우선; M3+에서 wrap 가능.
3. **registry를 직접 import한 LocalEffectChannel**: 테스트에 fake 못 끼움. DI executor가 plane-clean(orchestration이 wrap) + testable.
4. **dispatch.ts 직접 편집해서 즉시 적용**: high-WIP 파일(현재 라인 195-212에 `onInputMutation` 같은 다른 흐름 진행 중). 별도 keystone module로 분리 → 사용자 WIP와 충돌 0, byte-identical 보장(채택 시점 검증).

## Follow-up (이 ADR이 닫지 않는 것)

- **M1 wiring**: dispatch.ts `execute()`를 LocalEffectChannel로 wrap. 별도 ADR(추후).
- **M2 SandboxEffectChannel**: `SandboxPolicy` 적용 wrapper. Phase 2.
- **M3 RemoteEffectChannel**: PtyHost/cloud worker. Phase 3.

## SOTA++ 자리매김

이 채널이 quanta SOTA 자세의 키스톤:
- Cursor = 서버 blackbox(엔진→클라 exec 위임이 서버에 hide됨)
- **quanta = typed·inspectable·relocatable EffectChannel** (모든 substrate가 local로 inspectable한 채로 swap).

= "서버에 숨겼던 것을 typed·local·inspectable로 노출한 감사가능 런타임"의 **첫 번째 평면 분리**.
