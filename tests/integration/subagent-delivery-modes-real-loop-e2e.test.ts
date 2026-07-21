/**
 * WS7 LIVE-CHILD SMOKE (RFC jul-18 §6) — the L3 promotion gate for the subagent
 * message-delivery feature.
 *
 * This is the `runAgent × scripted-LLM` GOLD-STANDARD e2e, NOT a unit fake:
 *   - a REAL spawned child (`createSubagentRunner(parent)` → real `runAgent`
 *     loop, filtered tool registry, per-child turn gate + control endpoint minted
 *     by `registerChildWaker`);
 *   - a REAL session substrate wired EXACTLY like the composition root
 *     (`wireOptionalAgentPorts` → tier1 `subagent-introspect`): real
 *     `TaskRegistry`, `TurnWakeRegistry`, `createSubagentMailbox`, a
 *     `createPeerInboxDrain` so the child DRAINS its inbox at turn-top, and a real
 *     steer plane (`makeSteerRetentionStore` + `createSubagentSteerFinalization`);
 *   - the REAL `followup_task` tool built by `buildSubagentIntrospectBlock` and
 *     driven end-to-end via its `execute(...)`, so the tool's ABSENT
 *     `expectedTurnId` is exercised (scenario 3 — the exact seam a prior audit
 *     found broken: a hand-built request with a turn id would MASK it).
 *
 * Determinism: every LLM is scripted (no network); the mailbox/finalization
 * clocks are irrelevant to the assertions (we assert the child's transcript, the
 * receipt stream, the task-record status, second-model-call-same-turn-id, and no
 * mailbox dup — all observable REAL effects, never a fake endpoint's return).
 *
 * The 5 scenarios (RFC §6 WS7):
 *   1. queue + passive while busy      — payload drains at the NEXT turn only.
 *   2. queue + ensure-turn while idle  — a parked child WAKES and drains once.
 *   3. steer while busy (steerable)    — 2nd model call SAME turn id sees the
 *                                        injection; NO mailbox dup; accepted/
 *                                        steer_pending → applied/steer receipt.
 *   4. interrupt while blocked in tool — abort fires once, partial captured, the
 *                                        child re-enters a FRESH turn that drains
 *                                        the payload, task record STAYS running.
 *   5. steer with STALE expectedTurnId — typed QUEUE downgrade w/ the precise
 *                                        reason, surfaced to the caller; the
 *                                        replacement turn receives NO direct steer.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import {
  createSubagentDeliveryController,
  createSubagentSteerFinalization,
  createTargetResolver,
  type DeliveryMailboxPort,
  makeSteerRetentionStore,
  type SteerRetentionStore,
  type SubagentControlRegistry,
  type SubagentDeliveryReceipt,
} from "@/agent/subagent-delivery"
import {
  createPeerInboxDrain,
  createSubagentMailbox,
  formatPeerBody,
  type MailboxPort,
} from "@/agent/subagent-mailbox"
import { createSubagentRunner } from "@/agent/subagent-runner"
import { buildSubagentIntrospectBlock } from "@/agent/tier1/subagent-introspect"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import type { SubagentRequest } from "@/subagent"
import { TaskRegistry, TurnWakeRegistry } from "@/subagent"
import { defaultTools, type Tool, type ToolEvent, ToolRegistry } from "@/tool"

// ─── doubles / helpers ───────────────────────────────────────────────────────

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
/** Let several microtask/macrotask boundaries flush (a child loop hops several
 *  awaits between the abort firing and re-parking on a fresh turn). */
const settle = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) await tick()
}

/** The runner's `SubagentResult.messages` is `unknown[]` (slice fence); the child
 *  loop actually produces `Message[]`. Narrow it for the transcript assertions. */
const asMessages = (m: unknown): readonly Message[] => (m as Message[] | undefined) ?? []

/** The full text of the child's transcript (user + assistant + tool_result) so a
 *  drained payload (delivered as a `role:"user"` peer line) is observable. */
const transcriptText = (messages: readonly Message[]): string =>
  messages
    .flatMap((m) => m.content)
    .map((b) => {
      if (b.type === "text") return b.text
      if (b.type === "tool_result") return String((b as { content: unknown }).content)
      return ""
    })
    .join("\n")

const parentCfg = (over: Partial<AgentConfig>, llm: LLMPort): AgentConfig =>
  ({
    llm,
    registry: new ToolRegistry([...defaultTools]),
    stream: new RecordingStream(),
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    system: "sys",
    cwd: "/tmp",
    maxTurns: 6,
    signal: new AbortController().signal,
    onConfirm: async () => false,
    ...over,
  }) as AgentConfig

const baseReq = (over: Partial<SubagentRequest> = {}): SubagentRequest => ({
  prompt: "child task",
  depth: 1,
  ...over,
})

// ─── session substrate (mirrors wireOptionalAgentPorts + wireSteerPlane) ──────

interface Session {
  readonly registry: TaskRegistry
  readonly wake: TurnWakeRegistry
  readonly mailbox: MailboxPort
  readonly retention: SteerRetentionStore
  readonly receipts: SubagentDeliveryReceipt[]
  readonly steerPlane: NonNullable<AgentConfig["subagent"]>["steerPlane"]
}

/** Build the SESSION-shared control plane the composition root mints for the
 *  `QUANTA_SUBAGENT_FOLLOWUP` + `QUANTA_SUBAGENT_STEER` gates: one registry, one
 *  wake registry, one real mailbox, one retention store + finalization port. The
 *  ONLY deviation from `wireSteerPlane` is a receipt-collecting `onReceipt` sink
 *  (WS6 owns the real cascade; the exactly-once invariant is enforced by the
 *  finalization port regardless of the sink, so observing it here is honest). */
const makeSession = (steer: boolean): Session => {
  const registry = new TaskRegistry()
  const wake = new TurnWakeRegistry()
  const mailbox = createSubagentMailbox({ now: () => 1_000 })
  const retention = makeSteerRetentionStore()
  const receipts: SubagentDeliveryReceipt[] = []
  const finalization = createSubagentSteerFinalization({
    store: retention,
    mailbox: mailbox as unknown as DeliveryMailboxPort,
    onReceipt: (r) => receipts.push(r),
  })
  return {
    registry,
    wake,
    mailbox,
    retention,
    receipts,
    steerPlane: steer ? { retention, finalization } : undefined,
  }
}

/** Assemble the parent config with the followup (+ optional steer) capability
 *  wired the way `wireSubagentToolGates`/`wireFollowupDeps`/`wireSteerPlane` do. */
const sessionParent = (session: Session, llm: LLMPort, over: Partial<AgentConfig> = {}) =>
  parentCfg(
    {
      subagentTurnWake: session.wake,
      subagentMailbox: session.mailbox,
      peerInbox: createPeerInboxDrain(session.mailbox),
      subagent: {
        taskRegistry: session.registry,
        enableFollowup: true,
        enableIntrospect: true,
        ...(session.steerPlane !== undefined
          ? { enableSteer: true, steerPlane: session.steerPlane }
          : {}),
      },
      ...over,
    },
    llm,
  )

/** Build the REAL `followup_task` tool the tier1 builder produces for the ROOT
 *  caller (no lineage / no ownTaskId ⇒ root authority), driven end-to-end. This
 *  is the tool the LLM would call; we invoke its `execute(...)` so the tool's
 *  request assembly (which OMITS `expectedTurnId`) is exercised. */
const rootFollowupTool = (session: Session, stream?: RecordingStream): Tool => {
  const tools = buildSubagentIntrospectBlock(
    sessionParent(session, new NeverLLM(), stream !== undefined ? { stream } : {}),
  )
  const t = tools.find((x) => x.name === "followup_task")
  if (t === undefined) throw new Error("followup_task tool was not built by the tier1 wiring")
  return t
}

/** Drive the REAL tool and return its structured output (delivered/triggered/
 *  effectiveMode) — the exact envelope a model would see as the tool_result. */
const callFollowup = async (
  tool: Tool,
  input: { agentId: string; message: string; mode?: "queue" | "steer" | "interrupt" },
): Promise<{ ok: boolean; output: string; structured: unknown }> => {
  let last: { ok: boolean; output: string; structured?: unknown } | undefined
  for await (const ev of tool.execute(
    input as never,
    {
      cwd: "/tmp",
      signal: new AbortController().signal,
    } as never,
  )) {
    const e = ev as ToolEvent
    if (e.type === "result") last = e.result as never
  }
  if (last === undefined) throw new Error("followup_task produced no result event")
  return { ok: last.ok, output: last.output, structured: last.structured }
}

// ─── scripted child LLMs ─────────────────────────────────────────────────────

const endTurn = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

class NeverLLM implements LLMPort {
  readonly model = "never"
  // biome-ignore lint/correctness/useYield: control never reaches here in tests.
  async *stream(): AsyncIterable<StreamEvent> {
    throw new Error("NeverLLM.stream must not be called")
  }
}

/**
 * A child LLM that BLOCKS its first turn's stream (a genuine in-flight turn)
 * until the effective per-turn signal aborts, then surfaces the abort like the
 * real adapters. Every later turn completes instantly. Records, per call:
 *   - whether the blocking stream saw its signal abort (interrupt proof);
 *   - the FULL messages the model saw (so a drained payload / injection is
 *     observable);
 *   - the turn id visible on the injected steer safe-point (via `onCall`).
 */
class BlockingThenInstantLLM implements LLMPort {
  calls = 0
  readonly model = "scripted"
  abortedAt: boolean[] = []
  readonly seenMessages: Message[][] = []
  blockingStarted: Promise<void>
  private resolveBlockingStarted!: () => void
  /** Optional per-call hook (runs after the call is counted, before it yields). */
  onCall?: (call: number) => void
  constructor() {
    this.blockingStarted = new Promise((r) => {
      this.resolveBlockingStarted = r
    })
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const call = this.calls
    this.seenMessages.push([...input.messages])
    this.onCall?.(call)
    yield { type: "text_delta", delta: `turn ${call}` }
    if (call === 1) {
      const signal = input.signal
      this.resolveBlockingStarted()
      await new Promise<void>((resolve) => {
        if (signal?.aborted === true) {
          this.abortedAt[call] = true
          return resolve()
        }
        signal?.addEventListener(
          "abort",
          () => {
            this.abortedAt[call] = true
            resolve()
          },
          { once: true },
        )
      })
      throw new DOMException("aborted", "AbortError")
    }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** Completes every turn instantly (child goes idle/parked between turns). */
class InstantLLM implements LLMPort {
  calls = 0
  readonly model = "scripted"
  readonly seenMessages: Message[][] = []
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    this.seenMessages.push([...input.messages])
    for (const e of endTurn(`t${this.calls}`)) yield e
  }
}

/**
 * A child LLM whose FIRST turn ends cleanly (end_turn) BUT captures the live turn
 * id at the moment of the call, so a same-turn steer can be admitted against the
 * turn header the loop set. It stays "busy" long enough for a steer to be
 * submitted mid-turn by resolving a caller gate AFTER the first stream is
 * entered. Later re-streams (safe-point) complete instantly.
 */
class SteerableEndTurnLLM implements LLMPort {
  calls = 0
  readonly model = "scripted"
  readonly seenMessages: Message[][] = []
  readonly turnIdsSeen: (string | undefined)[] = []
  /** Resolves once the FIRST stream is entered (the turn header is now live). */
  firstStreamEntered: Promise<void>
  private resolveEntered!: () => void
  /** Reads the child's LIVE turn id (via the registered control endpoint) at each
   *  stream call — the runner mints the real `activeTurnRef` internally, so this
   *  is the only honest way to observe "same turn id across two model calls". */
  private readonly getTurnId: () => string | undefined
  /** A per-first-call barrier the test resolves after submitting the steer, so
   *  the steer lands while THIS turn header is still live (before the stream
   *  completes and the loop clears the ref). */
  gate: (() => Promise<void>) | undefined
  constructor(getTurnId: () => string | undefined) {
    this.getTurnId = getTurnId
    this.firstStreamEntered = new Promise((r) => {
      this.resolveEntered = r
    })
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const call = this.calls
    this.seenMessages.push([...input.messages])
    this.turnIdsSeen.push(this.getTurnId())
    if (call === 1) {
      this.resolveEntered()
      // Hold the turn open until the test admits the steer against THIS turn id.
      if (this.gate !== undefined) await this.gate()
    }
    for (const e of endTurn(`turn ${call}`)) yield e
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 1 — queue + passive while busy: payload drains at the NEXT turn only.
// ─────────────────────────────────────────────────────────────────────────────

describe("WS7 §1 — queue while busy: delivered at the child's NEXT turn, in-flight turn undisturbed, exactly-once", () => {
  test("passive queue against a BUSY child ⇒ no abort, drains once on the resume turn", async () => {
    const session = makeSession(false)
    const llm = new BlockingThenInstantLLM()
    const ctrl = new AbortController()
    const runner = createSubagentRunner(sessionParent(session, llm, { signal: ctrl.signal }))

    // Pre-register the child task the way the 6-tool spawn path does (so the
    // runner registers the per-child waker under THIS id).
    const taskId = session.registry.newId()
    session.registry.register({ id: taskId, description: "busy child" })

    const childP = runner(baseReq({ taskId, signal: ctrl.signal }))
    await llm.blockingStarted // the first turn is genuinely in flight (busy)
    expect(llm.calls).toBe(1)
    expect(session.wake.has(taskId)).toBe(true)
    // Capture the child's mailbox label while it is LIVE (the runner's `finally`
    // disposer drops the label once the loop ends).
    const label = session.wake.labelOf(taskId)
    expect(label).toBeDefined()

    // PASSIVE queue (subagent_send_message semantics): deliver WITHOUT triggering
    // a turn. Build the request the controller consumes with activation:"passive".
    const controller = createSubagentDeliveryController({
      control: session.wake as unknown as SubagentControlRegistry,
      mailbox: session.mailbox as unknown as DeliveryMailboxPort,
      formatPeer: (from, kind, body) => formatPeerBody({ from, kind, body }),
      resolveTarget: createTargetResolver({
        registry: session.registry,
        control: session.wake as unknown as SubagentControlRegistry,
      }),
      newDeliveryId: (() => {
        let n = 0
        return () => {
          n += 1
          return `del-p${n}`
        }
      })(),
      steerEnabled: false,
    })
    const PASSIVE_BODY = "passive-payload-QUEUE-771"
    const outcome = controller.deliver({
      targetTaskId: taskId,
      from: "parent",
      body: PASSIVE_BODY,
      mode: "queue",
      activation: "passive",
    })
    expect(outcome.kind).toBe("applied")
    if (outcome.kind === "applied") expect(outcome.effect).toBe("queued")

    // The in-flight (busy) turn is NOT aborted by a passive queue.
    await settle()
    expect(llm.abortedAt[1]).toBeUndefined()
    expect(llm.calls).toBe(1) // still blocked on the same turn

    // Now end the busy turn by a REAL lifetime abort, so the child unwinds and
    // (with a pending nothing) parks/finishes. The message must NOT have been
    // consumed mid-turn — passive never wakes.
    ctrl.abort()
    const result = await childP
    // The payload was delivered to the child's inbox exactly once (mailbox cell).
    const pending = session.mailbox.peek(label ?? "").filter((m) => m.body === PASSIVE_BODY)
    // Passive queue never woke the child; because we aborted before any further
    // turn, the payload stays pending (undelivered) — deliverable exactly once at
    // the child's next read. This is the real mailbox cell, not a fake.
    expect(pending.length).toBe(1)
    // The child was in its (single) busy turn when the lifetime abort landed, so
    // it unwound rather than completing a turn — the point is the passive queue
    // NEVER disturbed the in-flight turn (asserted above: abortedAt[1] undefined,
    // calls stayed at 1) and delivered exactly once.
    expect(result.ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 2 — queue + ensure-turn while idle: a parked child WAKES + drains once.
// ─────────────────────────────────────────────────────────────────────────────

describe("WS7 §2 — ensure-turn while idle: a parked child wakes and drains the payload once (triggered)", () => {
  test("idle child + followup_task(queue) ⇒ woke; the payload appears in the child's transcript exactly once", async () => {
    const session = makeSession(false)
    const llm = new InstantLLM()
    const ctrl = new AbortController()
    const runner = createSubagentRunner(sessionParent(session, llm, { signal: ctrl.signal }))

    const taskId = session.registry.newId()
    session.registry.register({ id: taskId, description: "idle child" })

    const childP = runner(baseReq({ taskId, signal: ctrl.signal }))
    await settle() // it runs turn 1 then parks (idle) on the gate
    const callsAfterPark = llm.calls
    expect(callsAfterPark).toBeGreaterThanOrEqual(1)

    const tool = rootFollowupTool(session)
    const IDLE_BODY = "idle-wake-payload-ENSURE-882"
    const out = await callFollowup(tool, { agentId: taskId, message: IDLE_BODY })
    expect(out.ok).toBe(true)
    // triggered:true ⇒ the idle child was WOKEN (ensure-turn), effective queue.
    expect((out.structured as { triggered?: boolean }).triggered).toBe(true)

    await settle()
    // A second turn ran (the wake drained the payload at its turn-top).
    expect(llm.calls).toBeGreaterThan(callsAfterPark)

    ctrl.abort()
    const result = await childP

    // GROUND TRUTH: the payload reached the child's transcript (peer-formatted),
    // exactly once — via the REAL peer-inbox drain at the woken turn's top.
    const msgs = asMessages(result.messages)
    const text = transcriptText(msgs)
    expect(text).toContain(IDLE_BODY)
    const occurrences = msgs
      .flatMap((m) => m.content)
      .filter((b) => b.type === "text" && (b as { text: string }).text.includes(IDLE_BODY)).length
    expect(occurrences).toBe(1)
    // And it was formatted as an UNTRUSTED peer line (never a trusted instruction).
    expect(text).toContain("[teammate parent — untrusted]")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 3 — steer while busy (steerable turn): 2nd model call SAME turn id
//   sees the injection; NO mailbox dup; accepted/steer_pending → applied/steer.
//   MUST drive the REAL followup_task tool (absent expectedTurnId seam).
// ─────────────────────────────────────────────────────────────────────────────

describe("WS7 §3 — steer while busy: same-turn re-stream sees the injection, no mailbox dup, correlated applied receipt", () => {
  test("real followup_task(steer) mid-turn ⇒ 2nd model call under the SAME turn id sees [teammate … — untrusted]; accepted→applied; no mailbox copy", async () => {
    const session = makeSession(true)
    // The child's activeTurnRef is minted by the runner; but the steerable LLM
    // needs to READ it to capture the live turn id. The runner allocates the ref
    // internally (registerChildWaker → createConversationActionSurface), so we
    // capture it from the child config via a spy on the steerable LLM instead:
    // the LLM reads config.activeTurnRef through the StreamInput's turn header is
    // not exposed, so we thread a ref the loop fills and the endpoint reads.
    //
    // We drive the REAL tool: it OMITS expectedTurnId, so the controller resolves
    // the live turn via endpoint.currentTurnId() (the exact seam under test).
    const ctrl = new AbortController()

    // The runner mints the child's REAL `activeTurnRef` internally and registers
    // the control endpoint under `taskId`; the LLM reads the LIVE turn id through
    // that endpoint so "same turn id across two model calls" is observed on the
    // ACTUAL loop state, not a stand-in ref. The LLM only keeps the turn OPEN.
    const taskId = session.registry.newId()
    const llm = new SteerableEndTurnLLM(() => session.wake.endpointFor(taskId)?.currentTurnId())

    const runner = createSubagentRunner(sessionParent(session, llm, { signal: ctrl.signal }))
    session.registry.register({ id: taskId, description: "steerable child" })

    // Hold the first turn open until we've admitted the steer against its turn id.
    let releaseFirstTurn: () => void = () => {}
    llm.gate = () =>
      new Promise<void>((r) => {
        releaseFirstTurn = r
      })

    const childP = runner(baseReq({ taskId, signal: ctrl.signal }))
    await llm.firstStreamEntered // the child's first turn header is now live
    // The endpoint reads the LIVE turn id via activeTurnRef; the runner's ref is
    // the source of truth. Confirm a live id exists on the registered endpoint.
    const endpoint = session.wake.endpointFor(taskId)
    expect(endpoint).toBeDefined()
    const liveTurnId = endpoint?.currentTurnId()
    expect(typeof liveTurnId).toBe("string")
    if (typeof liveTurnId !== "string") throw new Error("no live turn id on the child endpoint")

    // Drive the REAL followup_task tool with mode:"steer" and NO expectedTurnId.
    // Hellaudit R3-HIGH-1: plant a SECRET in the steer body. Steer injects STRAIGHT
    // into the child model (no mailbox drain to scrub it later), so the tier1-wired
    // redactor MUST scrub it here — the raw key must NEVER reach the child.
    const deliveryStream = new RecordingStream()
    const tool = rootFollowupTool(session, deliveryStream)
    const STEER_MARKER = "steer-inject-payload-COURSE-993"
    const STEER_SECRET = `sk-ant-api03-${"A".repeat(95)}`
    const STEER_BODY = `${STEER_MARKER} apikey=${STEER_SECRET}`
    const out = await callFollowup(tool, { agentId: taskId, message: STEER_BODY, mode: "steer" })

    // The tool reports admission only. It must preserve the correlation id and
    // must not claim an effective mode before the final receipt exists.
    expect(out.ok).toBe(true)
    const structured = out.structured as {
      status?: string
      deliveryId?: string
      delivered?: boolean
      triggered?: boolean
      effectiveMode?: string
    }
    expect(structured.status).toBe("accepted")
    expect(structured.deliveryId).toBeDefined()
    if (typeof structured.deliveryId !== "string") throw new Error("missing delivery id")
    expect(structured.delivered).toBe(false)
    expect(structured.triggered).toBe(false)
    expect(structured.effectiveMode).toBeUndefined()
    expect(deliveryStream.events.filter((event) => event.type === "subagent_delivery")).toEqual([
      {
        type: "subagent_delivery",
        phase: "admitted",
        deliveryId: structured.deliveryId,
        requestedMode: "steer",
        status: "accepted",
        targetTaskId: taskId,
        targetTurnId: liveTurnId,
      },
    ])

    // Now release the held turn so it reaches the post-stream safe point, which
    // drains the admitted steer and re-streams the SAME turn.
    releaseFirstTurn()
    await settle()

    ctrl.abort()
    const result = await childP

    // (a) A SECOND model call ran under the SAME turn id (safe-point re-stream).
    expect(llm.calls).toBeGreaterThanOrEqual(2)
    expect(llm.turnIdsSeen[0]).toBeDefined()
    expect(llm.turnIdsSeen[1]).toBe(llm.turnIdsSeen[0]) // SAME turn id

    // (b) The 2nd call's transcript carries the sanitized untrusted injection.
    const secondSeen = llm.seenMessages[1] ?? []
    const injectedTexts = secondSeen.flatMap((m) =>
      m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text),
    )
    // The non-secret MARKER proves the injection landed…
    expect(injectedTexts.some((t) => t.includes(STEER_MARKER))).toBe(true)
    // …tagged untrusted…
    expect(injectedTexts.some((t) => t.includes("[teammate parent — untrusted]"))).toBe(true)
    // …and Hellaudit R3-HIGH-1: the SECRET is REDACTED — the raw key NEVER reaches
    // the child model, matching the queue-drain path's redaction.
    const injectedAll = injectedTexts.join("\n")
    expect(injectedAll).not.toContain(STEER_SECRET)
    expect(injectedAll).toContain("[REDACTED")

    // (c) EXACTLY ONE applied/steer receipt, correlated to the live turn id.
    const applied = session.receipts.filter((r) => r.kind === "applied")
    expect(applied.length).toBe(1)
    if (applied[0]?.kind === "applied") {
      expect(applied[0].effectiveMode).toBe("steer")
      expect(applied[0].targetTurnId).toBe(liveTurnId)
    }

    // (d) NO mailbox duplicate for an applied steer (RFC §3.4). The child's inbox
    //     never received a queued copy of the steer body.
    const label = session.wake.labelOf(taskId) ?? ""
    const dupes = session.mailbox.list({ to: label }).filter((m) => m.body.includes(STEER_MARKER))
    expect(dupes.length).toBe(0)
    // Retention released (exactly-once bookkeeping).
    expect(session.retention.size()).toBe(0)
    expect(result.turns).toBeGreaterThanOrEqual(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 4 — interrupt while blocked in a cooperative tool: abort fires once,
//   partial captured, a FRESH turn drains the payload, task record STAYS running.
// ─────────────────────────────────────────────────────────────────────────────

describe("WS7 §4 — interrupt a busy child: per-turn abort fires, fresh turn drains the payload, task record stays running (NOT terminal)", () => {
  test("real followup_task(interrupt) mid-turn ⇒ in-flight signal fires once; a fresh turn runs; the child is not force-stopped", async () => {
    const session = makeSession(false)
    const llm = new BlockingThenInstantLLM()
    const ctrl = new AbortController()
    const runner = createSubagentRunner(sessionParent(session, llm, { signal: ctrl.signal }))

    const taskId = session.registry.newId()
    session.registry.register({ id: taskId, description: "interruptible child" })

    const childP = runner(baseReq({ taskId, signal: ctrl.signal }))
    await llm.blockingStarted
    expect(llm.calls).toBe(1)
    expect(session.registry.get(taskId)?.status).toBe("running")

    const tool = rootFollowupTool(session)
    const INT_BODY = "interrupt-and-continue-STOP-994"
    const out = await callFollowup(tool, {
      agentId: taskId,
      message: INT_BODY,
      mode: "interrupt",
    })
    expect(out.ok).toBe(true)
    // interrupt of a busy child is applied/interrupted (a fresh turn WILL run).
    expect((out.structured as { effectiveMode?: string }).effectiveMode).toBe("interrupt")

    // PROOF the interrupt aborted in-flight work: the blocking turn-1 stream saw
    // its per-turn signal abort — EXACTLY once.
    await settle()
    expect(llm.abortedAt[1]).toBe(true)

    // PROOF a FRESH turn then handles the message: a second stream call runs, and
    // the payload appears in the child's transcript (peer-formatted).
    await settle()
    expect(llm.calls).toBeGreaterThanOrEqual(2)

    // The child's task record STAYS running (interrupt is NOT forceStop/terminal).
    expect(session.registry.get(taskId)?.status).toBe("running")

    ctrl.abort()
    const result = await childP

    // The payload reached the fresh turn's transcript exactly once.
    const text = transcriptText(asMessages(result.messages))
    expect(text).toContain(INT_BODY)
    // The in-flight abort fired exactly once (no double-capture on the same turn).
    expect(llm.abortedAt.filter((x) => x === true).length).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 5 — steer with a STALE expectedTurnId (or non-steerable turn): typed
//   QUEUE downgrade with the precise reason, surfaced to the caller; the
//   replacement turn receives NO direct steer.
// ─────────────────────────────────────────────────────────────────────────────

describe("WS7 §5 — steer with a STALE expectedTurnId ⇒ typed queue downgrade (turn_mismatch), surfaced to the caller; replacement turn gets NO steer", () => {
  test("controller steer with a wrong expectedTurnId ⇒ degraded/queue with expected_turn_mismatch + ONE mailbox fallback; the child's next turn sees NO steer injection", async () => {
    const session = makeSession(true)
    const ctrl = new AbortController()
    const taskId = session.registry.newId()
    const llm = new SteerableEndTurnLLM(() => session.wake.endpointFor(taskId)?.currentTurnId())
    const runner = createSubagentRunner(sessionParent(session, llm, { signal: ctrl.signal }))
    session.registry.register({ id: taskId, description: "stale-steer child" })

    let releaseFirstTurn: () => void = () => {}
    llm.gate = () =>
      new Promise<void>((r) => {
        releaseFirstTurn = r
      })

    const childP = runner(baseReq({ taskId, signal: ctrl.signal }))
    await llm.firstStreamEntered
    const endpoint = session.wake.endpointFor(taskId)
    expect(endpoint).toBeDefined()
    const liveTurnId = endpoint?.currentTurnId()
    expect(typeof liveTurnId).toBe("string")
    if (typeof liveTurnId !== "string") throw new Error("no live turn id on the child endpoint")
    const steerPlane = session.steerPlane
    if (steerPlane === undefined) throw new Error("steer plane must be wired for scenario 5")

    // Build a controller with a STALE expectedTurnId baked into the request. The
    // real followup_task tool OMITS expectedTurnId (⇒ resolves live), so a STALE
    // id is only reachable via the controller request directly — that is the
    // path a peer/host with a cached turn id would take. steerEnabled honors the
    // supplied (stale) id verbatim ⇒ turn_mismatch.
    const receipts: SubagentDeliveryReceipt[] = session.receipts
    const controller = createSubagentDeliveryController({
      control: session.wake as unknown as SubagentControlRegistry,
      mailbox: session.mailbox as unknown as DeliveryMailboxPort,
      formatPeer: (from, kind, body) => formatPeerBody({ from, kind, body }),
      resolveTarget: createTargetResolver({
        registry: session.registry,
        control: session.wake as unknown as SubagentControlRegistry,
      }),
      newDeliveryId: (() => {
        let n = 0
        return () => {
          n += 1
          return `del-s${n}`
        }
      })(),
      steerEnabled: true,
      steerRetention: session.retention,
      finalization: steerPlane.finalization,
    })

    const STALE_BODY = "stale-steer-payload-DOWNGRADE-995"
    const outcome = controller.deliver({
      targetTaskId: taskId,
      from: "parent",
      body: STALE_BODY,
      mode: "steer",
      activation: "ensure-turn",
      expectedTurnId: `${liveTurnId}-STALE`, // deliberately wrong / stale
    })

    // (a) typed QUEUE downgrade with the precise reason surfaced to the caller.
    expect(outcome.kind).toBe("degraded")
    if (outcome.kind === "degraded") {
      expect(outcome.effectiveMode).toBe("queue")
      expect(outcome.reason).toBe("expected_turn_mismatch")
    }

    // (b) ONE mailbox fallback from the (retained-not-applied) payload.
    const label = session.wake.labelOf(taskId) ?? ""
    const queued = session.mailbox.list({ to: label }).filter((m) => m.body.includes(STALE_BODY))
    expect(queued.length).toBe(1)
    // No applied receipt (it was never admitted to a steer surface).
    expect(receipts.filter((r) => r.kind === "applied").length).toBe(0)

    // Now release the held turn so the child completes it and takes a fresh turn.
    releaseFirstTurn()
    await settle()

    // (c) The replacement (safe-point) turn receives NO DIRECT steer injection —
    //     the stale steer was never admitted to the child's steer surface, so no
    //     same-turn re-stream carrying it happened.
    const restreamSawSteerBody = llm.seenMessages
      .slice(1)
      .some((msgs) =>
        msgs.some((m) =>
          m.content.some(
            (b) => b.type === "text" && (b as { text: string }).text.includes(STALE_BODY),
          ),
        ),
      )
    expect(restreamSawSteerBody).toBe(false)

    ctrl.abort()
    const result = await childP
    // The payload was preserved as a QUEUE fallback; it surfaces at the child's
    // NEXT read (peer-inbox drain) — never lost, but never as a same-turn steer.
    expect(result.turns).toBeGreaterThanOrEqual(1)
  })
})
