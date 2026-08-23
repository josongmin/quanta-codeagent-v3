/**
 * HELLGATE — E: the repo-map knob is wired, or it is a lie (§17.5 packet E).
 *
 * `QUANTA_REPO_MAP` is a registered runner knob with a schema, presets, a
 * documented purpose ("turn-0 orientation reduces wasted nav turns on
 * SWE-bench"), a bounded probe (`probeRepoMap`), a scan adapter
 * (`repo-map-scan.ts`), a renderer (`renderEnvBlock`), and tests.
 *
 * Everything except the call.
 *
 * `probeRepoMap` and `probeTurnEnv` have ZERO production call sites — only
 * tests. `TurnContextInput.env` has no producer, so `renderEnvBlock(input.env)`
 * always sees `undefined` and the `## Environment` block never renders.
 * Measured through the real loop: `QUANTA_REPO_MAP=1` produces a BYTE-IDENTICAL
 * system prompt. An operator who sets the knob gets nothing and believes they
 * enabled turn-0 orientation.
 *
 * That is the same shape as every other defect this campaign closed — a
 * promise the runtime does not keep — so the wire-or-delete decision resolves
 * to WIRE: the plumbing all exists, and deleting would remove a documented,
 * measurable bench lever on the grounds that someone forgot one line.
 *
 * Scope is deliberately the repo-map ONLY. `probeTurnEnv` (platform / shell /
 * git status / package manager) stays unwired: it costs a `git status` per
 * session and has no knob asking for it. Recorded, not smuggled in.
 *
 * Invariants:
 *
 *  E-1  RED — with the knob ON, the turn-1 system prompt carries the repo map.
 *  E-2  DEFAULT-OFF byte-identity — knob absent ⇒ the prompt is unchanged.
 *  E-3  TURN-1 ONLY — the scan does not re-run on later turns (the cost is a
 *        one-time orientation payment, which is the knob's whole premise).
 *  E-4  FAIL-SOFT — a throwing or empty scan leaves the prompt unchanged and
 *        never breaks the turn.
 *  E-5  The rendered block carries the stale-tolerant framing, so the model is
 *        told the map may be out of date.
 */

import { afterEach, describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { ToolRegistry } from "@/tool"

const KNOB = "QUANTA_REPO_MAP"

afterEach(() => {
  delete process.env[KNOB]
})

/** Capture the WHOLE per-turn wire — system prompt AND messages.
 *
 *  The env block does NOT ride the `system` string: `renderEnvBlock` feeds the
 *  per-turn `<system-reminder>`, which is a message. Asserting only on `system`
 *  would have reported this fix as broken while it worked. */
const capturing = (): { llm: LLMPort; turns: string[] } => {
  const turns: string[] = []
  const llm = {
    async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
      turns.push(
        JSON.stringify({
          system: typeof input.system === "string" ? input.system : input.system,
          messages: input.messages,
        }),
      )
      yield { type: "text_delta", delta: "ok" }
      yield { type: "message_stop", stop_reason: "end_turn" }
    },
  } as LLMPort
  return { llm, turns }
}

const runOnce = async (over: Partial<AgentConfig> = {}, turns = 1): Promise<string[]> => {
  const { llm, turns: wire } = capturing()
  await runAgent({
    llm,
    registry: new ToolRegistry([]),
    stream: { emit: () => undefined },
    permission: { mode: "acceptEdits" },
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    system: "t",
    cwd: process.cwd(),
    maxTurns: turns,
    signal: new AbortController().signal,
    ...over,
  } as unknown as AgentConfig)
  return wire
}

const TREE = "src/\n  index.ts\n  agent/\n    loop.ts"
/** JSON-escaped form, since the wire is captured as JSON. */
const TREE_ON_WIRE = "index.ts"

describe("E — the repo-map knob actually reaches the prompt", () => {
  test("E-1 knob ON ⇒ the turn-1 system prompt carries the repo map", async () => {
    const wire = await runOnce({
      repoMap: { maxDepth: 2, maxFiles: 200, maxChars: 6000 },
      repoMapScan: async () => TREE,
    } as Partial<AgentConfig>)
    expect(wire[0]).toContain(TREE_ON_WIRE)
  })

  test("E-5 the block carries the stale-tolerant framing", async () => {
    const wire = await runOnce({
      repoMap: { maxDepth: 2, maxFiles: 200, maxChars: 6000 },
      repoMapScan: async () => TREE,
    } as Partial<AgentConfig>)
    expect(wire[0]).toContain("may be incomplete or out of date")
  })

  test("E-2 DEFAULT-OFF — knob absent ⇒ the prompt is byte-identical", async () => {
    const off = await runOnce()
    const alsoOff = await runOnce()
    expect(off[0]).toBe(alsoOff[0])
    expect(off[0]).not.toContain("## Environment")
  })

  test("E-3 TURN-1 ONLY — the scan runs once, not per turn", async () => {
    let scans = 0
    await runOnce(
      {
        repoMap: { maxDepth: 2, maxFiles: 200, maxChars: 6000 },
        repoMapScan: async () => {
          scans++
          return TREE
        },
      } as Partial<AgentConfig>,
      3,
    )
    expect(scans).toBe(1)
  })

  test("E-4 FAIL-SOFT — a throwing scan leaves the prompt unchanged and the turn runs", async () => {
    const wire = await runOnce({
      repoMap: { maxDepth: 2, maxFiles: 200, maxChars: 6000 },
      repoMapScan: async () => {
        throw new Error("rg exploded")
      },
    } as Partial<AgentConfig>)
    expect(wire.length).toBe(1)
    expect(wire[0]).not.toContain("## Environment")
  })

  test("E-4b an EMPTY scan result adds no block", async () => {
    const wire = await runOnce({
      repoMap: { maxDepth: 2, maxFiles: 200, maxChars: 6000 },
      repoMapScan: async () => "",
    } as Partial<AgentConfig>)
    expect(wire[0]).not.toContain("## Environment")
  })
})

/* ------------------------------------------------------------------------- *
 * E-6 — WIRING PROOF: the knob sets BOTH halves.
 *
 * `repoMap` (caps) without `repoMapScan` (the port) is exactly the state this
 * knob shipped in — inert. Setting one without the other is the bug, and only
 * one of them looks like a bug, so pin that the shipped `applyRepoMap` produces
 * both.
 * ------------------------------------------------------------------------- */

describe("E-6 wiring — the shipped knob produces caps AND the scan port", () => {
  test("applyRepoMap sets both halves for the cli surface", async () => {
    const { applyRepoMap } = await import("@/runner/knobs/knobs/repo-map")
    const out = applyRepoMap(
      { cwd: process.cwd() } as unknown as AgentConfig,
      { enabled: true } as never,
      { surface: "cli" } as never,
    )
    expect(out.repoMap).toBeDefined()
    expect(typeof out.repoMapScan).toBe("function")
  })

  test("PAIRED CONTROL — an out-of-scope surface stays untouched", async () => {
    const { applyRepoMap } = await import("@/runner/knobs/knobs/repo-map")
    const base = { cwd: process.cwd() } as unknown as AgentConfig
    const out = applyRepoMap(base, { enabled: true } as never, { surface: "web" } as never)
    expect(out.repoMap).toBeUndefined()
    expect(out.repoMapScan).toBeUndefined()
  })
})
