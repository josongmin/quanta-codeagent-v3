# Implementation Plan — Public Runtime SDK

- **상태**: Draft (depends on `00-rfc.md` acceptance)
- **날짜**: 2026-05-26
- **관련**: [00-rfc.md](./00-rfc.md), ADR-0299, ADR-0303, ADR-0308

이 문서는 public runtime SDK RFC를 코드 변경 단위로 분해한다. 목표는 **브레이킹 전제** 하에서 thin internal API를 protocol-first SDK로 전환하는 것이다.

---

## 1. 최종 모듈 토폴로지

```text
src/
  protocol/
    session/
      version.ts
      commands.ts
      events.ts
      snapshot.ts
      capabilities.ts
      errors.ts
      codec.ts
      index.ts

  kernel/
    session/
      state.ts
      reducer.ts
      scheduler.ts
      event-log.ts
      lease.ts
      replay-lite.ts
      ports.ts
      index.ts

  host/
    runtime/
      builder.ts
      session-host.ts
      capabilities.ts
      operator-review.ts
      tool-executor.ts
      persistence.ts
      trace-adapter.ts
      index.ts

  sdk/
    runtime/
      create-runtime.ts
      runtime.ts
      session.ts
      subscription.ts
      types.ts
      index.ts

  ipc/
    session/
      bridge.ts
      stdio-server.ts
      stdio-client.ts
      websocket-server.ts
      websocket-client.ts
      index.ts

  apps/
    cli/
      index.ts
      repl/
        prompt-encode.ts
        event-render.ts
        slash-parse.ts
        session-client.ts
    headless/
      index.ts
    bench/
      index.ts
      driver/
        run-corpus.ts
        run-instance.ts
        verdict.ts
        report.ts
```

### 원칙

- `src/apps/shared` 는 만들지 않는다.
- reusable logic은 `protocol`, `kernel`, `host`, `sdk`, `ipc` 하위에만 둔다.
- `runner/*` 와 `host/bootstrap/*` 는 migration 기간 동안 compatibility layer로 유지하되 최종적으로 internal-only가 된다.
- `apps/web`, `apps/native` 는 실제 consumer가 생기기 전까지 placeholder 디렉토리로 만들지 않는다.
- capability manifest는 caller 입력이 아니라 host port에서 **유도**한다.
- command/event envelope는 first release부터 `commandId` / `expectedRevision` / `seq` / `revision` 을 가진다.

---

## 2. 현재 코드에서 재사용할 seed와 폐기할 계약

### 2.1 재사용 seed

| 현재 파일 | 재사용 방향 |
|---|---|
| `src/host/bootstrap/bootstrap-session.ts` | host runtime builder seed |
| `src/runner/orchestrate/run-once.ts` | kernel scheduler seed |
| `src/runner/orchestrate/run-interactive.ts` | session run loop logic seed |
| `src/runner/assemble/session-state.ts` | kernel-owned live state seed |
| `src/apps/headless/index.ts` | second-consumer parity proof seed |
| `src/shared/jsonrpc/*` | remote transport wire seed |
| `src/ipc/transports/*` | transport adapter seed |

### 2.2 최종적으로 public contract에서 제거할 것

| 현재 계약 | 처리 |
|---|---|
| `runInteractive(...)` | internal-only or deleted |
| `PromptSource` | CLI-only adapter |
| `SessionDeps` | internal kernel/host glue only |
| `assembleConfig(...)` | internal config composer |
| slash registry를 통한 runtime mutation | command encoder로 대체 |
| `apps/headless` 의 boot+deps 직접 조합 | SDK consumer로 재작성 |
| approval callback를 public seam으로 노출 | command/event protocol로 대체 |
| caller-authored capability truth | validation-only로 강등 |
| session 밖 product/ops workflow를 runtime에 집어넣음 | 상위 driver/service ownership 유지 |

### Admission rule

새 기능은 구현 전에 먼저 분류한다.

session SDK로 들어갈 수 있는 조건:

1. `SessionCommand` 로 시작할 수 있다.
2. 필요 state가 `kernel/session` SSOT로 들어간다.
3. side effect는 `host/runtime` capability로 닫힌다.
4. 결과가 `SessionEvent` / `ArtifactRef` 로 관찰된다.
5. 단일 session 경계 안에서 완결된다.

하나라도 어기면 상위 계층으로 뺀다.

대표 예외:

- benchmark corpus management
- multi-session orchestration
- account/auth/billing
- org-level policy admin
- product-specific workflow chrome

---

## 3. 파쇄 순서

순서는 strict하다. protocol 이전에 surface rewrite를 시작하면 다시 drift가 난다.

### Wave 0 — RFC + ADR alignment

**목표**

- public SDK target을 문서로 고정
- ADR-0303 thin 기준과 충돌하지 않게 용어 정리

**작업**

- RFC 본문 + implementation plan 추가
- 필요 시 ADR-0303에 "public SDK는 render-only target의 중간 단계가 아님, protocol/kernel ownership이 선행" 문구 보강

**산출물**

- 문서 only

---

### Wave 1 — Protocol spine

**목표**

public contract를 먼저 고정한다.

**신규 파일**

- `src/protocol/session/version.ts`
- `src/protocol/session/commands.ts`
- `src/protocol/session/events.ts`
- `src/protocol/session/snapshot.ts`
- `src/protocol/session/capabilities.ts`
- `src/protocol/session/errors.ts`
- `src/protocol/session/codec.ts`
- `src/protocol/session/index.ts`

**핵심 결정**

- command union 닫기
- event union 닫기
- command envelope metadata 고정 (`sessionId`, `commandId`, `issuedAt`, `expectedRevision?`)
- event envelope metadata 고정 (`eventId`, `seq`, `revision`, `emittedAt`, `causedByCommandId?`)
- approval protocol 고정 (`approval.requested` / `approval.respond` / `approval.resolved`)
- artifact reference shape 고정 (`ArtifactRef`)
- snapshot-lite 최소 shape 고정
- version negotiation shape 고정

**검증**

- protocol golden tests
- codec roundtrip tests
- command revision conflict tests
- approval protocol roundtrip tests
- artifact reference fixture tests
- no `apps/**`, no `process.*` lint

**병렬화**

- Lane A: commands/events/errors
- Lane B: snapshot/capabilities/version
- Lane C: codec/golden tests

write set이 분리되므로 병렬 가능.

---

### Wave 2 — Kernel session state machine

**목표**

later-turn behavior를 kernel store 하나로 수렴시킨다.

**신규 파일**

- `src/kernel/session/state.ts`
- `src/kernel/session/reducer.ts`
- `src/kernel/session/scheduler.ts`
- `src/kernel/session/event-log.ts`
- `src/kernel/session/lease.ts`
- `src/kernel/session/replay-lite.ts`
- `src/kernel/session/ports.ts`
- `src/kernel/session/index.ts`

**구현 포인트**

- `applyCommand(state, cmd, host)` reducer
- per-turn scheduler
- event emission ordering
- single-writer lease
- append-only event log
- replay-lite from snapshot + event tail
- monotonic clock port injection (`Date.now()` 직접 사용 금지)
- approval pending state and resolution state transition
- artifact registry / open-artifact state transition

**현재 코드 흡수**

- `run-once.ts` 일부 → scheduler
- `run-interactive.ts` 의 loop control 일부 → scheduler / command application
- `assemble/session-state.ts` → kernel state stores

**검증**

- reducer unit tests
- replay-lite consistency tests
- single-writer lease tests
- event ordering tests
- monotonic clock port tests
- stale `expectedRevision` reject tests

**병렬화**

- Lane A: reducer/state
- Lane B: scheduler/event log
- Lane C: replay-lite/lease/tests

`scheduler` 와 `replay` 가 state model에 의존하므로 A 선행, B/C는 A baseline 위에서 병렬.

---

### Wave 3 — Host runtime builder

**목표**

host concerns를 capability-oriented runtime builder로 재구성한다.

**신규 파일**

- `src/host/runtime/builder.ts`
- `src/host/runtime/session-host.ts`
- `src/host/runtime/capabilities.ts`
- `src/host/runtime/operator-review.ts`
- `src/host/runtime/tool-executor.ts`
- `src/host/runtime/persistence.ts`
- `src/host/runtime/trace-adapter.ts`
- `src/host/runtime/index.ts`

**구현 포인트**

- `bootstrapSession` 책임을 capability builder로 분해
- llm/tool/shell/fs/persistence/operator review binding
- capability manifest derivation + freeze
- host-generated artifact refs
- operator-review port를 approval protocol consumer로 하향 연결

**현재 코드 흡수**

- `src/host/bootstrap/*`
- `src/apps/cli/repl/session-host-ports.ts` 의 host port concept
- 일부 `session-deps-compose.ts` host-owned port build logic

**검증**

- host builder smoke tests
- capability negotiation tests
- fail-closed missing capability tests
- caller-supplied expected capability mismatch tests

**병렬화**

- Lane A: LLM/tool/shell/fs capability binding
- Lane B: persistence/review/trace capability binding
- Lane C: capability manifest tests

---

### Wave 4 — SDK facade + in-proc transport

**목표**

surface가 소비할 first-class Runtime / Session API를 만든다.

**신규 파일**

- `src/sdk/runtime/create-runtime.ts`
- `src/sdk/runtime/runtime.ts`
- `src/sdk/runtime/session.ts`
- `src/sdk/runtime/subscription.ts`
- `src/sdk/runtime/types.ts`
- `src/sdk/runtime/index.ts`

**public API**

- `createRuntime(opts)`
- `runtime.createSession(opts)`
- `session.dispatch(cmd)`
- `session.subscribe(fn)`
- `session.snapshot()`
- `session.close()`
- `runtime.close()`

**구현 포인트**

- in-proc direct transport
- host-derived capability manifest exposure
- multi-observer fanout
- small bounded event buffering only
- explicit close/dispose discipline

**검증**

- SDK smoke tests
- multi-observer tests
- snapshot consistency tests
- runtime.close resource teardown tests
- approval command/event lifecycle tests

**병렬화**

- Lane A: runtime/session facade
- Lane B: event subscription and backpressure
- Lane C: type surface + smoke tests

---

### Wave 5 — Surface rewrite

이 wave부터 실제 consumer cutover다. kernel/host/sdk baseline이 먼저 있어야 한다.

#### Lane A — CLI

**목표**

CLI를 SDK consumer로 재작성한다.

**주요 변경**

- `src/apps/cli/repl/prompt-pipeline.ts`
  - `PromptSource` producer가 아니라 command encoder
- `src/apps/cli/repl/slash-surface.ts`
  - runtime authority 제거, command/snapshot adapter로 축소
- `src/apps/cli/repl/session-setup.ts`
  - `SessionSetupResult` assembly 대신 SDK session client setup
- `src/apps/cli/repl/session-loop.ts`
  - `runInteractive(...)` 호출 제거, `session.dispatch`/`session.subscribe` 사용

**종료조건**

- CLI는 SDK consumer
- slash는 command encoder
- render는 event/snapshot consumer
- approval UX는 `approval.requested` / `approval.respond` 위에서만 동작

#### Lane B — Headless

**목표**

headless second consumer proof를 SDK consumer로 재작성한다.

**주요 변경**

- `src/apps/headless/index.ts`
  - bootstrap + deps compose 직접 호출 제거
  - `createRuntime` + `createSession` 사용

**종료조건**

- headless proof가 SDK contract 자체를 검증
- direct `bootstrapSession + runOnce` consumer가 아님

#### Lane C — Batch

**목표**

batch를 same-session runtime 위로 올린다.

**주요 변경**

- `src/apps/bench/index.ts`
- `src/runner/batch/*` 또는 후속 `src/apps/bench/driver/*`
  - per-instance session create
  - command dispatch
  - event capture
  - verdict/report는 batch layer가 유지

**종료조건**

- batch는 SDK session consumer
- reusable agent logic은 batch layer 밖
- verdict/report/corpus 책임은 batch driver에 유지

**검증**

- CLI/headless parity rails
- batch parity rails
- zero regression on predictions/report schema

---

### Wave 6 — Wire transports

**목표**

in-proc 외 transport를 붙인다.

**신규/확장 파일**

- `src/ipc/session/bridge.ts`
- `src/ipc/session/stdio-server.ts`
- `src/ipc/session/stdio-client.ts`
- `src/ipc/session/websocket-server.ts`
- `src/ipc/session/websocket-client.ts`

**구현 포인트**

- protocol ↔ JSON-RPC bridge
- stdio session server
- websocket session bridge
- reconnect-safe event sequencing
- `seq` / `revision` / `eventId` 기반 dedupe

**현재 코드 재사용**

- `src/shared/jsonrpc/*`
- `src/ipc/transports/stdio.ts`
- `src/ipc/transports/websocket.ts`

**검증**

- transport conformance suite
- reconnect / multi-observer tests
- parity: in-proc vs stdio vs websocket

---

### Wave 7 — Old API removal and exact lint

**목표**

old internal contract를 public path에서 완전히 제거한다.

**삭제/격하 대상**

- public export of `runInteractive`
- public export of `PromptSource`
- public export of `SessionDeps`
- public reliance on `assembleConfig`
- public reliance on host callback approval seam
- direct consumer path using `bootstrapSession + composeSessionDeps + runOnce`

**구조 guard**

- `@/protocol/**` no app import
- `@/kernel/**` no `process.*`
- `@/sdk/**` no app import
- public API leak scanner for `SessionDeps`, `AgentConfig`, `PromptSource`, `assembleConfig`, `runInteractive`
- no caller-authored capability truth in public API
- slash-state authority hellgate stays green

**종료조건**

- SDK facade만 surface entry
- old path는 internal-only or removed

---

## 4. 세부 파일 inventory

### 4.1 신규 파일 수

예상:

- protocol: 8
- kernel: 8
- host/runtime: 8
- sdk/runtime: 6
- ipc/session: 6

총 신규 핵심 파일: 약 37개

### 4.2 대규모 수정 파일

| 파일 | 수정 방향 |
|---|---|
| `src/apps/cli/repl/session-loop.ts` | runner 중심 orchestration 제거, sdk consumer화 |
| `src/apps/cli/repl/session-setup.ts` | bootstrap wrapper에서 sdk client setup으로 축소 |
| `src/apps/cli/repl/prompt-pipeline.ts` | prompt source → command encoder |
| `src/apps/cli/repl/slash-surface.ts` | runtime adapter only |
| `src/apps/headless/index.ts` | direct host/runner consumption 제거 |
| `src/apps/bench/index.ts` | batch runtime client화 |
| `src/apps/agent/mode-presets/interactive.ts` | sdk-backed tty wrapper or 제거 |
| `src/host/bootstrap/*` | compatibility layer or host/runtime로 분해 |
| `src/runner/orchestrate/*` | kernel internal helper or compatibility layer |
| `src/runner/assemble/config.ts` | internal-only projection layer |
| `src/apps/cli/repl/session-host-ports.ts` | public approval/input seam 정리, SDK adapter only |

### 4.3 삭제 후보

| 항목 | 조건 |
|---|---|
| `runInteractive` public exposure | CLI/headless cutover 후 |
| `PromptSource` public exposure | CLI command encoder 완료 후 |
| direct `SessionDeps` composition outside internal modules | SDK consumers cutover 후 |
| `apps/agent` mode-presets direct orchestration path | SDK route 안정화 후 |
| approval callback public exposure | approval protocol cutover 후 |

---

## 5. 병렬 lane 운영 계획

### Wave 1-2

- Worker A: protocol types + codec
- Worker B: kernel reducer + state
- Worker C: replay-lite/lease/event-order tests

### Wave 3

- Worker A: host capability binding
- Worker B: persistence/review/tracing binding
- Worker C: host smoke + fail-closed tests

### Wave 4

- Worker A: sdk facade
- Worker B: subscription/backpressure
- Worker C: in-proc client tests

### Wave 5

- Worker A: CLI rewrite
- Worker B: headless rewrite
- Worker C: batch rewrite

이 wave가 가장 병렬성이 높다. write set을 겹치지 않게 유지해야 한다.

### Wave 6

- Worker A: stdio transport
- Worker B: websocket transport
- Worker C: conformance suite

---

## 6. 증명 rail

### 6.1 protocol

- golden request/event fixtures
- codec roundtrip
- version mismatch fail-closed
- revision conflict fail-closed
- artifact reference shape stability

### 6.2 kernel

- replay-lite consistency
- single-writer lease
- event ordering
- state ownership
- monotonic clock injection

### 6.3 sdk

- create/dispatch/subscribe/close lifecycle
- multi-observer fanout
- bounded event buffering behavior
- runtime.close teardown

### 6.4 surfaces

- CLI interactive parity
- headless parity
- batch report/predictions parity
- approval flow parity

### 6.5 transports

- same command transcript on in-proc / stdio / websocket
- disconnect/reconnect sequence tests
- event dedupe / stale revision rejection

### 6.6 lint / hellgate

- no `apps/**` import from protocol/kernel/sdk
- no `process.*` in protocol/kernel
- no public export leak of internal engine bags
- no public export leak of `assembleConfig` / `runInteractive`
- slash-authority hellgate

---

## 7. 승인 기준

이 implementation plan의 closeout 기준:

1. Runtime / Session public SDK가 존재
2. CLI/headless/batch가 same SDK consumer
3. public API가 `SessionDeps` / `PromptSource` / `runInteractive` / `assembleConfig` 를 노출하지 않음
4. approval이 command/event protocol로 고정됨
5. capability manifest가 host-derived임
6. protocol/kernel/sdk slice fences가 lint로 고정
7. in-proc + stdio transport parity green
8. replay-lite / capability / lease / multi-observer proof rails green

이 중 하나라도 빠지면 migration은 partial이다.
