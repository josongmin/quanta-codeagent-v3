# Execution Ticket — Public Runtime SDK V1

- **상태**: Ready for implementation after RFC acceptance
- **날짜**: 2026-05-26
- **관련 문서**:
  - [00-rfc.md](./00-rfc.md)
  - [01-implementation-plan.md](./01-implementation-plan.md)
  - ADR-0299
  - ADR-0303
  - ADR-0308

---

## 1. 목적

현재 thin-surface internal runtime을 **public Runtime / Session SDK** 로 재구성한다.

최종 목표:

1. `CLI`, `Headless`, `Batch` 가 같은 SDK를 소비한다.
2. `Web`, `Native`, `Remote` 가 같은 `SessionCommand` / `SessionEvent` / `SessionSnapshot` contract를 재사용할 수 있다.
3. `SessionDeps`, `PromptSource`, `runInteractive`, `assembleConfig` 는 public contract에서 제거된다.
4. later-turn behavior를 바꾸는 mutable state authority는 kernel 하나만 가진다.
5. session-scoped 기능만 SDK에 넣고, multi-session/product/ops 기능은 상위 driver에 남긴다.

---

## 2. 비범위

이번 티켓에서 하지 않는다.

- placeholder `apps/web`, `apps/native` 디렉토리 생성
- 완전 결정론 replay
- worker transport first
- remote daemon first
- plugin sandbox 재설계
- capability graph / policy lattice 같은 대형 일반화
- benchmark corpus ownership / report aggregation의 runtime 편입
- account/auth/billing, org-level ops control의 session SDK 편입

---

## 3. 최종 아키텍처

### 3.1 레이어

```text
Surface
  CLI / Headless / Batch / future Web / future Native
  -> command encode, event render, host-specific UX only

SDK
  Runtime / Session public facade
  -> createRuntime, createSession, dispatch, subscribe, snapshot, close

Kernel
  authoritative session state machine
  -> reducer, scheduler, lease, event ordering, replay-lite

Host Runtime
  real side-effect capability binding
  -> llm, tool, shell, fs, persistence, operator review, clock

Protocol
  SessionCommand / SessionEvent / SessionSnapshot / codec / version
```

### 3.2 절대 원칙

1. Surface는 상태 authority를 소유하지 않는다.
2. Surface는 command를 만들고 event/snapshot을 렌더링한다.
3. Kernel은 side effect를 직접 실행하지 않는다.
4. Host Runtime은 실제 I/O capability를 가진다.
5. Capability manifest는 host에서 유도한다.
6. Approval은 callback이 아니라 protocol이다.
7. Artifact는 protocol first-class다.
8. `SessionDeps`, `PromptSource`, `runInteractive`, `assembleConfig` 는 public SDK contract가 아니다.
9. session 밖 workflow는 SDK가 아니라 상위 driver/service 책임이다.

### 3.3 Feature admission rule

새 기능은 구현 전에 아래 5개를 먼저 답한다.

1. canonical `SessionCommand` 가 있는가
2. later-turn behavior를 바꾸는 kernel state가 필요한가
3. 필요한 side effect가 host capability로 닫히는가
4. 결과가 `SessionEvent` / `ArtifactRef` 로 관찰되는가
5. 단일 session 경계 안에서 완결되는가

전부 `yes` 면 session SDK 기능이다.

하나라도 `no` 면 상위 driver/service 후보다.

상위 driver/service 예시:

- benchmark corpus selection / aggregation
- multi-session supervisor
- account/auth/billing
- org-level policy admin
- product-specific workflow chrome

주의:

- batch의 per-instance execution은 SDK 위에서 돈다.
- corpus ownership, verdict aggregation, report packaging은 batch driver ownership이다.

---

## 4. Public API target

```ts
const runtime = await createRuntime({
  host,
  persistence,
  policy,
  expectedCapabilities,
})

const session = await runtime.createSession({
  cwd,
  model,
  permissionMode,
  identityMode,
  toolProfile,
})

const unsubscribe = session.subscribe((event) => {
  render(event)
})

await session.dispatch({
  sessionId,
  commandId,
  issuedAt,
  expectedRevision,
  type: "input.append",
  text: "fix failing test",
})

await session.dispatch({
  sessionId,
  commandId,
  issuedAt,
  expectedRevision,
  type: "turn.run",
})

const snapshot = await session.snapshot()

unsubscribe()
await session.close()
await runtime.close()
```

### 중요한 제약

- `expectedCapabilities` 는 validation-only다.
- runtime truth는 `host` 포트에서 유도된 capability manifest다.
- runtime은 stale `expectedRevision` command를 fail-closed 해야 한다.

---

## 5. Protocol contract

### 5.0 Canonical type skeleton

```ts
type SessionCommandEnvelope<TType extends string, TPayload> = {
  sessionId: string
  commandId: string
  issuedAt: string
  expectedRevision?: number
  type: TType
} & TPayload

type SessionEventEnvelope<TType extends string, TPayload> = {
  eventId: string
  seq: number
  revision: number
  emittedAt: string
  causedByCommandId?: string
  type: TType
} & TPayload

type SessionSnapshotLite = {
  sessionId: string
  revision: number
  seq: number
  state: SessionStateView
  capabilities: CapabilityManifest
  pendingApproval: PendingApprovalView | null
  openArtifacts: ArtifactRef[]
}
```

제약:

- `sessionId` 는 session-scoped invariant다.
- `commandId` / `eventId` 는 transport dedupe key다.
- `revision` 은 state authority ordering key다.
- `seq` 는 event-stream replay ordering key다.

### 5.1 SessionCommand envelope

모든 command는 최소 다음 필드를 가진다.

- `sessionId`
- `commandId`
- `issuedAt`
- `expectedRevision?`
- `type`

### 5.2 SessionEvent envelope

모든 event는 최소 다음 필드를 가진다.

- `eventId`
- `seq`
- `revision`
- `emittedAt`
- `causedByCommandId?`
- `type`

### 5.3 SessionSnapshot

첫 구현은 `snapshot-lite` 다.

포함:

- `sessionId`
- `revision`
- current mode / identity / toolProfile
- pending approval
- active turn state
- transcript summary
- open artifacts
- capability manifest

불포함:

- full deterministic replay substrate
- byte-for-byte external tool side effect reconstruction

### 5.4 Approval protocol

필수 event/command:

- `approval.requested`
- `approval.respond`
- `approval.resolved`

CLI prompt / Web modal / Native dialog 모두 이 protocol 위에서만 동작해야 한다.

### 5.5 ArtifactRef

필수 필드:

- `artifactId`
- `kind`
- `mimeType`
- `name?`
- `byteLength?`
- `locator`
- `createdAt`

ArtifactRef는 다음 모든 경로에 공통 사용한다.

- `artifact.ready` event
- snapshot open artifacts
- batch predictions/report/export references
- session export/import 결과물

### 5.6 Kernel state ownership skeleton

```ts
type KernelSessionState = {
  revision: number
  seq: number
  lease: SessionLeaseState
  session: {
    identityMode: IdentityMode
    toolProfile: ToolProfile
    permissionMode: PermissionMode
    capabilityManifest: CapabilityManifest
  }
  input: {
    draft: InputBuffer
    attachments: AttachmentRef[]
  }
  turn: {
    status: "idle" | "running" | "awaiting_approval" | "failed"
    activeTurnId?: string
    pendingApproval?: PendingApprovalState
  }
  focusChain: FocusChainState
  sideSessions: SideSessionState[]
  transcript: TranscriptState
  artifacts: ArtifactRef[]
}
```

절대 규칙:

- surface는 위 state의 mirror를 authority처럼 캐시하면 안 된다.
- host runtime은 위 state를 mutate하지 않는다. host는 result만 반환한다.
- later-turn behavior를 바꾸는 값은 전부 kernel state에 들어간다.

---

## 6. Major logic flows

### 6.1 일반 command 처리

1. surface가 command를 생성한다.
2. SDK session이 command를 kernel에 전달한다.
3. kernel이 lease / revision / shape를 검증한다.
4. kernel이 state transition pre-check를 수행한다.
5. host capability가 필요하면 kernel이 host runtime port를 호출한다.
6. host 결과를 kernel이 받아 state를 commit한다.
7. kernel이 event log append 후 ordered event를 emit한다.
8. SDK subscriber가 event를 surface로 전달한다.

### 6.2 approval 흐름

1. kernel이 action을 바로 실행할 수 없으면 `approval.requested` emit
2. surface가 prompt/modal/dialog 렌더
3. surface가 `approval.respond` dispatch
4. kernel이 pending approval과 매칭
5. allow/deny 적용
6. `approval.resolved` emit
7. 필요 시 blocked/completed 흐름 지속

### 6.3 artifact 생성 흐름

1. host tool/llm/exporter가 artifact를 생성
2. host runtime이 stable locator를 mint
3. kernel이 `ArtifactRef` 를 state + event log에 기록
4. `artifact.ready` emit
5. surface는 locator를 직접 해석하지 않고 ArtifactRef를 소비

### 6.4 replay-lite 흐름

1. runtime이 `snapshot-lite@revision=N` 을 읽는다
2. event log tail `seq > snapshot.seq` 를 붙인다
3. consumer는 snapshot + tail로 UI hydration / reconnect를 수행한다

주의:

- replay-lite는 UI resume/debug용이다
- deterministic re-execution contract가 아니다

---

## 7. 파일 맵

### 7.1 신규 파일

#### Protocol

- `src/protocol/session/commands.ts`
- `src/protocol/session/events.ts`
- `src/protocol/session/snapshot.ts`
- `src/protocol/session/capabilities.ts`
- `src/protocol/session/errors.ts`
- `src/protocol/session/codec.ts`
- `src/protocol/session/version.ts`
- `src/protocol/session/index.ts`

#### Kernel

- `src/kernel/session/state.ts`
- `src/kernel/session/reducer.ts`
- `src/kernel/session/scheduler.ts`
- `src/kernel/session/event-log.ts`
- `src/kernel/session/lease.ts`
- `src/kernel/session/replay-lite.ts`
- `src/kernel/session/ports.ts`
- `src/kernel/session/index.ts`

#### Host Runtime

- `src/host/runtime/builder.ts`
- `src/host/runtime/session-host.ts`
- `src/host/runtime/capabilities.ts`
- `src/host/runtime/tool-executor.ts`
- `src/host/runtime/persistence.ts`
- `src/host/runtime/operator-review.ts`
- `src/host/runtime/trace-adapter.ts`
- `src/host/runtime/index.ts`

#### SDK

- `src/sdk/runtime/create-runtime.ts`
- `src/sdk/runtime/runtime.ts`
- `src/sdk/runtime/session.ts`
- `src/sdk/runtime/subscription.ts`
- `src/sdk/runtime/types.ts`
- `src/sdk/runtime/index.ts`

#### IPC

- `src/ipc/session/bridge.ts`
- `src/ipc/session/stdio-client.ts`
- `src/ipc/session/stdio-server.ts`
- `src/ipc/session/websocket-client.ts`
- `src/ipc/session/websocket-server.ts`

### 7.2 대규모 수정 파일

- `src/apps/cli/repl/prompt-pipeline.ts`
- `src/apps/cli/repl/slash-surface.ts`
- `src/apps/cli/repl/session-setup.ts`
- `src/apps/cli/repl/session-loop.ts`
- `src/apps/headless/index.ts`
- `src/apps/bench/index.ts`
- `src/apps/agent/mode-presets/interactive.ts`
- `src/host/bootstrap/*`
- `src/runner/orchestrate/*`
- `src/runner/assemble/config.ts`

### 7.3 제거/격하 대상

- public `runInteractive`
- public `PromptSource`
- public `SessionDeps`
- public `assembleConfig`
- direct public path `bootstrapSession + composeSessionDeps + runOnce`

### 7.4 기존 파일별 예상 ownership 이동

| 기존 파일/모듈 | 현재 성격 | 이동 후 owner | 최종 상태 |
|---|---|---|---|
| `src/apps/cli/repl/prompt-pipeline.ts` | interactive input loop + slash dispatch | `src/apps/cli` + `src/protocol/session` | command encoder only |
| `src/apps/cli/repl/slash-surface.ts` | slash-local state mutation | `src/apps/cli` + `src/sdk/runtime` | command parser only |
| `src/apps/cli/repl/session-loop.ts` | runner loop orchestration | `src/sdk/runtime` + `src/apps/cli` | event render loop only |
| `src/apps/cli/repl/session-setup.ts` | session bootstrap composition | `src/host/runtime` + `src/sdk/runtime` | host binding only |
| `src/apps/headless/index.ts` | direct bootstrap/orchestrate consumption | `src/sdk/runtime` | thin SDK consumer |
| `src/apps/bench/index.ts` | batch + runtime mixed ownership | `src/sdk/runtime` + batch driver | driver above SDK |
| `src/host/bootstrap/*` | mixed session state bootstrap | `src/kernel/session` + `src/host/runtime` | split by authority |
| `src/runner/orchestrate/*` | loop-centric runtime API | `src/kernel/session` + `src/sdk/runtime` | internal only or removed |
| `src/runner/assemble/config.ts` | public-adjacent config bag | internal host/kernel glue | no public exposure |

---

## 8. Wave tickets

각 wave는 독립 merge 가능해야 한다. 각 wave는 own DoD를 가진다.

### 8.0 Dependency graph

```text
T1 protocol spine
  -> T2 kernel session state machine
    -> T3 host runtime capability builder
      -> T4 SDK runtime facade
        -> T5 CLI / Headless / Batch cutover
          -> T6 stdio / websocket transport
            -> T7 old API removal + exact lint
```

병렬 가능 범위:

- `T1`: command/event/errors/capabilities/codec 분리 구현 가능
- `T2`: reducer/scheduler 와 replay-lite/lease 병렬 가능
- `T3`: capability binding lane와 manifest/approval lane 병렬 가능
- `T5`: CLI/headless/batch cutover 병렬 가능
- `T6`: stdio/websocket 병렬 가능

금지:

- `T4` 전에 surface cutover 시작
- `T1` schema freeze 전에 transport 구현 시작
- `T5` 전에 old API 제거 주장

### T1. Protocol spine

**목표**

public contract SSOT 고정.

**작업**

1. command/event/snapshot/errors/version/capabilities 타입 추가
2. command envelope metadata 추가
3. event envelope metadata 추가
4. approval protocol 고정
5. ArtifactRef shape 고정
6. codec roundtrip 추가

**주요 로직**

- command는 payload-only가 아님
- event는 ordering metadata가 필수
- snapshot은 `snapshot-lite@revision` 의미를 가진다

**DoD**

- protocol 파일 생성 완료
- golden fixture 존재
- codec roundtrip green
- stale revision / bad version / malformed envelope fail-closed 테스트 green

**금지 shortcut**

- payload 타입만 만들고 envelope metadata를 TODO로 남기기
- approval/artifact shape를 임시 `any` 로 열어두기
- codec 없이 in-proc object shape만 맞추고 완료 주장하기

**필수 테스트**

- `protocol-command-envelope.test.ts`
- `protocol-event-envelope.test.ts`
- `protocol-codec-roundtrip.test.ts`
- `protocol-approval-shape.test.ts`
- `protocol-artifact-ref.test.ts`

### T2. Kernel session state machine

**목표**

later-turn mutable state authority를 kernel 하나로 수렴.

**작업**

1. state shape 정의
2. reducer 정의
3. scheduler 정의
4. lease 정의
5. event log append discipline 정의
6. replay-lite 정의
7. monotonic clock port 주입

**주요 로직**

- `applyCommand` 는 pure transition과 host-needed transition을 구분
- `turn.run` 은 scheduler 진입점
- pending approval은 explicit state arm
- open artifacts는 state slot

**DoD**

- reducer/state/scheduler/lease/replay-lite 파일 존재
- kernel이 `process.*` 를 직접 읽지 않음
- stale revision reject
- single-writer lease green
- replay-lite consistency green

**금지 shortcut**

- kernel reducer 안에서 `Date.now()` / `Math.random()` / `process.*` 직접 호출
- approval/focus/toolProfile state를 surface-local cell로 남기기
- replay-lite를 snapshot dump만으로 대체하기

**필수 테스트**

- `kernel-reducer.test.ts`
- `kernel-scheduler.test.ts`
- `kernel-lease.test.ts`
- `kernel-replay-lite.test.ts`
- `kernel-clock-port.test.ts`

### T3. Host runtime capability builder

**목표**

real side-effect capability binding을 host로 이동.

**작업**

1. host capability interfaces 정의
2. host builder 정의
3. capability manifest derivation 구현
4. persistence / tool / llm / shell / review binding
5. host-generated artifact ref minting

**주요 로직**

- manifest는 host에서 유도
- caller의 `expectedCapabilities` 는 validation-only
- missing capability는 fail-closed

**DoD**

- builder/session-host/capabilities files 존재
- derived manifest tests green
- expected capability mismatch tests green
- host approval adapter가 protocol과 연결됨

**금지 shortcut**

- caller가 넣은 capability object를 truth처럼 저장하기
- approval을 host callback secret seam으로 유지하기
- artifact locator를 unstable temp path로 노출하기

**필수 테스트**

- `host-capability-derivation.test.ts`
- `host-capability-mismatch.test.ts`
- `host-artifact-minting.test.ts`
- `host-approval-adapter.test.ts`

### T4. SDK runtime facade

**목표**

surface가 쓸 public Runtime / Session API 제공.

**작업**

1. `createRuntime`
2. `runtime.createSession`
3. `session.dispatch`
4. `session.subscribe`
5. `session.snapshot`
6. `session.close`
7. `runtime.close`

**주요 로직**

- in-proc first
- small bounded buffering only
- multi-observer fanout
- consistent close semantics

**DoD**

- SDK facade files 존재
- public type surface 고정
- runtime.close teardown green
- multi-observer ordering green

**금지 shortcut**

- `SessionDeps` bag을 이름만 바꿔 SDK로 재노출하기
- `runInteractive` 를 wrapper로 남기고 facade라고 부르기
- session close와 runtime close semantics를 섞어두기

**필수 테스트**

- `sdk-runtime-lifecycle.test.ts`
- `sdk-session-dispatch.test.ts`
- `sdk-subscription-ordering.test.ts`
- `sdk-runtime-close.test.ts`

### T5. CLI / Headless / Batch cutover

**목표**

기존 consumer들을 SDK consumer로 바꾼다.

**CLI 작업**

1. prompt pipeline을 command encoder로 전환
2. slash를 command parser로 전환
3. session loop를 event consumer로 전환
4. approval UX를 protocol 기반으로 전환

**Headless 작업**

1. direct bootstrap/runner consumption 제거
2. SDK smoke proof로 재작성

**Batch 작업**

1. per-instance session create
2. command dispatch + event capture
3. verdict/report는 batch driver ownership 유지

**DoD**

- CLI/headless/batch 모두 same SDK consumer
- CLI slash는 command encoder
- headless는 SDK contract proof
- batch report/predictions schema unchanged

**금지 shortcut**

- CLI slash가 kernel state를 직접 mutate하게 두기
- batch driver 로직을 kernel/runtime 안으로 밀어넣기
- headless가 SDK 대신 internal bootstrap/orchestrate를 계속 호출하기

**필수 테스트**

- `cli-sdk-parity.test.ts`
- `headless-sdk-parity.test.ts`
- `batch-sdk-parity.test.ts`
- `batch-report-schema-parity.test.ts`
- `approval-flow-cli.test.ts`

### T6. stdio / websocket transport

**목표**

transport-conformant remote/control path 추가.

**작업**

1. protocol <-> JSON-RPC bridge
2. stdio client/server
3. websocket client/server
4. reconnect/dedupe/seq discipline

**주요 로직**

- event seq 기반 resume
- stale revision reject
- duplicate commandId reject or idempotent handling

**DoD**

- stdio transport green
- websocket transport green
- conformance suite green

**금지 shortcut**

- transport별 bespoke event shape 만들기
- reconnect 시 snapshot 없이 event stream만 이어붙이기
- duplicate `commandId` 처리 정책 없이 optimistic accept 하기

**필수 테스트**

- `transport-stdio-conformance.test.ts`
- `transport-websocket-conformance.test.ts`
- `transport-reconnect-seq.test.ts`
- `transport-duplicate-command.test.ts`

### T7. Old API removal + exact lint

**목표**

old public path를 제거하고 구조 guard를 고정.

**작업**

1. export leak scanners 추가
2. `runInteractive` public exposure 제거
3. `PromptSource` public exposure 제거
4. `SessionDeps` public exposure 제거
5. `assembleConfig` public exposure 제거
6. no caller-authored capability truth lint 추가

**DoD**

- public API에서 old primitives 제거
- lint/hellgate green
- docs updated

**금지 shortcut**

- deprecated export를 남겨두고 문서만 수정하기
- allowlist 기반 lint ceiling으로 타협하기
- internal helper 재export를 우회 경로로 남기기

**필수 테스트**

- `sdk-public-export-hellgate.test.ts`
- `sdk-no-internal-bag-export.test.ts`
- `sdk-no-caller-capability-truth.test.ts`

---

## 9. Per-wave touched files and commands

### 9.1 T1 Protocol spine

**주요 touched files**

- `src/protocol/session/*`
- `tests/unit/protocol/*`

**필수 명령**

```sh
bun run typecheck
bunx @biomejs/biome check src/protocol/session tests/unit/protocol
bun test tests/unit/protocol
```

### 9.2 T2 Kernel session state machine

**주요 touched files**

- `src/kernel/session/*`
- `tests/unit/kernel/*`

**필수 명령**

```sh
bun run typecheck
bunx @biomejs/biome check src/kernel/session tests/unit/kernel
bun test tests/unit/kernel
```

### 9.3 T3 Host runtime capability builder

**주요 touched files**

- `src/host/runtime/*`
- `tests/unit/host/*`

**필수 명령**

```sh
bun run typecheck
bunx @biomejs/biome check src/host/runtime tests/unit/host
bun test tests/unit/host
```

### 9.4 T4 SDK runtime facade

**주요 touched files**

- `src/sdk/runtime/*`
- `tests/unit/sdk/*`

**필수 명령**

```sh
bun run typecheck
bunx @biomejs/biome check src/sdk/runtime tests/unit/sdk
bun test tests/unit/sdk
```

### 9.5 T5 CLI / Headless / Batch cutover

**주요 touched files**

- `src/apps/cli/repl/*`
- `src/apps/headless/index.ts`
- `src/apps/bench/index.ts`
- `src/apps/agent/mode-presets/interactive.ts`
- `tests/unit/apps/cli/*`
- `tests/unit/apps/headless/*`
- `tests/unit/apps/bench/*`

**필수 명령**

```sh
bun run typecheck
bunx @biomejs/biome check src/apps/cli src/apps/headless src/apps/bench src/apps/agent/mode-presets tests/unit/apps/cli tests/unit/apps/headless tests/unit/apps/bench
bun test tests/unit/apps/cli tests/unit/apps/headless tests/unit/apps/bench
```

### 9.6 T6 stdio / websocket transport

**주요 touched files**

- `src/ipc/session/*`
- `tests/unit/ipc/*`
- `tests/integration/ipc/*`

**필수 명령**

```sh
bun run typecheck
bunx @biomejs/biome check src/ipc/session tests/unit/ipc tests/integration/ipc
bun test tests/unit/ipc tests/integration/ipc
```

### 9.7 T7 Old API removal + exact lint

**주요 touched files**

- `src/sdk/runtime/index.ts`
- `src/sdk/runtime/types.ts`
- `src/runner/orchestrate/*`
- `src/host/bootstrap/*`
- `tests/unit/*sdk*`
- `tests/unit/*hellgate*`
- `biome.json`

**필수 명령**

```sh
bun run typecheck
bunx @biomejs/biome check biome.json src/sdk/runtime src/runner/orchestrate src/host/bootstrap tests/unit
bun test tests/unit/*sdk* tests/unit/*hellgate*
```

## 10. 병렬 작업 가이드

### Wave 1-2 병렬화

- Worker A: protocol files
- Worker B: kernel state/reducer
- Worker C: replay-lite/lease/tests

주의:

- Worker B와 C는 `state.ts` shape freeze 이후 시작

### Wave 3 병렬화

- Worker A: llm/tool/shell/fs capability binding
- Worker B: persistence/review/artifact binding
- Worker C: capability derivation tests

### Wave 4 병렬화

- Worker A: runtime/session facade
- Worker B: subscription/ordering/runtime.close
- Worker C: SDK smoke tests

### Wave 5 병렬화

- Worker A: CLI cutover
- Worker B: Headless cutover
- Worker C: Batch cutover

조건:

- 세 worker 모두 `sdk/runtime/*` write ownership 없음
- shared SDK 수정은 별도 owner가 선행

### Wave 6 병렬화

- Worker A: stdio
- Worker B: websocket
- Worker C: conformance suite

---

## 11. Global DoD

다음이 모두 만족되어야 이 티켓은 완료다.

1. Runtime / Session public SDK가 존재한다.
2. CLI/headless/batch가 같은 SDK를 소비한다.
3. Web/Native도 같은 command/event contract를 사용할 수 있는 구조다.
4. later-turn state authority는 kernel 하나다.
5. approval은 protocol이다.
6. ArtifactRef가 protocol first-class다.
7. capability manifest는 host-derived다.
8. `SessionDeps`, `PromptSource`, `runInteractive`, `assembleConfig` 는 public contract가 아니다.
9. in-proc parity green.
10. stdio transport conformance green.
11. protocol/kernel/sdk import fence green.
12. non-surface terminal default green.
13. benchmark/product/ops ownership이 session SDK 안으로 역류하지 않는다.

하나라도 빠지면 partial이다.

---

## 12. Verification commands

각 wave 완료 시 최소 아래를 돌린다.

### 공통

```sh
bun run typecheck
bunx @biomejs/biome check <touched-files...>
```

### Wave 1

```sh
bun test tests/unit/protocol
```

### Wave 2

```sh
bun test tests/unit/kernel
```

### Wave 3

```sh
bun test tests/unit/host
```

### Wave 4

```sh
bun test tests/unit/sdk
```

### Wave 5

```sh
bun test tests/unit/apps/cli tests/unit/apps/headless tests/unit/apps/bench
```

### Wave 6

```sh
bun test tests/unit/ipc tests/integration/ipc
```

### Wave 7

```sh
bun test tests/unit/*sdk* tests/unit/*hellgate*
```

---

## 13. 실패 모드

반드시 조심할 것:

1. surface가 kernel state mirror를 다시 authority처럼 쓰는 것
2. capability manifest를 caller input으로 신뢰하는 것
3. approval을 callback seam으로 남기는 것
4. batch logic가 kernel/runtime 안으로 역류하는 것
5. event ordering metadata 없이 transport를 여는 것
6. replay-lite를 deterministic replay로 과장하는 것
7. placeholder `apps/web`, `apps/native` 를 먼저 만들어 noise를 키우는 것
8. runtime close 없이 transport / MCP / file handle을 누수시키는 것
9. expected revision conflict를 surface retry loop로 숨기는 것
10. approval.respond 와 pending approval correlation을 느슨하게 두는 것
11. corpus/admin/workflow ownership을 session SDK 안으로 밀어넣는 것

### 13.1 Rollback / kill-switch 규칙

- T5 cutover 동안 CLI old path는 feature flag로만 잠시 공존할 수 있다.
- flag 이름, default, 제거 시점은 같은 PR에 문서화한다.
- T6 transport는 conformance green 전까지 default-off다.
- kernel/schema 변경으로 snapshot decode가 깨지면 version bump 없이 덮어쓰지 않는다.
- partial rollback 시 surface rollback만 하고 protocol/kernel revision을 되감지 않는다. compatibility shim 또는 full revert 중 하나를 명시적으로 선택한다.

---

## 14. 작업자 체크리스트

구현자는 시작 전에 아래를 확인한다.

1. 지금 만지는 wave의 scope만 수정한다.
2. write set이 다른 worker와 겹치지 않는지 확인한다.
3. public API에 internal engine bag을 새로 노출하지 않는다.
4. `process.*` 를 protocol/kernel에 추가하지 않는다.
5. command/event metadata를 빼먹지 않는다.
6. 테스트 없이 "연결만 됨" 상태를 완료로 주장하지 않는다.
7. touched file 범위를 티켓 wave 밖으로 넓히면 이유를 PR 본문에 적는다.
8. old API를 건드리는 순간 T7 hellgate까지 같이 갱신한다.
9. 새 기능이 나오면 먼저 admission rule 5개로 분류한 뒤 구현 위치를 결정한다.

---

## 15. Closeout 규칙

closeout 메시지에는 반드시 아래를 포함한다.

1. 완료 wave / ticket id
2. 수정 파일 목록 요약
3. DoD 충족 항목
4. 실행한 검증 명령
5. 남은 리스크 / 다음 wave blocker

이 형식을 지키지 않으면 handoff 품질이 낮다고 본다.
