/**
 * T10 wiring hellgate — two dead-wiring defects closed:
 *
 * (a) async-tools seam was DEAD. `QUANTA_ASYNC_TOOLS` / `QUANTA_DEFERRED_CAP`
 *     were parsed into `runtimeConfig().asyncTools` / `.deferredCap`, and
 *     dispatch already told the LLM to "poll with poll_deferred" on a
 *     `result.deferred` — but NO composition root constructed a
 *     `DefaultDeferredResultRegistry` or registered `pollDeferredTool`, so the
 *     tool the model was instructed to call was never in any registry. This
 *     pins that BOTH composition roots (the agent base builder
 *     `@/host/runtime/agent-arg-builder.ts buildBaseRegistry` — relocated DOWN
 *     out of `apps/agent/index.ts` per ADR-0303 — + `apps/cli/internal.ts
 *     buildTooling`) now gate the registration on
 *     `runtimeConfig().asyncTools`, that `pollDeferredTool` is barrel-exported
 *     from `@/tool`, and — the live proof — that the wired tool actually round-
 *     trips against a `DefaultDeferredResultRegistry`.
 *
 * (b) jail-decision-event shape drift. `decision-emit-phase3.ts`'s
 *     `buildJailDecisionEvent` was an exported builder with ZERO callers while
 *     `storage/service.ts#emitJailDeny` hand-rolled the same event against its
 *     own structural type — two construction sites that could silently diverge.
 *     This pins the SSOT: the agent builder DELEGATES to the storage builder,
 *     and the storage emit sink fires the IDENTICAL shape.
 *
 * Cases
 * ─────
 *   HELL-AT-01  `pollDeferredTool` is barrel-exported from `@/tool` (wire-ready
 *               surface) — a regression that drops the re-export surfaces here.
 *   HELL-AT-02  BOTH composition roots reference `runtimeConfig().asyncTools`,
 *               construct `DefaultDeferredResultRegistry`, and register
 *               `pollDeferredTool` (static module-text — catches a future
 *               refactor that silently drops the wire without a runtime poll).
 *   HELL-AT-03  default-OFF: neither root mentions `poll_deferred` in a literal
 *               that would force it into `defaultTools` (it must stay caller-
 *               wired). Pinned via the registry construction being gated.
 *   HELL-AT-04  LIVE: `pollDeferredTool` over a real registry round-trips —
 *               unknown handle ⇒ `[failed] unknown-handle`, registered work ⇒
 *               `[completed]` unwrap. Proves the wired tool is functional.
 *   HELL-AT-05  the deferred cap is honored: a `DefaultDeferredResultRegistry`
 *               built with `{ cap: 1 }` evicts COMPLETED handles (the bound the
 *               `QUANTA_DEFERRED_CAP` knob threads into the wire).
 *   HELL-JAIL-06  SSOT: `buildJailDecisionEvent` (agent) === the storage
 *               `buildFsJailDecisionEvent` output for the same input (one shape).
 *   HELL-JAIL-07  the storage emit sink fires the IDENTICAL shape on a real
 *               jail escape — proving the chokepoint uses the SSOT builder.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildJailDecisionEvent } from "@/../src/agent/decision-emit-phase3"
import {
  buildFsJailDecisionEvent,
  clearFsJailDecisionSink,
  enforceJail,
  FsJailError,
  setFsJailDecisionSink,
} from "@/../src/storage/service"
import { pollDeferredTool } from "@/tool"
import { DefaultDeferredResultRegistry } from "@/tool/deferred/default-registry"
import type { ToolEvent, ToolResult } from "@/tool/types"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
// ADR-0303 thin-surface relocation — the agent composition-root base builder
// (`buildBaseFromArgs` + its `buildBaseRegistry` / `buildAsyncDeferredTools`
// async-tools gate) moved DOWN out of `apps/agent/index.ts` into
// `@/host/runtime/agent-arg-builder.ts`. The gate text now lives there; the
// `apps/agent` surface entry just re-exports the builder.
const AGENT_INDEX = readFileSync(
  join(REPO_ROOT, "src", "host", "runtime", "agent-arg-builder.ts"),
  "utf8",
)
const CLI_INTERNAL = readFileSync(join(REPO_ROOT, "src", "apps", "cli", "internal.ts"), "utf8")

/** Drain a tool's async-iterable `execute` to its terminal `result`. */
const runTool = async (
  tool: ReturnType<typeof pollDeferredTool>,
  input: { handle: string; awaitMs?: number },
): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input as never, {} as never) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = ev.result
  }
  if (last === undefined) throw new Error("tool yielded no result")
  return last
}

describe("T10 — async-tools poll_deferred wire is LIVE at BOTH composition roots", () => {
  it("HELL-AT-01: pollDeferredTool is barrel-exported from @/tool", () => {
    expect(typeof pollDeferredTool).toBe("function")
  })

  it("HELL-AT-02: agent buildBaseRegistry gates poll_deferred on runtimeConfig().asyncTools", () => {
    // The wire MUST read the parsed knob, construct the registry, and register
    // the tool. Pinning all three guards against the original dead-seam bug.
    expect(AGENT_INDEX).toContain("asyncTools")
    expect(AGENT_INDEX).toContain("DefaultDeferredResultRegistry")
    expect(AGENT_INDEX).toContain("pollDeferredTool")
    // The cap knob must thread through (bounded handle map).
    expect(AGENT_INDEX).toContain("deferredCap")
  })

  it("HELL-AT-02b: cli buildTooling gates poll_deferred on runtimeConfig().asyncTools", () => {
    expect(CLI_INTERNAL).toContain("asyncTools")
    expect(CLI_INTERNAL).toContain("DefaultDeferredResultRegistry")
    expect(CLI_INTERNAL).toContain("pollDeferredTool")
    expect(CLI_INTERNAL).toContain("deferredCap")
  })

  it("HELL-AT-03: registration is GATED (default-OFF) — `if (!cfg.asyncTools) return []`", () => {
    // The adversarial case: a refactor that registers poll_deferred
    // unconditionally would break the default-OFF byte-identical surface. Pin
    // the early-return guard at BOTH roots so the gate cannot silently vanish.
    expect(AGENT_INDEX).toContain("if (!cfg.asyncTools) return []")
    expect(CLI_INTERNAL).toContain("if (!cfg.asyncTools) return []")
  })

  it("HELL-AT-04: LIVE — wired tool round-trips against a real registry", async () => {
    const registry = new DefaultDeferredResultRegistry()
    const tool = pollDeferredTool(registry)

    // Unknown handle ⇒ uniform failed/unknown-handle classification (never throws).
    const unknown = await runTool(tool, { handle: "deferred-does-not-exist" })
    expect(unknown.ok).toBe(false)
    expect(unknown.output).toContain("[failed]")
    expect(unknown.output).toContain("unknown-handle")

    // Register real work, then await it through the tool ⇒ completed unwrap.
    const handle = registry.register(async () => ({ ok: true, output: "WORK_DONE" }))
    const done = await runTool(tool, { handle: handle.id, awaitMs: 1_000 })
    expect(done.ok).toBe(true)
    expect(done.output).toContain("<completed via=deferred")
    expect(done.output).toContain("WORK_DONE")
  })

  it("HELL-AT-05: the cap knob is honored — cap:1 evicts a completed handle", async () => {
    const registry = new DefaultDeferredResultRegistry({ cap: 1 })
    const tool = pollDeferredTool(registry)
    const h1 = registry.register(async () => ({ ok: true, output: "first" }))
    await registry.await(h1, 1_000)
    // A second completed handle pushes the (terminal) first out under cap:1.
    const h2 = registry.register(async () => ({ ok: true, output: "second" }))
    await registry.await(h2, 1_000)
    const evicted = await runTool(tool, { handle: h1.id })
    expect(evicted.ok).toBe(false)
    expect(evicted.output).toContain("handle-evicted")
  })
})

describe("T10 — jail decision event has ONE source of truth (no shape drift)", () => {
  afterEach(() => clearFsJailDecisionSink())

  it("HELL-JAIL-06: buildJailDecisionEvent (agent) delegates to the storage SSOT builder", () => {
    const args = { path: "/etc/passwd", root: "/workspace" }
    const agentEvent = buildJailDecisionEvent(args)
    const storageEvent = buildFsJailDecisionEvent(args)
    // Byte-identical object shape — the agent builder is a pure re-cast of the
    // storage builder (the SSOT), so the two can never diverge.
    expect(agentEvent).toEqual(storageEvent as never)
    expect(agentEvent).toEqual({
      type: "decision",
      turn: 0,
      kind: "jail",
      outcome: "deny",
      reason: "path outside workspace: /etc/passwd",
      metadata: { path: "/etc/passwd", root: "/workspace" },
    })
  })

  it("HELL-JAIL-07: the storage emit sink fires the SSOT shape on a real jail escape", () => {
    const seen: unknown[] = []
    setFsJailDecisionSink({ emit: (e) => seen.push(e) })
    // An escape MUST throw (fail-closed) AND emit exactly one event via the SSOT.
    expect(() => enforceJail("../../../etc/passwd", "/tmp/jail-root", "/etc/passwd")).toThrow(
      FsJailError,
    )
    expect(seen).toHaveLength(1)
    const event = seen[0] as ReturnType<typeof buildFsJailDecisionEvent>
    // The emitted shape MUST match what the SSOT builder produces for the SAME
    // (canonicalized) offending path + root — drift here is the bug this closes.
    expect(
      buildFsJailDecisionEvent({
        path: event.metadata?.path as string,
        root: event.metadata?.root as string,
      }),
    ).toEqual(event)
    expect(event.kind).toBe("jail")
    expect(event.outcome).toBe("deny")
    expect(event.reason).toContain("path outside workspace:")
  })
})
