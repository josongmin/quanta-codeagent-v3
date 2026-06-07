/**
 * jun-7-misc 06 (ADR ≥0497) — COMPOSITION-ROOT WIRE hellgate for the model-based
 * fast-apply MERGE port. Sibling to `fast-apply-merge-e2e-hellgate.test.ts`
 * (which constructs the port BY HAND and drives the edit tool). THIS test proves
 * the missing seam the e2e test could not: that the REAL composition root
 * (`wireOptionalAgentPorts` → `AgentConfig.fastApplyMerge`) and the REAL dispatch
 * threading (`buildToolContext` → `ToolContext.fastApplyMerge`) make the port
 * PRODUCTION-REACHABLE when the strict knob is ON — and byte-identically absent
 * when it is OFF.
 *
 * The wire is split across two owned files; this test pins BOTH halves:
 *   (a) PRODUCTION-REACHABLE: `QUANTA_FAST_APPLY_MERGE=1` (+ a configured
 *       `QUANTA_FAST_APPLY_MODEL`) ⇒ the comp-root populates
 *       `config.fastApplyMerge`, and `dispatchTool` threads it onto
 *       `ctx.fastApplyMerge` (captured by a probe tool through the REAL dispatch).
 *   (b) DEFAULT-OFF: knob unset ⇒ `config.fastApplyMerge` undefined, the config
 *       object is byte-identical to the input (no allocation, no new key), and
 *       `ctx.fastApplyMerge` is undefined at the tool.
 *   (c) STRICT GATE: loose-truthy `"on"`/`"true"` stays OFF (the merge knob is a
 *       strict `=== "1"`, NOT the loose `=on` vocabulary the sibling subagent
 *       gates use) — so a host that sets the loose form gets NO port.
 *
 * RED-ON-INJECTION: removing the gate in `optional-ports.ts#wireFastApplyMerge`
 * (i.e. always constructing the port) flips test (b)/(c) RED — the OFF/loose runs
 * would then carry a `fastApplyMerge` port. Removing the dispatch thread in
 * `dispatch.ts` flips test (a) RED — the probe would never see `ctx.fastApplyMerge`.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { type AgentConfig, wireOptionalAgentPorts } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { LLMPort, StreamEvent, StreamInput, ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import { type Tool, type ToolContext, type ToolEvent, ToolRegistry } from "@/tool"

const APPLY_MODEL = "fake-cheap-apply-model"
const CHAT_MODEL = "main-chat-model"

const perm: PermissionContext = { mode: "acceptEdits" }

/** A minimal LLM port — only `.model` is read by the comp-root's
 *  `resolveModelPort`; `stream` is never invoked in a wire test (we never call
 *  `port.apply`). */
const fakeLlm: LLMPort = {
  model: CHAT_MODEL,
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncGenerator<StreamEvent> {
      yield { type: "message_stop", stop_reason: "end_turn" }
    }
    return gen()
  },
}

/** Probe tool that CAPTURES the live `ctx.fastApplyMerge` so we can assert the
 *  dispatch seam threaded the comp-root's port all the way to the tool. */
const probeTool = (sink: { ctx?: ToolContext }): Tool => ({
  name: "probe_merge_ctx",
  description: "captures ctx.fastApplyMerge",
  inputSchema: { parse: (x: unknown) => x } as unknown as Tool["inputSchema"],
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  execute: async function* (_input, ctx): AsyncIterable<ToolEvent> {
    sink.ctx = ctx
    yield { type: "result", result: { ok: true, output: "probed" } }
  },
})

/** Build the comp-root INPUT (`base`) the host would assemble. Mirrors the
 *  fields `wireOptionalAgentPorts` Picks + what `dispatchTool` needs. */
const makeBase = (sink: { ctx?: ToolContext }): AgentConfig =>
  ({
    llm: fakeLlm,
    registry: new ToolRegistry([probeTool(sink)]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: perm,
  }) as unknown as AgentConfig

const call = (id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "probe_merge_ctx",
  input: {},
})

/** Drive the env snapshot → reset the cached runtimeConfig → run the comp-root. */
const wireWith = (
  env: Record<string, string | undefined>,
  base: AgentConfig,
): AgentConfig => {
  const prev: Record<string, string | undefined> = {}
  for (const k of ["QUANTA_FAST_APPLY_MERGE", "QUANTA_FAST_APPLY_MODEL"]) {
    prev[k] = process.env[k]
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  }
  __resetRuntimeConfig()
  try {
    // The second arg is the `=on`-vocabulary env for the OTHER gates; pass `{}`
    // so only the STRICT runtimeConfig merge knob (read from process.env above)
    // can flip the merge wire.
    return wireOptionalAgentPorts(base, {})
  } finally {
    for (const k of ["QUANTA_FAST_APPLY_MERGE", "QUANTA_FAST_APPLY_MODEL"]) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

afterEach(() => {
  __resetRuntimeConfig()
})

describe("jun-7-misc 06 fast-apply MERGE composition-root WIRE hellgate", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // (a) PRODUCTION-REACHABLE — knob ON + apply model ⇒ comp-root populates the
  //     port AND dispatch threads it onto ctx.fastApplyMerge.
  // ───────────────────────────────────────────────────────────────────────────
  test("WIRE-01 ON: comp-root populates config.fastApplyMerge", () => {
    const sink: { ctx?: ToolContext } = {}
    const wired = wireWith(
      { QUANTA_FAST_APPLY_MERGE: "1", QUANTA_FAST_APPLY_MODEL: APPLY_MODEL },
      makeBase(sink),
    )
    expect(wired.fastApplyMerge).toBeDefined()
    expect(typeof wired.fastApplyMerge?.apply).toBe("function")
  })

  test("WIRE-02 ON: dispatch threads config.fastApplyMerge → ctx.fastApplyMerge (production-reachable)", async () => {
    const sink: { ctx?: ToolContext } = {}
    const wired = wireWith(
      { QUANTA_FAST_APPLY_MERGE: "1", QUANTA_FAST_APPLY_MODEL: APPLY_MODEL },
      makeBase(sink),
    )
    const res = await dispatchTool(call(), wired, perm)
    expect(res.ok).toBe(true)
    // The REAL dispatch seam surfaced the comp-root's port to the tool.
    expect(sink.ctx?.fastApplyMerge).toBeDefined()
    expect(sink.ctx?.fastApplyMerge).toBe(wired.fastApplyMerge)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // (b) DEFAULT-OFF byte-identity — knob unset ⇒ no port, no allocation.
  // ───────────────────────────────────────────────────────────────────────────
  test("WIRE-03 OFF (knob unset): config.fastApplyMerge undefined + config object byte-identical", () => {
    const sink: { ctx?: ToolContext } = {}
    const base = makeBase(sink)
    const wired = wireWith({}, base)
    expect(wired.fastApplyMerge).toBeUndefined()
    // Byte-identity: with every gate OFF the comp-root returns the SAME object
    // reference — no spread, no new key, zero allocation on the default path.
    expect(wired).toBe(base)
    expect("fastApplyMerge" in wired).toBe(false)
  })

  test("WIRE-04 OFF: ctx.fastApplyMerge is undefined at the tool", async () => {
    const sink: { ctx?: ToolContext } = {}
    const wired = wireWith({}, makeBase(sink))
    const res = await dispatchTool(call(), wired, perm)
    expect(res.ok).toBe(true)
    expect(sink.ctx?.fastApplyMerge).toBeUndefined()
  })

  test("WIRE-05 ON-gate but NO apply model ⇒ no port (both required)", () => {
    const sink: { ctx?: ToolContext } = {}
    const base = makeBase(sink)
    // Strict gate ON but QUANTA_FAST_APPLY_MODEL absent ⇒ the apply call would
    // have no operator-set model to bind to; the wire MUST NOT construct a port
    // (and must not fall through to the chat model).
    const wired = wireWith({ QUANTA_FAST_APPLY_MERGE: "1" }, base)
    expect(wired.fastApplyMerge).toBeUndefined()
    expect(wired).toBe(base)
  })

  test("WIRE-06 ON-gate but EMPTY apply model ⇒ no port", () => {
    const sink: { ctx?: ToolContext } = {}
    const base = makeBase(sink)
    const wired = wireWith(
      { QUANTA_FAST_APPLY_MERGE: "1", QUANTA_FAST_APPLY_MODEL: "" },
      base,
    )
    expect(wired.fastApplyMerge).toBeUndefined()
    expect(wired).toBe(base)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // (c) STRICT GATE — loose-truthy stays OFF (the merge knob is `=== "1"`).
  // ───────────────────────────────────────────────────────────────────────────
  test("WIRE-07 STRICT: QUANTA_FAST_APPLY_MERGE=on (loose) stays OFF — no port", () => {
    const sink: { ctx?: ToolContext } = {}
    const base = makeBase(sink)
    const wired = wireWith(
      { QUANTA_FAST_APPLY_MERGE: "on", QUANTA_FAST_APPLY_MODEL: APPLY_MODEL },
      base,
    )
    expect(wired.fastApplyMerge).toBeUndefined()
    expect(wired).toBe(base)
  })

  test("WIRE-08 STRICT: QUANTA_FAST_APPLY_MERGE=true (loose) stays OFF — no port", () => {
    const sink: { ctx?: ToolContext } = {}
    const base = makeBase(sink)
    const wired = wireWith(
      { QUANTA_FAST_APPLY_MERGE: "true", QUANTA_FAST_APPLY_MODEL: APPLY_MODEL },
      base,
    )
    expect(wired.fastApplyMerge).toBeUndefined()
    expect(wired).toBe(base)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Caller-override-precedence (ADR-0332) — a pre-set port is preserved verbatim.
  // ───────────────────────────────────────────────────────────────────────────
  test("WIRE-09 ON: a caller-supplied fastApplyMerge is preserved (never overwritten)", () => {
    const sink: { ctx?: ToolContext } = {}
    const preset = {
      apply: async () => ({ ok: false, merged: null, rationale: "preset" }),
    }
    const base = { ...makeBase(sink), fastApplyMerge: preset } as unknown as AgentConfig
    const wired = wireWith(
      { QUANTA_FAST_APPLY_MERGE: "1", QUANTA_FAST_APPLY_MODEL: APPLY_MODEL },
      base,
    )
    expect(wired.fastApplyMerge).toBe(preset)
  })
})
