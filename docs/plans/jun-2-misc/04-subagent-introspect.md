# RFC: Subagent Introspection — `list_agents` + `followup_task`

상태: Draft (implementation-ready)
작성일: 2026-06-02
스코프: Codex `multi_agents_v2` 의 두 신규 도구(`list_agents`, `followup_task`) 흡수
ADR 제안: ADR-0435 (`list_agents`), ADR-0436 (`followup_task`) — 최신 점유 0434, 0435/0436 free 확인됨
기본값: **default-OFF** (두 도구 모두 새 슬라이스, 기존 코드 byte-identical)

---

## 0. 한 줄 요약

quanta 는 subagent 를 spawn/wait/close/send_input + rich mailbox(send/read) 까지 갖췄지만, **(a) 도구로 "지금 살아있는 자식이 누구인가"를 열거할 방법이 없고(registry 는 host-internal)**, **(b) send_input/mailbox 는 메시지를 QUEUE 만 하고 자식의 다음 loop iteration 까지 자식이 못 본다 — 즉시 turn 을 trigger 하는 경로가 없다.** Codex `list_agents` + `followup_task` 가 정확히 이 둘을 메운다. 본 RFC 는 기존 `TaskRegistry` snapshot + `InputChannelRegistry` + `MailboxPort` 를 재사용해 두 도구를 closed-port/DI/default-OFF 로 추가한다.

---

## 1. 경쟁사 근거 (Codex `multi_agents_v2`, codex-rs 0.135)

소스: `.extracted_source/codex/_codex-rs-0.135-symbols.txt`

핸들러 파일 인벤토리 (`:6071`, `:6390-6392`):

```
core/src/tools/handlers/multi_agents_v2/close_agent.rs        (:6071)
core/src/tools/handlers/multi_agents_v2/message_tool.rs       (:6072)
core/src/tools/handlers/multi_agents_v2/wait.rs               (:6073)
core/src/tools/handlers/multi_agents_v2/spawn.rs              (:6074)
core/src/tools/handlers/multi_agents_v2/list_agents.rs        (:6390)  ← 신규
core/src/tools/handlers/multi_agents_v2/send_message.rs       (:6391)
core/src/tools/handlers/multi_agents_v2/followup_task.rs      (:6392)  ← 신규
```

도구 설명 문자열 (`:50045`, `:50046`, verbatim):

- **list_agents** — `"Optional task-path prefix (not ending with trailing slash). Accepts the same relative or absolute task-path syntax."` + `"list_agentsList live agents in the current root thread tree. Optionally filter by task-path prefix."`
  - 핵심: **root thread tree 의 live agent 열거** + **task-path prefix 필터**(선택). 닫는 슬래시 없는 prefix.

- **send_message** (`:50045`) — `"send_messageSend a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn."`
  - 핵심: 메시지를 큐에 넣어 **promptly 전달하되 새 turn 은 trigger 하지 않음**. → quanta 의 `subagent_send_message` / `send_input` 와 동급(QUEUE-only).

- **followup_task** (`:50046`) — `"followup_taskSend a message to an existing non-root target agent and trigger a turn in that target. If the target is currently mid-turn, the message is queued and will be used to start the target's next turn, after the current turn completes."`
  - 핵심: ① **non-root target** 한정(root 금지), ② 메시지 전달 + **즉시 turn trigger**, ③ target 이 mid-turn 이면 **큐잉 후 다음 turn 시작**에 사용.
  - input(`:50046`): `"Agent id to message (from spawn_agent)."` / `message` (legacy plain text) / `items` (구조화) / `interrupt` boolean: `"When true, stop the agent's current task and handle this immediately. When false (default), queue this message."`

요약된 send_message vs followup_task 의 차이:

| | 전달 | turn trigger | target 제약 |
|---|---|---|---|
| `send_message` | promptly (queue) | **없음** | 없음 |
| `followup_task` | queue | **있음** (idle→즉시, mid-turn→다음 turn 시작) | **non-root only** |

---

## 2. quanta 현재 상태 (under-credit 금지 — mailbox 는 이미 rich)

### 2.1 이미 있는 것

- **TaskRegistry** (`src/subagent/registry.ts`)
  - `TaskRecord`: `{ id, description, agentType?, status, result?, error?, startedAt, endedAt? }` (`:14-25`)
  - `TaskStatus = "running" | "completed" | "failed" | "stopped"` (`:3`)
  - `list(): TaskRecord[]` — 전체 레코드 snapshot (`:107-109`)
  - `get(id): TaskRecord | undefined` (`:103-105`)
  - `pendingIds(): string[]` — running-only id snapshot (`:113-119`)
  - `waitForSettle(id)` — event-driven settle promise (`:197-201`)
  - settled-record LRU(`maxRetained=256`, `:31`, `:206-218`)
  - capability token (`stop(id, ownerToken)`, `:157-171`)

- **send_input** (`src/subagent/handlers-6.ts` `:670-698`)
  - `InputChannelRegistry` (`:637-666`): per-agent **one-shot** receiver. 자식이 "paused awaiting input" 상태일 때 runner 가 `register(agentId, receiver)` 등록 → `deliver(agentId, msg)` 가 receiver 호출 + 엔트리 제거.
  - `handleSendInput`: registry 에서 record 확인 → running 아니면 `not_running`, input channel 없으면 `not_paused`, 있으면 `deliver`. → **자식이 idle-wait 중일 때만 전달**, turn trigger 는 receiver 의 책임(현재 one-shot resume).

- **mailbox** (`src/tool/subagent-mailbox/index.ts` + `src/agent/subagent-mailbox/{types,store}.ts`)
  - `subagent_send_message` / `subagent_read_messages` 두 LLM 도구 (`:253-256`)
  - `MailboxPort` (`src/agent/subagent-mailbox/types.ts` `:79-104`): `send / read / peek / ack / list / pendingFor / toSnapshot / fromSnapshot`, **전부 NO-THROW**.
  - direct/broadcast, per-agent read cursor, correlationId request/response, per-sender undelivered quota(`:119-124`), 8KB body cap, control-char escape(sender spoofing 방지, `:197`).
  - **이미 Codex `send_message` parity** (헤더 `:8`). target 식별은 stable `agentLabel` 또는 depth fallback (`:97-98`).

- **background scheduler** (`src/agent/subagent-background.ts`)
  - `fork/poll/await/cancel/list/prune/serialize/hydrate` (`:99-136`), injected `now`/`idGen`, default-OFF (`:18-26`).
  - `list()` 는 background handle 만 — 6-tool registry 의 자식은 안 보임.

### 2.2 진짜 갭 (정확히 2개)

1. **열거 도구 부재**: `TaskRegistry.list()` 는 host-internal. LLM 이 "지금 running 인 자식 id/status 가 뭐냐"를 **도구로** 물을 수 없다. `wait_agent` 는 id 를 이미 알아야 하고, mailbox `read` 는 메시지를 보내온 자식만 보인다. → **`list_agents` 가 메움.**
2. **message + immediate-turn-trigger 부재**: `send_input` 은 자식이 **paused(one-shot channel 등록 상태)** 일 때만 전달, mailbox 는 자식이 **스스로 `read` 할 때까지** 안 보인다. 둘 다 **자식의 다음 loop iteration 을 능동적으로 깨우지 않는다.** Codex `followup_task` 의 "전달 + 즉시 turn 시작 / mid-turn 이면 다음 turn 에 사용"이 없다. → **`followup_task` 가 메움(mailbox 와 합성).**

> Under-credit 방지: quanta mailbox 는 Codex `send_message` 와 동급 이상(broadcast/correlation/quota/escape). `followup_task` 는 mailbox 를 **대체하지 않고** "wake/trigger" 신호를 얹는 합성물이다.

---

## 3. 목표 / 비목표

### 목표
- G1. LLM 이 도구 한 번으로 살아있는(+최근 settled) 자식을 열거 — id/status/depth/label/started_at.
- G2. prefix 필터(Codex task-path-prefix 의 quanta 등가 = id/label prefix).
- G3. LLM 이 target 자식에 메시지를 보내고 **즉시 그 자식의 turn 을 trigger** — idle 이면 즉시 wake, mid-turn 이면 큐잉 후 다음 turn.
- G4. 둘 다 closed-port / DI / default-OFF / slice-fenced / injected clock.

### 비목표
- N1. **mailbox 중복 금지.** `followup_task` 는 `MailboxPort.send` 로 전달을 합성하고 그 위에 wake 신호만 추가. 새 메시지 저장소를 만들지 않는다.
- N2. 새 persistence/스케줄러 도입 안 함. registry/mailbox 는 in-memory 그대로.
- N3. cross-restart 복원, 자식의 turn 결과를 동기로 반환(= `wait_agent` 가 담당) 안 함. `followup_task` 는 trigger 까지만 보장하고 결과는 `wait_agent`/mailbox 로 harvest.
- N4. background scheduler handle 통합 열거는 별도 RFC (본 RFC 의 `list_agents` 는 `TaskRegistry` 기준; background 통합은 follow-up).

---

## 4. Design A — `list_agents` 도구 (ADR-0435)

### 4.1 입력 / 출력 (contract)

`src/subagent/introspect-tools.ts` (신규 슬라이스, zod only) 에 contract + handler.

```ts
// 입력
export const ListAgentsInputSchema = z.object({
  // Codex "task-path prefix (not ending with trailing slash)" 등가:
  // quanta 에는 task-path 트리가 없으므로 id/label prefix 매칭.
  prefix: z.string().min(1).max(128).optional()
    .describe("Filter to agents whose id OR label starts with this prefix."),
  // settled(완료/실패/중단) 자식도 포함할지. 기본 false = live(running) only,
  // Codex "list LIVE agents" 시맨틱 보존.
  includeSettled: z.boolean().optional(),
  // 반환 상한 (registry maxRetained=256 과 동급의 안전 ceiling).
  limit: z.number().int().min(1).max(256).optional(),
}).strict()

// 출력 (per-agent)
export interface ListedAgent {
  id: string
  status: "running" | "settled" | "failed"  // 4-status 를 3-bucket 으로 narrow
  depth: number
  label: string          // agentType ?? description 앞부분 ?? id
  startedAt: number       // epoch ms
}
export const ListAgentsOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("success"), agents: z.array(/* ListedAgent */) }).strict(),
  ErrorShape, // tools-6 의 공유 ErrorShape 재사용
])
```

status bucketing: registry 의 `running` → `"running"`; `completed`/`stopped` → `"settled"`; `failed` → `"failed"`. (3-bucket 이 LLM 의사결정에 충분; 세부는 `wait_agent` 로.)

### 4.2 registry 재사용 + 누락 필드

`list_agents` 는 **read-only + concurrency-safe**: `TaskRegistry.list()` (`registry.ts:107`) 의 snapshot 만 읽는다. `list()` 는 `[...this.tasks.values()]` 복사본이라 호출 중 mutate 안전.

**TaskRecord 누락 필드(depth, label) 처리** — 두 옵션, 본 RFC 는 **옵션 B 채택**:

- 옵션 A: `TaskRecord` 에 `depth?: number` 추가. → registry.ts mutate(`:14-25`, `register()` `:86`) 필요. byte-identical 위반 리스크.
- **옵션 B(채택)**: registry 를 건드리지 않고 **`spawn_agent` 가 이미 아는 `childDepth`** (`handlers-6.ts:455`) 를 `description` 에 박지 않고, 별도 **side-table `AgentMetaRegistry`** (신규, 슬라이스 내) 에 `{ id → { depth, label } }` 기록. `list_agents` 가 `TaskRegistry.list()` + side-table join.
  - side-table 는 default-OFF deps: `spawn_agent` 가 주입받았을 때만 기록. 미주입 ⇒ `depth=0`, `label = agentType ?? description.slice(0,40) ?? id` fallback. → 기존 spawn 경로 byte-identical.

`label` 도출: `agentType` 우선(`TaskRecord.agentType`, `:17`), 없으면 `description` 앞 40자(`description` 은 spawn 시 prompt 앞 120자, `handlers-6.ts:477`), 그것도 없으면 `id`.

### 4.3 handler (pure, no-throw)

```ts
export interface ListAgentsDeps {
  registry: TaskRegistry
  agentMeta?: AgentMetaRegistry   // 옵션 B side-table (default-OFF)
}
export const handleListAgents = (input, deps): ListAgentsOutput => {
  const all = deps.registry.list()                       // concurrency-safe snapshot
  const wantSettled = input.includeSettled === true
  const limit = input.limit ?? 256
  const rows = all
    .map(rec => toListed(rec, deps.agentMeta))            // status bucket + depth/label join
    .filter(a => wantSettled ? true : a.status === "running")
    .filter(a => prefixMatch(input.prefix, a))            // id OR label startsWith
    .slice(0, limit)
  return { kind: "success", agents: rows }
}
```

순수 함수, 동기, throw 없음(zod 는 dispatch 에서 검증).

---

## 5. Design B — `followup_task` 도구 (ADR-0436)

### 5.1 입력 / 출력

```ts
export const FollowupTaskInputSchema = z.object({
  agentId: z.string().min(1).describe("Target agent id (from spawn_agent)."),
  message: z.string().min(1).max(8192)   // send_input/mailbox 8KB cap 정합
    .describe("Message delivered to the target before triggering its turn."),
  // Codex interrupt 등가. true=현재 task 중단 후 즉시 처리, false(default)=큐잉.
  interrupt: z.boolean().optional(),
}).strict()

export const FollowupTaskOutputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("success"),
    delivered: z.literal(true),
    triggered: z.boolean(),       // 즉시 wake 됐는지(idle) vs 큐잉됐는지(mid-turn)
  }).strict(),
  ErrorShape,
])
```

### 5.2 전달 + turn trigger 메커니즘 (mailbox 합성 + wake 신호)

**합성 2단계** (mailbox 를 대체하지 않음 — N1):

1. **전달**: `MailboxPort.send({ from: callerLabel, to: targetLabel, kind: "request", body: message })`. mailbox 의 모든 NO-THROW/quota/escape 보호를 그대로 상속. 자식이 다음에 `subagent_read_messages` 하거나 loop 가 inbox drain 시 본다.
2. **wake/trigger**: target 의 loop 에 "지금 turn 을 시작/예약하라" 신호. 이를 위한 **새 closed port `TurnWakeRegistry`** (신규, 슬라이스 내) 도입:

```ts
export type WakeOutcome = "woke" | "queued" | "no-receiver"
export class TurnWakeRegistry {
  private readonly wakers = new Map<string, (reason: string) => WakeOutcome>()
  // runner 가 자식 loop 시작 시 등록(disposer 반환). InputChannelRegistry 와
  // 형제 — 단 one-shot 이 아니라 persistent(loop 수명 동안 유지).
  register(agentId: string, waker: (reason: string) => WakeOutcome): () => void
  has(agentId: string): boolean
  // idle-wait 면 즉시 turn 시작(→"woke"), mid-turn 이면 pending wake 마킹(→"queued").
  wake(agentId: string, reason: string): WakeOutcome   // no-receiver ⇒ "no-receiver"
}
```

- runner-side 계약(자식 loop 가 구현): waker 호출 시 ① 자식이 idle(다음 입력 대기) 이면 **즉시 다음 turn 을 enqueue→"woke"**, ② mid-turn 이면 **pending-wake 플래그 set, 현재 turn 종료 후 자동으로 한 turn 더 → "queued"**. Codex 시맨틱 정확 매칭.
- `interrupt:true` 면 runner 가 현재 turn 의 abort signal 을 fire 한 뒤 wake (= Codex "stop the agent's current task and handle this immediately"). `TurnWakeRegistry.wake(agentId, reason)` 의 `reason` 에 `"interrupt"` 전달 → runner 가 분기. (abort 자체는 registry 의 per-task AbortController 가 아니라 **turn-level** abort 이어야 하므로 runner 책임; port 는 신호만 전달.)

> 왜 `InputChannelRegistry` 를 그대로 안 쓰나: `InputChannelRegistry.deliver` 는 **one-shot**(`channels.delete` 후 receiver 호출, `handlers-6.ts:653-665`) + "paused awaiting input" 전용. `followup_task` 는 paused 가 아닌 **busy/idle running** 자식도 깨워야 하고, loop 수명 동안 반복 wake 가능해야 한다. 그래서 persistent `TurnWakeRegistry` 가 형제로 필요. (단, idle-paused 자식의 경우 runner 가 waker 안에서 `InputChannelRegistry` resume 을 호출하도록 wiring 가능 — 두 port 는 runner 가 조합.)

### 5.3 handler

```ts
export interface FollowupTaskDeps {
  registry: TaskRegistry
  mailbox: MailboxPort
  wake: TurnWakeRegistry
  callerLabel: string            // ctx 에서 도출(senderId 와 동일 규칙)
  resolveLabel?: (agentId: string) => string  // id→mailbox label 매핑(없으면 id 그대로)
}
export const handleFollowupTask = (input, deps): FollowupTaskOutput => {
  const rec = deps.registry.get(input.agentId)
  if (rec === undefined) return err("No agent found", "id_unknown")
  if (rec.status !== "running") return err(`target settled (status=${rec.status})`, "settled")
  // (root 정책은 §6 참조)
  const to = deps.resolveLabel?.(input.agentId) ?? input.agentId
  deps.mailbox.send({ from: deps.callerLabel, to, kind: "request", body: input.message })  // 전달
  const reason = input.interrupt === true ? "interrupt" : "followup"
  const outcome = deps.wake.wake(input.agentId, reason)                                     // trigger
  if (outcome === "no-receiver")
    return err("target has no live turn-wake receiver", "no_waker")
  return { kind: "success", delivered: true, triggered: outcome === "woke" }
}
```

순수/동기/no-throw. 전달은 mailbox 가 보장(NO-THROW), trigger 는 wake port 가 outcome 으로 보고.

---

## 6. Edge cases & 정책 결정

| 케이스 | list_agents | followup_task |
|---|---|---|
| target not found | (열거이므로 N/A — 단순히 미포함) | `kind:"error", cause:"id_unknown"` (registry.get undefined) |
| target already settled | `includeSettled` 시 status=settled/failed 로 표시 | `kind:"error", cause:"settled"` (running 아님) |
| self-targeting | N/A | **허용하되 권장 안 함**. caller==target 이면 mailbox 가 자기-broadcast 처럼 동작; wake 는 자기 loop 재진입 위험 → **handler 에서 `agentId === own id` 면 `cause:"self_target"` 로 거부**(runner 가 own id 를 deps 에 주입하면). own id 미주입 ⇒ 통과(runner 책임). |
| depth limit | 출력에 depth 표시만(제한 없음) | N/A (spawn 아님) |
| message to root | N/A | **Codex 정책 채택: non-root only.** root(depth 0 / `id`가 root-marker) 를 target 하면 `cause:"root_forbidden"`. 이유: root 는 사용자-facing 메인 loop — 자식이 root 의 turn 을 trigger 하면 사용자 의도와 충돌. quanta 도 동일 금지. (단, 자식→부모 정보 전달은 mailbox `to:"parent"` 로 이미 가능, trigger 없이.) |
| trigger on busy child | N/A | `wake` → `"queued"` (mid-turn). output `triggered:false`, `delivered:true`. 현재 turn 종료 후 자동 1 turn. |
| includeSettled=false 인데 running 0 | `agents:[]` (성공) | N/A |
| prefix 매칭 0건 | `agents:[]` (성공) | N/A |
| interrupt=true on idle child | N/A | abort 불필요(이미 idle) → runner 가 abort skip, 즉시 wake → `triggered:true` |
| wake receiver 미등록(자식이 wake port 미구현) | N/A | `cause:"no_waker"` — 전달은 됐으나 trigger 불가. **mailbox 전달은 유지**(자식이 다음 read 시 봄). honest degradation. |

root 식별: `TaskRegistry` 에는 root 레코드가 없음(root=메인 loop, registry 미등록). 따라서 `followup_task` 의 root 금지는 자연 충족(존재하는 agentId 는 전부 자식). 단 명시적으로 `id_unknown` 가 root 시도를 커버. depth=0 자식은 spawn 으로 안 생기므로(자식 최소 depth=1, `handlers-6.ts:455`) 추가 가드 불필요.

---

## 7. 통합 (registry / mailbox / input channels 공유)

### 7.1 도구 그룹 편입

두 도구는 **6-tool set 의 확장**(`agent-tools-6.ts` 의 `createSubagent6Tools`)에 옵트인으로 합류. 6-tool 은 이미 `config.subagent.enable6Tools` 게이트(`agent-tools-6.ts:23` 헤더). 새 게이트 추가:

- `config.subagent.enableIntrospect === true` ⇒ `list_agents` 노출 (registry 만 필요).
- `config.subagent.enableFollowup === true` ⇒ `followup_task` 노출 (registry + mailbox + wake 필요).
- 둘 다 absent/false ⇒ 빌더가 두 도구를 안 만듦 ⇒ ToolRegistry byte-identical.

`SUBAGENT_6_TOOL_NAMES`(`tools-6.ts:23`) 는 **frozen ADR-0041 closed set 이므로 건드리지 않는다.** 두 신규 도구는 별도 빌더(`introspect-tools.ts` 의 `createIntrospectTools(deps)`)로, 6-tool 빌더가 게이트에 따라 스프레드. (mailbox 빌더 `subagentMailboxTools` 와 동일 패턴.)

### 7.2 공유 substrate

| 공유 자원 | 누가 소유 | list_agents | followup_task |
|---|---|---|---|
| `TaskRegistry` | host (단일 인스턴스, 6-tool 과 공유) | `.list()` read | `.get(id)` read |
| `MailboxPort` | host (mailbox 도구와 공유 인스턴스) | — | `.send()` |
| `InputChannelRegistry` | host (`send_input` 과 공유) | — | (runner 가 wake 안에서 선택적 사용) |
| `TurnWakeRegistry` (신규) | host (runner 가 register, followup 이 wake) | — | `.wake()` |
| `AgentMetaRegistry` (신규, 옵션 B) | host (spawn 이 write, list 가 read) | join | — |

runner-side wiring (`src/agent/subagent-runner.ts` 또는 tier1 composer):
- 자식 loop 시작 시 `wakeRegistry.register(agentId, waker)` 등록(disposer 를 loop 종료 시 호출).
- spawn 시 `agentMeta.set(agentId, { depth: childDepth, label })`.
- 둘 다 deps 주입이 없으면(default-OFF) no-op — 기존 경로 불변.

---

## 8. 테스트 계획 (hellgate)

파일: `tests/subagent/introspect-hellgate.test.ts` (신규)

### list_agents
1. **반영성**: 2개 spawn → `list_agents` 가 running 2개 반환(id 일치). 1개 settle → `includeSettled:false` 면 1개, `true` 면 2개(status 정확).
2. **status bucketing**: completed→settled, stopped→settled, failed→failed 정확.
3. **prefix 필터**: id/label prefix 로 부분집합. 닫는 슬래시 없는 prefix(Codex 시맨틱). 매칭 0건 ⇒ `agents:[]` 성공.
4. **concurrency-safe**: `list()` 결과 순회 중 다른 자식 settle 해도 throw/오염 없음(snapshot 복사 검증).
5. **depth/label**: agentMeta 주입 시 depth/label join; 미주입 시 depth=0 + description fallback.
6. **limit**: limit=1 이면 1개만.

### followup_task
7. **delivers + triggers (observable)**: idle 자식에 followup → mailbox 에 메시지 1건 존재(`port.list({to})`) **AND** wake receiver 호출됨(`triggered:true`). spy waker 로 turn 시작 관찰.
8. **mid-turn 큐잉**: busy 자식(waker 가 "queued" 반환) → `triggered:false, delivered:true`, 메시지는 여전히 전달.
9. **interrupt**: `interrupt:true` → waker 가 `reason:"interrupt"` 수신.
10. **target-not-found**: 미존재 id → `cause:"id_unknown"`, mailbox 미전송(부작용 없음).
11. **settled-target**: settle 된 자식 → `cause:"settled"`, 전송/wake 없음.
12. **no-waker degradation**: wake receiver 미등록 → `cause:"no_waker"` 지만 **mailbox 전달은 성공**(honest degradation, 메시지 존재 검증).
13. **self-target**: own id 주입 시 `cause:"self_target"`.
14. **root-forbidden**: registry 에 없는(=root) id → `cause:"id_unknown"` (root 시도 커버).

### default-OFF byte-identical
15. **게이트 OFF**: `enableIntrospect`/`enableFollowup` absent ⇒ ToolRegistry 에 두 도구 부재, 기존 6-tool/mailbox snapshot byte-identical (도구 이름 배열 비교).
16. **injected clock**: `startedAt` 이 주입 clock 값과 일치(determinism).

NO-THROW fuzz: 16MB body / 비정상 prefix / 음수 limit 등 → zod 거부 또는 graceful, throw 없음.

---

## 9. File-by-file 변경 목록

신규 (슬라이스, 전부 default-OFF):
- `src/subagent/introspect-tools.ts` — contract(zod) + `handleListAgents` + `handleFollowupTask` + `createIntrospectTools(deps)`. 슬라이스 fence: `zod`, `./registry`(type), `@/agent/subagent-mailbox`(type), `@/tool`(Tool/ToolEvent), `@/shared`. **NO `@/agent` core.**
- `src/subagent/turn-wake.ts` — `TurnWakeRegistry` (형제 of `InputChannelRegistry`). `node:` 불필요, 순수.
- `src/subagent/agent-meta.ts` — `AgentMetaRegistry` side-table (옵션 B). 순수.
- `tests/subagent/introspect-hellgate.test.ts` — §8.
- `docs/decisions/0435-list-agents-tool.md`
- `docs/decisions/0436-followup-task-tool.md`

수정 (최소, 게이트 추가만):
- `src/subagent/agent-tools-6.ts` — `enableIntrospect`/`enableFollowup` 게이트에서 `createIntrospectTools` 스프레드 (게이트 OFF 시 변화 없음).
- `src/subagent/types.ts` — (필요 시) `SubagentRunner` 가 wake/meta 등록할 수 있는 선택 hook 타입만. **registry.ts / tools-6.ts / handlers-6.ts / dispatch-6.ts 는 mutate 하지 않음** (frozen contract + byte-identical).
- `apps/agent` composition-root (또는 tier1 composer) — host 가 `TurnWakeRegistry`/`AgentMetaRegistry` 인스턴스 생성 + runner wiring (게이트 ON 일 때만). default-OFF.

> registry/mailbox/6-tool contract 불변(옵션 B 채택 이유). 새 상태는 전부 신규 side-port 로 격리.

---

## 10. ADR 제안

- **ADR-0435 — `list_agents` tool**: read-only 자식 열거. TaskRegistry snapshot + AgentMetaRegistry join. prefix 필터. default-OFF. (Codex `multi_agents_v2/list_agents` 흡수.)
- **ADR-0436 — `followup_task` tool**: mailbox `send` 합성 + `TurnWakeRegistry` wake. non-root only, interrupt 지원, mid-turn 큐잉. default-OFF. (Codex `multi_agents_v2/followup_task` 흡수; `send_message`=mailbox 와의 차이=turn trigger 명시.)

최신 점유: 0434 (`permission-profile-list-select`). 0435/0436 free 확인 (`ls docs/decisions/` 2026-06-02).

---

## 11. Effort

| 항목 | 규모 |
|---|---|
| `introspect-tools.ts` (2 handler + builder + zod) | ~250 LOC |
| `turn-wake.ts` + `agent-meta.ts` | ~80 LOC |
| agent-tools-6 게이트 + runner wiring | ~40 LOC |
| hellgate 16+ cases | ~350 LOC |
| 2 ADR + catalog row | — |
| **합계** | ~1 일, 1 슬라이스 |

리스크: 낮음. registry/mailbox/6-tool contract 불변. 전부 신규 default-OFF 슬라이스. 유일한 비자명 부분은 `TurnWakeRegistry` 의 runner-side 계약(idle→woke / mid-turn→queued) — runner wiring 은 follow-up PR 로 분리 가능(port 만 먼저 land, default-OFF).

---

## 12. SOTA++ 체크리스트

- [x] TaskRegistry `list()`/`get()` 재사용 (registry mutate 0)
- [x] MailboxPort `send()` 재사용 (followup 이 mailbox 대체 안 함 — N1)
- [x] InputChannelRegistry 형제로 `TurnWakeRegistry` (one-shot vs persistent 구분 명시)
- [x] no globals — 전부 deps 주입
- [x] slice-fenced — `@/agent` core import 없음
- [x] injected clock — `startedAt`/wake reason 결정성 (테스트 16)
- [x] default-OFF 3중 (게이트 / deps 미주입 no-op / 빌더 미호출)
- [x] NO-THROW — zod boundary + mailbox/wake graceful
- [x] honest degradation — no_waker 여도 mailbox 전달 유지
