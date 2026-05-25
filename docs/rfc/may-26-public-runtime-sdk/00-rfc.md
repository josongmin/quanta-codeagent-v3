# RFC: Public Runtime SDK — Protocol-First Session Kernel for Multi-Surface Quanta

- **상태**: Draft
- **날짜**: 2026-05-26
- **저자**: 세션 협업 (구조 재설계)
- **관련**:
  - ADR-0299 `@/host/bootstrap` 추출
  - ADR-0303 thin-surface / headless-core 기준
  - ADR-0304 side-conversation typed port
  - ADR-0307 REPL host slim-down
  - ADR-0308 headless second-consumer proof
  - ADR-0033 JSON-RPC envelope
  - RFC may-22 unified-agent-runtime

---

## 1. 요약 (TL;DR)

현재 구조는 **thin surface + headless-capable internal host API** 까지는 달성했다. 하지만 이것을 그대로 public SDK로 노출하면 안 된다.

현 구조의 핵심 문제는 public contract가 아직도:

- `runInteractive(...)`
- `PromptSource`
- `SessionDeps`
- `assembleConfig(...)`

같은 **loop-centric / host-leaky / surface-shaped primitive** 위에 서 있다는 점이다.

브레이킹체인지 전제로 공개 SDK를 만들려면 중심을 **REPL loop API** 에서 **session-command / session-event protocol + kernel state machine** 으로 옮겨야 한다.

최종 목표:

1. `CLI`, `Web`, `Native`, `Headless`, `Batch`, `Remote` 가 같은 runtime SDK를 소비한다.
2. surface는 host adapter만 남고, later-turn behavior를 바꾸는 state는 kernel이 단일 SSOT로 소유한다.
3. transport는 in-proc / stdio / websocket / worker / remote를 교체 가능해야 한다.
4. protocol versioning, replay-lite, multi-observer, single-writer lease, fail-closed policy를 기본 제공한다.

이 RFC는 그 최종 구조와 breaking migration 방향을 정의한다.

---

## 2. 최종 리뷰: 현재 구조 평가

### 2.1 이미 맞게 가고 있는 부분

현재 코드에는 SDK화의 seed가 분명히 있다.

| 현재 구성 | 근거 | 평가 |
|---|---|---|
| host-neutral bootstrap | `src/host/bootstrap/index.ts`, `src/host/bootstrap/types.ts` | surface-agnostic session bootstrap 계약이 이미 존재 |
| host-neutral turn runner | `src/runner/orchestrate/run-once.ts`, `run-interactive.ts` | single-turn / interactive orchestration 분리가 이미 되어 있음 |
| second consumer proof | `src/apps/headless/index.ts` | CLI 없이 같은 core를 재사용하는 경로가 이미 존재 |
| engine-owned live state | `src/runner/assemble/config.ts`, `src/host/bootstrap/bootstrap-session.ts` | tool-profile / identity / focus-chain이 slash-local state가 아니라 engine-wired state가 됨 |
| typed side port pattern | `src/runner/side-conversation-port.ts` | engine internals를 surface에 직접 노출하지 않는 port 패턴이 성립 |

즉, thin-surface cleanup은 성공했다. 문제는 **이 internal contract를 public SDK로 착각하면 안 된다** 는 점이다.

### 2.2 지금 구조가 public SDK가 아닌 이유

#### A. public entry가 아직 loop-centric이다

`runInteractive(input)` 는 host-agnostic이지만 public SDK로는 너무 low-level이다.

- `deps`
- `assembleConfig`
- `promptSource`
- `history`
- `wrapTurn`

을 caller가 직접 조합해야 한다: `src/runner/orchestrate/run-interactive.ts`.

이 shape는 CLI/TTY surface에는 맞지만:

- Web app
- Native app
- remote session
- multi-observer session
- resumable background task

에는 너무 직접적이다. SDK consumer가 "한 turn을 어떻게 감쌀지"를 알 필요가 없어야 한다.

#### B. `SessionDeps` 가 너무 넓고 host-leaky하다

`SessionDeps` 는 현재 엔진 wiring용 internal bag이다: `src/runner/assemble/config.ts`.

여기에는:

- llm
- registry
- stream
- permission
- memory
- search
- plan/user-input ports
- follow-up queue
- shell snapshot
- decision emitter
- tool-profile / identity / focus-chain

이 한 레코드에 섞여 있다.

이 shape는 internal assembler에는 유용하지만 public SDK contract로 쓰기엔 문제가 있다.

- surface가 너무 많은 engine detail을 알아야 한다
- backward compatibility surface가 지나치게 넓어진다
- transport boundary에 올리기 어렵다
- host capability negotiation이 불명확하다

#### C. surface syntax와 runtime semantics가 아직 분리되지 않았다

`/identity`, `/profile`, `/focus-chain`, `/side`, `/plan` 은 state authority는 엔진 쪽으로 올랐지만, 여전히 entry syntax는 CLI slash layer가 중심이다:

- `src/apps/cli/repl/slash-surface.ts`
- `src/apps/cli/repl/prompt-pipeline.ts`

public SDK에서는 slash가 first-class가 아니라 **surface-specific grammar** 이어야 한다. runtime은 `SessionCommand` 를 이해해야지 `/identity review` 같은 문자열을 이해하면 안 된다.

#### D. session lifecycle public facade가 없다

지금은 bootstrap + deps compose + loop 호출을 caller가 조합한다.

즉 다음 같은 public object가 없다:

- `Runtime`
- `Session`
- `SessionHandle`
- `SessionClient`

그래서 CLI outside consumer가 안정적으로 의존할 경계가 없다.

#### E. protocol / transport discipline이 없다

현재 thin-surface는 **in-process reuse** 는 가능하게 했지만:

- versioned command/event protocol
- transport conformance suite
- replay-stable snapshot model
- single-writer lease
- multi-observer fanout

은 아직 없다.

이는 SDK가 아니라 internal API의 특징이다.

---

## 3. 목표 / 비목표

### 3.1 목표

- **G1** `CLI`, `Web`, `Native`, `Headless`, `Batch`, `Remote` 가 같은 runtime contract를 사용한다.
- **G2** public contract는 `session-command / session-event / session-snapshot` 중심이다.
- **G3** kernel이 later-turn behavior를 바꾸는 모든 mutable state의 단일 SSOT가 된다.
- **G4** in-proc / stdio / websocket / worker / remote transport가 같은 protocol을 공유한다.
- **G5** replay, resume, multi-observer, capability negotiation, single-writer lease를 기본 제공한다.
- **G6** thin-surface 규칙을 public SDK 수준으로 강화한다: surface는 runtime semantics를 소유하지 않는다.
- **G7** session-scoped 기능은 SDK/kernel/host/protocol 안에서 수용하고, multi-session/product/ops 기능은 상위 driver에 남긴다.

### 3.2 비목표

- **N1** 첫 단계에서 networked service를 강제하지 않는다. in-proc SDK가 first-class다.
- **N2** 현재 CLI UX를 유지하는 것이 최우선은 아니다. 브레이킹 전제다.
- **N3** 모든 내부 type을 public으로 보존하지 않는다. `SessionDeps`, `assembleConfig`, `PromptSource` 는 compatibility 대상이 아니다.
- **N4** LLM/tool side-effect의 완전 결정론을 약속하지 않는다. 대신 event log / snapshot / replay discipline을 강화한다.
- **N5** multi-session supervisor, benchmark corpus 관리, account/auth/billing, product-specific workflow는 session SDK의 책임으로 끌어내리지 않는다.

---

## 4. 제안 구조

### 4.1 레이어

```text
src/
  protocol/
    session/        versioned command/event/snapshot/error/capability schema
  kernel/
    session/        single authoritative session state machine
  host/
    runtime/        host ports + capability binding + policy composition
  sdk/
    runtime/        public Runtime / Session facade
  ipc/
    session/        stdio / websocket / worker transport adapters
  apps/
    cli/            terminal adapter only
    headless/       proof + tests, SDK consumer
    bench/          workload driver, SDK consumer
    agent/          thin argv wrapper or removed entirely
```

### 4.2 각 레이어 책임

| 레이어 | 책임 | 금지 |
|---|---|---|
| `@/protocol/session` | commands, events, snapshots, errors, codec, versioning | `process.*`, fs, env, app import |
| `@/kernel/session` | session state machine, command apply, turn scheduling, event emission, replay | TTY/stdout/env/surface syntax |
| `@/host/runtime` | llm/tools/shell/fs/persistence/clock/random/metrics binding | slash grammar, terminal chrome |
| `@/sdk/runtime` | `createRuntime`, `createSession`, `dispatch`, `subscribe`, `snapshot` facade | direct app imports |
| `@/ipc/session` | protocol ↔ transport bridge | runtime policy ownership |
| `src/apps/*` | argv/HTTP/UI/TTY/native binding, render, host-specific UX | reusable runtime semantics |

### 4.2.1 Feature admission rule

새 기능은 먼저 아래 질문으로 분류한다.

1. canonical `SessionCommand` 로 표현 가능한가
2. later-turn behavior를 바꾸는 kernel state가 필요한가
3. host capability 호출이 필요한가
4. `SessionEvent` / `ArtifactRef` 로 관찰 가능한가
5. 단일 session boundary 안에서 완료되는가

전부 `yes` 면 session SDK 기능이다.

하나라도 `no` 면 상위 계층 후보로 본다:

- multi-session supervisor
- benchmark corpus selection / aggregation
- account/auth/billing
- product-specific workflow UI
- fleet daemon / org-level ops control

판정 규칙:

- `batch execution` 자체는 session SDK 위에서 돌 수 있다.
- 하지만 corpus ownership, verdict aggregation, report packaging은 batch driver ownership이다.
- `slash grammar` 는 session SDK 기능이 아니라 surface grammar다.

### 4.3 public SDK facade

```ts
const runtime = await createRuntime({
  host,
  persistence,
  policy,
  expectedCapabilities,
})

const session = await runtime.createSession({
  cwd,
  model: "gpt-5.5",
  permissionMode: "reviewer-backed",
  identityMode: "default",
  toolProfile: "write",
})

const unsubscribe = session.subscribe((event) => {
  // render token deltas, approvals, tool events, state changes
})

await session.dispatch({
  sessionId,
  commandId,
  issuedAt,
  expectedRevision,
  type: "input.append",
  text: "fix the failing test",
})

await session.dispatch({
  sessionId,
  commandId,
  issuedAt,
  expectedRevision,
  type: "turn.run",
})

await session.dispatch({
  sessionId,
  commandId,
  issuedAt,
  expectedRevision,
  type: "session.identity.set",
  mode: "review",
})

const snapshot = await session.snapshot()
await session.close()
await runtime.close()
```

핵심은 surface가 더 이상:

- `SessionDeps`
- `assembleConfig`
- `PromptSource`
- `runInteractive`

를 직접 만지지 않는다는 점이다.

중요:

- `capabilities` 는 public caller가 임의로 넣는 truth가 아니다.
- runtime은 `host` 가 실제로 제공한 port에서 capability manifest를 **유도**한다.
- 필요한 경우 caller는 `expectedCapabilities` 같은 validation-only 입력을 줄 수 있지만, capability authority는 host다.

### 4.4 protocol-first command / event 모델

#### Command

runtime이 이해하는 것은 surface 문자열이 아니라 typed command다.

모든 command는 payload만이 아니라 envelope metadata를 가진다.

최소 필드:

- `sessionId`
- `commandId`
- `issuedAt`
- `expectedRevision?`

예시:

- `input.append`
- `input.attach_image`
- `turn.run`
- `turn.cancel`
- `session.identity.set`
- `session.tool_profile.set`
- `session.focus_chain.reset`
- `session.focus_chain.skip`
- `session.plan.review.respond`
- `session.user_input.respond`
- `side.start`
- `session.export`
- `session.import`

`expectedRevision` 은 stale UI action, reconnect 후 중복 dispatch, multi-client race를 fail-closed 하기 위한 것이다.

#### Event

surface가 구독하는 것은 typed event stream이다.

모든 event는 payload만이 아니라 ordering metadata를 가진다.

최소 필드:

- `eventId`
- `seq`
- `revision`
- `emittedAt`
- `causedByCommandId?`

예시:

- `session.created`
- `session.state.updated`
- `turn.started`
- `turn.completed`
- `turn.failed`
- `output.delta`
- `tool.started`
- `tool.progress`
- `tool.completed`
- `approval.requested`
- `approval.resolved`
- `artifact.ready`
- `session.closed`

transport가 붙는 순간 event 이름만으로는 부족하다. `seq` / `revision` / `causedByCommandId` 가 있어야 ordering, dedupe, reconnect, snapshot resume이 일관된다.

#### Snapshot

surface reconnect / resume / external observer를 위해 typed snapshot을 제공한다.

예시:

- current mode / profile / identity
- pending approval
- active turn state
- transcript summary
- outstanding side sessions
- capability manifest
- open artifacts

snapshot은 특정 `revision` 에 대한 **consistent cut** 이어야 한다.

첫 구현은 `snapshot-lite` 로 제한한다.

- UI hydration
- reconnect recovery
- operator inspection

용도까지만 보장한다.

완전 결정론 재실행용 full replay snapshot은 이번 RFC 범위 밖이다.

### 4.4.1 Approval is protocol, not callback

approval / operator review는 host callback으로 public seam에 남기면 안 된다.

정답 shape:

- event: `approval.requested`
- command: `approval.respond`
- event: `approval.resolved`

host runtime은 operator-review capability를 통해 실제 판단을 구하더라도, public surface는 같은 command/event contract만 본다.

### 4.4.2 ArtifactRef is first-class

`output.delta` 만으로는 부족하다.

다음은 protocol first-class artifact로 다뤄야 한다.

- image output
- tool-generated logs
- session export
- patch/report/predictions output
- rendered previews

따라서 protocol에는 최소 `ArtifactRef` 개념이 있어야 한다.

필드 예:

- `artifactId`
- `kind`
- `mimeType`
- `name?`
- `byteLength?`
- `locator`
- `createdAt`

이 타입은 snapshot, events, batch output이 공통으로 사용한다.

### 4.5 kernel이 단일 state owner가 된다

thin-surface 다음 단계는 **render-only에 가까운 kernel ownership** 이다.

원칙:

1. later-turn behavior를 바꾸는 mutable state는 kernel store에만 존재
2. surface는 snapshot을 읽거나 command를 보낸다
3. surface-local mirror는 cache일 뿐 authority가 아니다
4. slash / button / deep-link / remote API는 모두 같은 command를 낸다

즉 `/identity review`, mobile toggle, web button, remote websocket message가 모두 `session.identity.set` 로 수렴해야 한다.

### 4.5.1 Kernel clock is injected

kernel은 side effect를 실행하지 않지만, scheduler와 ordering은 시간 개념이 필요하다.

따라서 kernel은 `Date.now()` 같은 ambient clock를 직접 읽지 않는다.

시간은 monotonic clock port로 주입한다. 이 포트는:

- event timestamp
- scheduler timeout / retry window
- replay-lite consistency

의 기준이 된다.

### 4.6 host ports는 capability manifest로 묶는다

지금의 `SessionDeps` bag 대신 host contract는 capability-oriented가 된다.

예시:

- `llm`
- `toolExecutor`
- `shell`
- `filesystem`
- `persistence`
- `mcp`
- `clock`
- `random`
- `metrics`
- `tracing`
- `operatorReview`

runtime는 부팅 시 capability manifest를 host에서 **유도**하고, session snapshot / event에 그 manifest를 반영한다.

효과:

- batch / headless / remote가 무엇을 할 수 있는지 명확해진다
- unsupported feature는 fail-closed 된다
- transport 바깥 client도 capability negotiation이 가능하다

주의:

- manifest authority는 host다
- caller-supplied expectation은 validation-only다
- `host says absent` 인 capability를 surface가 "있다"고 주장할 수 없다

### 4.7 transport는 protocol 하부 문제다

protocol은 transport-agnostic이고, remote wire는 별도다.

권장 순서:

1. in-proc direct transport
2. stdio JSON-RPC transport
3. websocket transport
4. worker/daemon transport

repo에는 이미 JSON-RPC와 websocket seed가 있다.

- `src/shared/jsonrpc/*`
- `src/ipc/transports/stdio.ts`
- `src/ipc/transports/websocket.ts`

이들을 새 session protocol transport에 재사용한다.

### 4.8 slash는 public API가 아니라 surface grammar다

CLI는 계속 slash를 가질 수 있다. 하지만 slash registry는 runtime state owner가 되면 안 된다.

정답 구조:

- slash parser: `"/identity review"` → `SessionCommand`
- runtime: command apply + event emit
- terminal renderer: event/snapshot render

Web/native는 같은 runtime command를 button/menu/shortcut로 보낸다.

주의:

- `apps/web`
- `apps/native`

는 이번 단계에서 placeholder 디렉토리로 만들지 않는다. 문서 target으로만 유지하고, 실제 consumer는 `cli/headless/bench` 를 먼저 cutover 한다.

### 4.9 batch도 같은 runtime 위에서 돈다

`agent:batch` 는 separate core가 아니라:

- corpus driver
- per-instance sandbox
- verdict evaluator
- report writer

만 batch-specific이고, actual session execution은 같은 SDK session을 사용해야 한다.

즉 batch는 "다른 agent" 가 아니라 "같은 runtime의 workload driver" 가 된다.

batch가 끝까지 소유해야 할 것:

- corpus load
- per-instance sandbox
- verdict evaluation
- report writing

이 네 가지가 kernel/runtime 안으로 역류하면 다시 fat runtime이 된다.

---

## 5. 브레이킹 변경

다음은 의도적으로 깨야 한다.

1. `runInteractive(...)` 를 public/consumer-facing contract에서 제거
2. `SessionDeps` 를 internal-only로 격하
3. `assembleConfig(...)` 를 internal composer로 격하
4. `PromptSource` 를 CLI-specific adapter로 격하
5. slash command를 runtime entrypoint로 취급하는 모든 계약 제거
6. surface가 live mutable runtime state를 보유하는 fallback 금지
7. batch/headless/interactive가 서로 다른 runtime API를 갖는 상태 제거
8. approval을 host callback으로 직접 public SDK에 노출하는 패턴 제거
9. caller-authored capability manifest를 truth로 쓰는 패턴 제거

이 RFC가 Accepted 되면 다음 문장은 금지한다:

- "Web surface도 `runInteractive` 호출하면 된다"
- "headless는 `SessionDeps` 만 맞춰서 꽂으면 된다"
- "slash에서 바꾸는 state를 sessionDeps에 나중에 연결하자"
- "capability는 caller가 적당히 맞춰 넣으면 된다"
- "approval은 host callback 하나 열어두면 된다"

---

## 6. 검증 및 guardrail

### 6.1 구조 lint

- `@/protocol/**` 는 `apps/**`, `process.*`, `node:readline`, fs/env import 금지
- `@/kernel/**` 는 `apps/**`, `process.*`, `node:readline`, `process.exit` 금지
- `@/sdk/**` 는 `apps/**` import 금지
- public API가 `SessionDeps` / `AgentConfig` / `PromptSource` 를 export 하면 fail

### 6.2 proof rails

- protocol golden tests
- kernel replay determinism tests
- transport conformance suite
- multi-observer event ordering tests
- single-writer lease tests
- capability negotiation tests
- command revision conflict tests
- approval protocol roundtrip tests
- artifact reference lifecycle tests
- CLI/headless parity tests
- batch/session parity tests

### 6.3 exact-zero target

public SDK closeout 시점에는:

1. surface runtime imports zero
2. non-surface terminal defaults zero
3. public API leak of internal engine bags zero
4. slash-local runtime authority zero
5. caller-authored capability truth zero

---

## 7. 트레이드오프

### 7.1 얻는 것

- SDK consumer ergonomics
- CLI/Web/Native parity
- transport independence
- replay/debug capability
- revisioned concurrency safety
- approval parity across surfaces
- artifact delivery uniformity
- strong state ownership
- capability negotiation
- future remote-control / daemon / mobile 확장성

### 7.2 잃는 것

- 초기 migration 비용이 큼
- 기존 internal helper가 많이 deprecated 됨
- short-term에는 dual path 유지 비용이 생김
- surface-specific quick hack 공간이 줄어듦

### 7.3 리스크

- kernel/protocol를 너무 크게 잡으면 migration이 멈출 수 있음
- event model을 잘못 잡으면 CLI token UX가 퇴화할 수 있음
- batch parity를 놓치면 benchmark regression이 날 수 있음
- protocol versioning 없이 먼저 remote를 열면 drift가 발생함
- revision metadata 없이 transport를 먼저 열면 stale command race가 발생함
- snapshot semantics를 좁히지 않으면 "replay"가 과장된 claim이 됨
- host-derived capability rule이 없으면 public SDK consumer가 capability truth를 오염시킴

따라서 순서가 중요하다. protocol과 kernel을 먼저 고정하고, surface cutover는 그 다음이다.

---

## 8. 대안 검토

### A. 지금 구조를 그대로 public SDK로 노출

기각.

- 너무 low-level
- host-leaky
- versioning 불리
- multi-surface abstraction 부족

### B. 처음부터 remote service로만 간다

기각.

network/service를 먼저 고정하면 local CLI/headless parity가 오히려 늦어진다. in-proc SDK가 먼저다.

### C. surface를 완전 render-only로 바로 밀어붙인다

부분 기각.

장기적으로는 맞는 방향이지만, 이번 RFC의 핵심은 public SDK + kernel ownership이다. render-only 100%까지를 첫 phase 종료조건으로 잡으면 scope가 너무 커진다.

---

## 9. 승인 기준

이 RFC는 다음이 만족될 때 구현 완료로 본다.

1. public SDK entry가 `Runtime` / `Session` facade 형태로 존재
2. CLI/headless/batch가 같은 SDK runtime을 소비
3. Web/Native도 같은 command/event contract를 사용 가능하다
4. later-turn state authority가 kernel store 하나로 수렴
5. slash는 command encoder일 뿐 runtime owner가 아님
6. in-proc + stdio transport conformance green
7. approval이 command/event protocol로 고정된다
8. `ArtifactRef` 가 snapshot/events/batch output에 공통 사용된다
9. `SessionDeps` / `PromptSource` / `runInteractive` 는 public contract에서 제거된다
10. thin-surface ratchet 위에 SDK-specific lint/hellgate가 추가된다

이 기준을 만족하지 못하면 "thin internal API" 일 뿐 "public SDK" 는 아니다.
