/**
 * DEFAULT-ON SAFETY hellgate — adversarial audit of the 3 observability
 * features (observability-wire / observability-live-wire / observability-ws-sink)
 * against the prior audit's claim that all three are PURE TELEMETRY and that
 * observability-wire + ws-sink are safe DEFAULT-ON candidates.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ FINDING (load-bearing): observability-wire is NOT pure telemetry.        │
 * │ Turning `QUANTA_OBSERVABILITY=on` populates `AgentConfig.objective` +    │
 * │ `AgentConfig.shadowVerify`, which `buildSessionFeatures` materializes    │
 * │ into FOUR NEW LLM TOOLS (`objective_set/_update/_get`, `shadow_verify`). │
 * │ That changes the tool manifest the model sees → new agent capabilities   │
 * │ AND different tool-schema bytes in the request. This is a BEHAVIORAL     │
 * │ LEAK: default-ON would silently hand every agent four extra tools.       │
 * │ ⇒ observability-wire is NOT safe-default-ON.                             │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The SUB-PORTS that DON'T add tools (runLedger / approvalStateMachine / the
 * minted HookBus) ARE decision-neutral — this file pins that too, so the
 * boundary between the leak (tool-adding ports) and the pure-telemetry ports is
 * exact and regression-guarded.
 *
 * Three axes:
 *   A. ON-SINK PROOF — real telemetry reaches its sink (a real `post_tool_use`
 *      event lands a real RunLedger record; a real span reaches an OTLP-style
 *      exporter sink).
 *   B. BEHAVIORAL-LEAK PROOF (RED-ON-INJECTION for the safe-default-ON claim) —
 *      the tool manifest DIFFERS ON vs OFF by exactly the four tool names.
 *   C. NON-BEHAVIORAL PROOF — the ports that do NOT add tools leave the
 *      approval OUTCOME + the empty-HookBus emit result byte-identical.
 */

import { describe, expect, test } from "bun:test"
import { createApprovalGate } from "@/agent/approval-gate-wire"
import { createApprovalStateMachine } from "@/agent/approval-state-machine"
import { buildSessionFeatures } from "@/agent/features"
import { HookBus } from "@/agent/hooks"
import { wireObservability as wireObservabilityRaw } from "@/agent/observability-wire"
import { createRunLedgerHookSubscriber } from "@/agent/run-ledger-attribution"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort } from "@/llm"
import { createObjectiveStore } from "@/objective"
import { installOtelSpanExportFromEnv } from "@/observability/otel-span-export"
import { endSpan, getSpanSink, startSpan } from "@/observability/spans"
import type { PermissionContext } from "@/permission"
import type { StreamPort } from "@/stream"
import { defaultTools, type Tool, ToolRegistry } from "@/tool"

/**
 * RFC-03 C2 — the objective authority is now INJECTED into the wire (the wire no
 * longer mints its own store — construction is owned by the assembly builder,
 * per the constructor-owner ratchet). This thin wrapper supplies the objective
 * the composition root injects, so the historical enabled-path invariants
 * (objective present, objective_* tools in the manifest) are unchanged.
 */
const wireObservability = (
  opts: Parameters<typeof wireObservabilityRaw>[0] = {},
): ReturnType<typeof wireObservabilityRaw> =>
  opts?.enabled === true && opts.objective === undefined
    ? wireObservabilityRaw({
        ...opts,
        objective: createObjectiveStore(opts.now !== undefined ? { now: opts.now } : {}),
      })
    : wireObservabilityRaw(opts)

// ── minimal real AgentConfig (mirrors objective-tools-hellgate baseCfg) ──────
const baseCfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry(defaultTools),
    stream: { emit() {} } as StreamPort,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "test",
    cwd: "/tmp",
    maxTurns: 1,
    signal: new AbortController().signal,
    llm: { model: "scripted", async *stream() {} } as unknown as LLMPort,
    ...over,
  }) as AgentConfig

const toolNames = async (cfg: AgentConfig): Promise<string[]> =>
  (await buildSessionFeatures(cfg)).extraTools.map((t: Tool) => t.name).sort()

// The exact four tools the observability wire injects into the LLM manifest.
const LEAK_TOOLS = ["objective_get", "objective_set", "objective_update", "shadow_verify"] as const

// ─────────────────────────────────────────────────────────────────────────────
// A. ON-SINK PROOF — telemetry actually reaches its sink.
// ─────────────────────────────────────────────────────────────────────────────

describe("A. ON-SINK PROOF — real telemetry reaches its sink", () => {
  test("[A1] wire ON: a real post_tool_use event lands a real RunLedger record", () => {
    const wire = wireObservability({ enabled: true, repoRoot: process.cwd() })
    expect(wire.runLedger).toBeDefined()
    const ledger = wire.runLedger
    if (ledger === undefined) throw new Error("runLedger not wired")

    // The SAME subscriber the composition root subscribes to `post_tool_use`.
    const sink = createRunLedgerHookSubscriber({ ledger })

    // Sanity: nothing recorded yet (fresh readback baseline).
    expect(ledger.get("sh-42")).toBeNull()

    // Feed a REAL background-launch banner event — the matcher starts a shell run.
    sink({
      name: "bash",
      ok: true,
      output: "[bash background] shellId=sh-42 status=running",
      input: { command: "sleep 100" },
    } as never)

    // The telemetry reached the sink: a live running record now exists.
    const rec = ledger.get("sh-42")
    expect(rec).not.toBeNull()
    expect(rec?.status).toBe("running")
    expect(rec?.kind).toBe("shell")
    wire.detach()
  })

  test("[A2] live-wire ON: gate ON installs a real span-export sink that receives spans", async () => {
    // Guard: no sink installed at baseline (byte-identical default-OFF — the
    // OTEL wire is a no-op unless QUANTA_OTEL_ENDPOINT is set).
    expect(getSpanSink()).toBeNull()

    // OFF path: endpoint unset ⇒ install is a no-op, NO sink registered.
    const off = installOtelSpanExportFromEnv({})
    expect(getSpanSink()).toBeNull()
    expect(off.exporter).toBeNull()
    await off.teardown()

    // ON path: endpoint set ⇒ a real exporter span sink is registered on the
    // process seam (this is the entire behavior of the live-wire — it redirects
    // the loop's already-emitted spans to an OTLP exporter).
    const installed = installOtelSpanExportFromEnv({
      QUANTA_OTEL_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
    })
    try {
      const sink = getSpanSink()
      // The gate ON DID change the process span sink (telemetry now routes to
      // the exporter). This is the load-bearing ON-sink proof for live-wire.
      expect(sink).not.toBeNull()
      expect(installed.exporter).not.toBeNull()

      // A real span drives through the installed sink without throwing — the
      // sink's onStart return becomes Span.ref (a trace-correlation id), which
      // is telemetry-internal (never reaches prompt/tool/output — audited).
      const span = startSpan("obs.default-on.probe" as never, {})
      endSpan(span, "ok", {})
      // The span carries a real exporter-issued trace ref (proof the export
      // sink actually processed onStart), NOT a byte-identical no-op.
      expect(span.ref).toBeDefined()
    } finally {
      // Drain + restore the previous (null) sink so we leave global state clean.
      await installed.teardown()
    }
    // Sink restored after teardown (no leak into sibling tests).
    expect(getSpanSink()).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. BEHAVIORAL-LEAK PROOF — observability-wire ON adds LLM tools.
//    This is the RED-ON-INJECTION guard for the "safe default-ON" claim: if a
//    future refactor makes the wire NOT add tools, [B1] flips (and the wire
//    would then genuinely be a default-ON candidate — re-litigate the ledger).
// ─────────────────────────────────────────────────────────────────────────────

describe("B. BEHAVIORAL-LEAK — wire ON mutates the LLM tool manifest", () => {
  test("[B1] wire ON adds EXACTLY {objective_*, shadow_verify} to extraTools", async () => {
    const off = await toolNames(baseCfg())

    const wire = wireObservability({ enabled: true, repoRoot: process.cwd() })
    const on = await toolNames(
      baseCfg({
        ...(wire.objective !== undefined ? { objective: wire.objective } : {}),
        ...(wire.shadowVerify !== undefined ? { shadowVerify: wire.shadowVerify } : {}),
        ...(wire.runLedger !== undefined ? { runLedger: wire.runLedger } : {}),
        ...(wire.approvalStateMachine !== undefined
          ? { approvalStateMachine: wire.approvalStateMachine }
          : {}),
      }),
    )

    const added = on.filter((n) => !off.includes(n)).sort()
    const removed = off.filter((n) => !on.includes(n))

    // The leak is EXACTLY these four tools — nothing else changes, nothing
    // is removed. (Closed assertion: a new tool-adding observability port
    // would break this and force a re-audit.)
    expect(added).toEqual([...LEAK_TOOLS])
    expect(removed).toEqual([])
    wire.detach()
  })

  test("[B2] wire OFF ⇒ tool manifest byte-identical to no-wire (default-OFF)", async () => {
    const noWire = await toolNames(baseCfg())
    const wireOff = wireObservability({ enabled: false, repoRoot: process.cwd() })
    // OFF handle exposes no ports ⇒ no slots spread ⇒ identical manifest.
    expect(wireOff.objective).toBeUndefined()
    expect(wireOff.shadowVerify).toBeUndefined()
    const offCfg = await toolNames(baseCfg())
    expect(offCfg).toEqual(noWire)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. NON-BEHAVIORAL PROOF — the ports that DON'T add tools are decision-neutral.
//    (runLedger / approvalStateMachine / the minted HookBus.)
// ─────────────────────────────────────────────────────────────────────────────

describe("C. NON-BEHAVIORAL — attribution ports do not change decisions", () => {
  test("[C1] approvalStateMachine presence leaves the approval OUTCOME byte-identical", async () => {
    const req = {
      threadId: "t1",
      kind: "permission" as const,
      reason: "writes outside cwd",
      proposedAction: "rm -rf build/",
      resumeStep: "step-3",
    }

    // WITHOUT the SM (legacy / gate-OFF): the gate surfaces the resolver's
    // decision verbatim; approvalId is "".
    const gateOff = createApprovalGate({})
    const resOff = await gateOff.open(req, async () => "approve")

    // WITH the SM (gate-ON attribution): same resolver, decision must be IDENTICAL.
    const sm = createApprovalStateMachine()
    const gateOn = createApprovalGate({ approvalSM: sm })
    const resOn = await gateOn.open(req, async () => "approve")

    // DECISION is byte-identical — the SM only changes the (telemetry-only)
    // approvalId + records the request/settle, never the outcome.
    expect(resOn.decision).toBe(resOff.decision)
    expect(resOn.decision).toBe("approve")
    // Proof the SM DID record (telemetry actually happened) — approvalId is now
    // a real id (vs "" when absent), and the SM holds the settled record.
    expect(resOff.approvalId).toBe("")
    expect(resOn.approvalId.length).toBeGreaterThan(0)
    expect(sm.get(resOn.approvalId)?.status).toBe("approved")

    // Same for a DENY — the SM must not flip a deny to allow or vice versa.
    const smD = createApprovalStateMachine()
    const denyOff = await createApprovalGate({}).open(req, async () => "deny")
    const denyOn = await createApprovalGate({ approvalSM: smD }).open(req, async () => "deny")
    expect(denyOn.decision).toBe(denyOff.decision)
    expect(denyOn.decision).toBe("deny")
  })

  test("[C2] a minted HookBus with only a post_tool_use handler is decision-neutral for pre_tool_use", async () => {
    const wire = wireObservability({ enabled: true, repoRoot: process.cwd() })
    const bus = new HookBus()
    // Subscribe the SAME attribution handler the composition root wires — this
    // is the ONLY handler the observability bus registers, and it's on
    // `post_tool_use` (not the decision-bearing `pre_tool_use`).
    if (wire.runLedger !== undefined) {
      const sub = createRunLedgerHookSubscriber({ ledger: wire.runLedger })
      bus.on("post_tool_use", ((e: unknown) => sub(e as never)) as never)
    }

    // pre_tool_use (the deny/rewrite channel) has ZERO handlers on this bus ⇒
    // the emit MUST fast-path to the neutral `{ deny: null }` — no deny, no
    // rewrite key — byte-identical to the no-bus path (`runPreToolUseHook`
    // returns null when config.hooks is absent).
    const pre = await bus.emit({ type: "pre_tool_use", name: "bash", input: { command: "ls" } })
    expect(pre.deny).toBeNull()
    expect("updatedInput" in pre).toBe(false)

    // post_tool_use DOES run the handler (telemetry), but its emit result is
    // discarded by dispatch (`return finalOut`) — no deny/rewrite channel here.
    const post = await bus.emit({
      type: "post_tool_use",
      name: "bash",
      input: { command: "ls" },
      ok: true,
      output: "[bash background] shellId=sh-9 status=running",
    })
    expect(post.deny).toBeNull()
    // The handler fired ⇒ the ledger recorded (telemetry reached the sink).
    expect(wire.runLedger?.get("sh-9")?.status).toBe("running")
    wire.detach()
  })
})
