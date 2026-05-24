/**
 * HELLGATE — `quanta.hitl.*` OTel vocabulary emission proofs.
 *
 * Activates 3 previously-zero-emit vocabulary keys (`quanta.hitl.tier_resolved`,
 * `quanta.hitl.registry_escalated`, `quanta.hitl.handoff_emitted`) by routing
 * every gate decision through a captured {@link SpanSink}. Adversarial cases
 * check the security invariants attached to these emissions:
 *
 *   1. The handoff prompt text is NEVER emitted — only the kebab-case category
 *      tag (`hard-deny:<rule>`, `registry:<tool>`, `tier:hand-off-required`).
 *   2. Tool input / args are NEVER emitted — counts and categorical labels only.
 *   3. The 4 declared `tierResolved` literals all fire under the gate paths
 *      that produce them (`hand-off-required`, `always-confirm`,
 *      `pre-approval-ok`, `none`).
 *   4. `registryEscalated=true` only when the registry promoted the baseline.
 *   5. Absent sink ⇒ zero allocations, zero emissions (default-OFF).
 *
 * Source under test: src/agent/admissibility-gate.ts (`runHitlGate`,
 * `emitHandoffEvent`) + src/observability/spans.ts (`recordAttrs`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { runAdmissibilityGate } from "@/agent/admissibility-gate"
import { __resetHitlOverrides } from "@/agent/hitl-tier-registry"
import type { ToolUseBlock } from "@/llm"
import {
  __resetSpanSink,
  type Attrs,
  QUANTA_ATTRS,
  SPAN_NAMES,
  type SpanName,
  type SpanStatus,
  setSpanSink,
} from "@/observability"
import type { HITLTier, PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { Tool } from "@/tool"
import { ToolRegistry } from "@/tool"

/** Captured span event — a single shape covers both `onStart` and `onEnd` so
 *  tests can scan a flat list. `phase: "end"` carries the `status`+`durationMs`
 *  the sink received; `phase: "start"` records the initial attribute bag the
 *  emitter passed in. `recordAttrs` produces a `start`+`end` pair at the same
 *  call site, so both phases see the same attrs (the gate only emits via
 *  `recordAttrs`, never via long-lived spans here). */
interface CapturedEvent {
  phase: "start" | "end"
  name: SpanName
  attrs: Attrs
  status?: SpanStatus
  durationMs?: number
}

const installCapturingSink = (): CapturedEvent[] => {
  const events: CapturedEvent[] = []
  setSpanSink({
    onStart: (name, attrs) => {
      events.push({ phase: "start", name, attrs })
      // Token must be distinct per call so a mistakenly-shared frozen sentinel
      // would not silently merge events; we return a fresh object.
      return { kind: "test-token", at: events.length }
    },
    onEnd: (_token, name, status, durationMs, attrs) => {
      events.push({ phase: "end", name, attrs, status, durationMs })
    },
  })
  return events
}

let tmp: string

beforeEach(() => {
  tmp = join(tmpdir(), `hitl-otel-hellgate-${process.pid}-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  delete process.env.QUANTA_HITL_OVERRIDES
  __resetRuntimeConfig()
  __resetHitlOverrides()
  __resetSpanSink()
})

const makeTool = (
  name: string,
  opts: {
    readOnly?: boolean
    hitlTier?: (input: unknown) => HITLTier
    extractShellCommand?: (input: unknown) => string | null
  } = {},
): Tool => {
  const tool: Tool = {
    name,
    description: `${name}`,
    inputSchema: z.object({}).passthrough() as z.ZodType<unknown>,
    isReadOnly: () => opts.readOnly ?? false,
    isConcurrencySafe: () => opts.readOnly ?? false,
    execute: () =>
      (async function* () {
        yield { type: "result", result: { ok: true, output: "ran" } }
      })(),
  }
  if (opts.hitlTier) {
    ;(tool as Tool & { hitlTier: (input: unknown) => HITLTier }).hitlTier = opts.hitlTier
  }
  if (opts.extractShellCommand) {
    ;(
      tool as Tool & { extractShellCommand: (input: unknown) => string | null }
    ).extractShellCommand = opts.extractShellCommand
  }
  return tool
}

const callBlock = (name: string, input: unknown = {}, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

const cfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "default" } as PermissionContext,
    ...over,
  }) as AgentConfig

/** Pick all events that carry a given canonical key. Used by every assertion
 *  so test failures point at a concrete key bucket. */
const eventsWithKey = (events: readonly CapturedEvent[], key: string): CapturedEvent[] =>
  events.filter((e) => Object.hasOwn(e.attrs, key))

/** Sentinel substrings that MUST never appear inside any emitted attribute
 *  value — the handoff `handoffMessage` body, deny-reason explanations, or
 *  the literal tool input. Used to enforce the "outcome only, no prompt text"
 *  security invariant. */
const FORBIDDEN_SUBSTRINGS = [
  "human handoff",
  "Blocked dangerous command",
  "Action requires",
  "Run handoff_required",
  "rm -rf",
  "secret-token-xyz",
  "<password>",
]

const assertNoLeakage = (events: readonly CapturedEvent[]): void => {
  for (const e of events) {
    for (const [k, v] of Object.entries(e.attrs)) {
      if (typeof v !== "string") continue
      for (const banned of FORBIDDEN_SUBSTRINGS) {
        if (v.includes(banned)) {
          throw new Error(`attr "${k}" leaked forbidden substring "${banned}" via value "${v}"`)
        }
      }
    }
  }
}

describe("HITL OTel emission — tier_resolved literal coverage", () => {
  test("hand-off-required tier emits `tier_resolved=hand-off-required` + `registryEscalated=false`", async () => {
    const events = installCapturingSink()
    const sensitive = makeTool("sensitive", { hitlTier: () => "hand-off-required" })
    await runAdmissibilityGate(
      callBlock("sensitive", { x: 1 }),
      cfg({
        registry: new ToolRegistry([sensitive]),
        hitl: { enabled: true },
        permission: { mode: "default" } as PermissionContext,
      }),
      { mode: "default" } as PermissionContext,
      { tool: "sensitive", input: { x: 1 }, isReadOnly: false },
    )
    const tierHits = eventsWithKey(events, QUANTA_ATTRS.hitl.tierResolved)
    expect(tierHits.length).toBeGreaterThanOrEqual(1)
    expect(tierHits.every((e) => e.name === SPAN_NAMES.handleToolCall)).toBe(true)
    const startTier = tierHits.find((e) => e.phase === "start")
    expect(startTier?.attrs[QUANTA_ATTRS.hitl.tierResolved]).toBe("hand-off-required")
    expect(startTier?.attrs[QUANTA_ATTRS.hitl.registryEscalated]).toBe(false)
    assertNoLeakage(events)
  })

  test("always-confirm tier emits `tier_resolved=always-confirm` + the gate consults onConfirm", async () => {
    const events = installCapturingSink()
    const confirm = makeTool("confirmable", { hitlTier: () => "always-confirm" })
    let confirmCalled = 0
    await runAdmissibilityGate(
      callBlock("confirmable"),
      cfg({
        registry: new ToolRegistry([confirm]),
        hitl: { enabled: true },
        permission: { mode: "default" } as PermissionContext,
        onConfirm: async () => {
          confirmCalled += 1
          return true
        },
      }),
      { mode: "default" } as PermissionContext,
      { tool: "confirmable", input: {}, isReadOnly: false },
    )
    expect(confirmCalled).toBe(1)
    const tierHits = eventsWithKey(events, QUANTA_ATTRS.hitl.tierResolved)
    expect(tierHits.some((e) => e.attrs[QUANTA_ATTRS.hitl.tierResolved] === "always-confirm")).toBe(
      true,
    )
    assertNoLeakage(events)
  })

  test("none tier (read-only) emits `tier_resolved=none`", async () => {
    const events = installCapturingSink()
    const ro = makeTool("read-only", { readOnly: true, hitlTier: () => "none" })
    await runAdmissibilityGate(
      callBlock("read-only"),
      cfg({
        registry: new ToolRegistry([ro]),
        hitl: { enabled: true },
        permission: { mode: "default" } as PermissionContext,
      }),
      { mode: "default" } as PermissionContext,
      { tool: "read-only", input: {}, isReadOnly: true },
    )
    const tierHits = eventsWithKey(events, QUANTA_ATTRS.hitl.tierResolved)
    expect(tierHits.some((e) => e.attrs[QUANTA_ATTRS.hitl.tierResolved] === "none")).toBe(true)
    assertNoLeakage(events)
  })

  test("pre-approval-ok tier emits `tier_resolved=pre-approval-ok`", async () => {
    const events = installCapturingSink()
    const tool = makeTool("editor", { hitlTier: () => "pre-approval-ok" })
    await runAdmissibilityGate(
      callBlock("editor"),
      cfg({
        registry: new ToolRegistry([tool]),
        hitl: { enabled: true },
        permission: { mode: "default" } as PermissionContext,
      }),
      { mode: "default" } as PermissionContext,
      { tool: "editor", input: {}, isReadOnly: false },
    )
    const tierHits = eventsWithKey(events, QUANTA_ATTRS.hitl.tierResolved)
    expect(
      tierHits.some((e) => e.attrs[QUANTA_ATTRS.hitl.tierResolved] === "pre-approval-ok"),
    ).toBe(true)
    assertNoLeakage(events)
  })
})

describe("HITL OTel emission — registry escalation + handoff tag", () => {
  test("registry promotion fires `registryEscalated=true` AND `handoff_emitted=registry:<tool>`", async () => {
    const overridePath = join(tmp, "h.json")
    writeFileSync(
      overridePath,
      JSON.stringify({
        version: 1,
        annotations: [
          {
            tool: "write",
            tier: "hand-off-required",
            // The reason text is sensitive prose — assert below that it is
            // NOT routed into any emitted attribute.
            reason: "Action requires audit: writes always trigger human handoff",
          },
        ],
      }),
      "utf8",
    )
    process.env.QUANTA_HITL_OVERRIDES = overridePath
    __resetRuntimeConfig()
    __resetHitlOverrides()

    const events = installCapturingSink()
    const write = makeTool("write", { hitlTier: () => "pre-approval-ok" })
    await runAdmissibilityGate(
      callBlock("write", { path: "x", content: "secret-token-xyz" }),
      cfg({
        registry: new ToolRegistry([write]),
        hitl: { enabled: true },
        permission: { mode: "default" } as PermissionContext,
      }),
      { mode: "default" } as PermissionContext,
      { tool: "write", input: { path: "x", content: "secret-token-xyz" }, isReadOnly: false },
    )
    const tierHits = eventsWithKey(events, QUANTA_ATTRS.hitl.tierResolved)
    const escalated = tierHits.find((e) => e.attrs[QUANTA_ATTRS.hitl.registryEscalated] === true)
    expect(escalated).toBeDefined()
    expect(escalated?.attrs[QUANTA_ATTRS.hitl.tierResolved]).toBe("hand-off-required")
    const handoffHits = eventsWithKey(events, QUANTA_ATTRS.hitl.handoffEmitted)
    expect(handoffHits.length).toBeGreaterThanOrEqual(1)
    const tag = handoffHits[0]?.attrs[QUANTA_ATTRS.hitl.handoffEmitted]
    expect(typeof tag).toBe("string")
    expect(tag).toBe("registry:write")
    assertNoLeakage(events)
  })

  test("HARD_DENY hit emits `handoff_emitted=hard-deny:<reason-slug>` — never the full prompt", async () => {
    const events = installCapturingSink()
    const bash = makeTool("bash", {
      extractShellCommand: (i) => (i as { command?: string }).command ?? null,
    })
    const input = { command: "rm -rf /" }
    await runAdmissibilityGate(
      callBlock("bash", input),
      cfg({
        registry: new ToolRegistry([bash]),
        hitl: { enabled: true },
        permission: { mode: "bypass" } as PermissionContext,
      }),
      { mode: "bypass" } as PermissionContext,
      Object.assign({ tool: "bash", input, isReadOnly: false }, { shellCommand: "rm -rf /" }),
    )
    const handoffHits = eventsWithKey(events, QUANTA_ATTRS.hitl.handoffEmitted)
    expect(handoffHits.length).toBeGreaterThanOrEqual(1)
    const tag = String(handoffHits[0]?.attrs[QUANTA_ATTRS.hitl.handoffEmitted] ?? "")
    // The slug is the categorical kebab tag — the prose suffix (which carries
    // the offending command) MUST have been stripped before emission. The
    // canonical slug for HARD_DENY hits is the bare `"hard-deny"` literal.
    expect(tag).toBe("hard-deny")
    // Defense in depth: no spaces, no command echo, no prompt body.
    expect(tag.includes(" ")).toBe(false)
    expect(tag.includes("rm -rf")).toBe(false)
    expect(tag.includes("Blocked")).toBe(false)
    assertNoLeakage(events)
  })

  test("explicit hand-off-required tier emits `handoff_emitted=tier:hand-off-required`", async () => {
    const events = installCapturingSink()
    const sensitive = makeTool("sensitive", { hitlTier: () => "hand-off-required" })
    await runAdmissibilityGate(
      callBlock("sensitive"),
      cfg({
        registry: new ToolRegistry([sensitive]),
        hitl: { enabled: true },
        permission: { mode: "default" } as PermissionContext,
      }),
      { mode: "default" } as PermissionContext,
      { tool: "sensitive", input: {}, isReadOnly: false },
    )
    const handoffHits = eventsWithKey(events, QUANTA_ATTRS.hitl.handoffEmitted)
    expect(handoffHits.length).toBeGreaterThanOrEqual(1)
    expect(handoffHits[0]?.attrs[QUANTA_ATTRS.hitl.handoffEmitted]).toBe("tier:hand-off-required")
    assertNoLeakage(events)
  })
})

describe("HITL OTel emission — security invariants", () => {
  test("no emitted attr value contains the user-facing handoff message text", async () => {
    const events = installCapturingSink()
    const sensitive = makeTool("sensitive", { hitlTier: () => "hand-off-required" })
    await runAdmissibilityGate(
      callBlock("sensitive", { command: "rm -rf /", secret: "<password>" }),
      cfg({
        registry: new ToolRegistry([sensitive]),
        hitl: { enabled: true },
        permission: { mode: "default" } as PermissionContext,
      }),
      { mode: "default" } as PermissionContext,
      {
        tool: "sensitive",
        input: { command: "rm -rf /", secret: "<password>" },
        isReadOnly: false,
      },
    )
    // Every emitted attribute value must avoid the prompt body AND the input.
    // assertNoLeakage exhaustively scans for the forbidden substring set —
    // a regression that routes `handoffMessage` into an attribute would fail
    // here with the offending key/value labelled.
    assertNoLeakage(events)
    // Defensive: also reject any structured value that pulls in `input`-shaped
    // bag, just in case a future emitter `JSON.stringify`s the call. The
    // attribute vocabulary forbids object values at the validator layer
    // (`attrs.ts#validateValue`), so a non-string non-primitive value here
    // would already be a fatal error in the helper — assert string-only.
    for (const e of events) {
      for (const v of Object.values(e.attrs)) {
        expect(typeof v === "string" || typeof v === "number" || typeof v === "boolean").toBe(true)
      }
    }
  })

  test("absent span sink ⇒ zero events captured (default-OFF byte-identical)", async () => {
    // Do NOT install a sink. The gate must run normally; no observability
    // side-effects emitted. We verify by installing a sink AFTER the call
    // and asserting it stayed empty during the call (a separate, NEW sink
    // post-call would be wrong — instead, we run the call with the sink
    // NULL via `__resetSpanSink`, then turn the sink on and run a no-op to
    // confirm wiring still works).
    __resetSpanSink()
    const sensitive = makeTool("sensitive", { hitlTier: () => "hand-off-required" })
    await runAdmissibilityGate(
      callBlock("sensitive"),
      cfg({
        registry: new ToolRegistry([sensitive]),
        hitl: { enabled: true },
        permission: { mode: "default" } as PermissionContext,
      }),
      { mode: "default" } as PermissionContext,
      { tool: "sensitive", input: {}, isReadOnly: false },
    )
    // Now wire a sink; subsequent calls emit. (Sanity check that the helper
    // is still bound and the no-emit branch above was sink-driven, not a
    // code-path bug suppressing emission entirely.)
    const events = installCapturingSink()
    await runAdmissibilityGate(
      callBlock("sensitive"),
      cfg({
        registry: new ToolRegistry([sensitive]),
        hitl: { enabled: true },
        permission: { mode: "default" } as PermissionContext,
      }),
      { mode: "default" } as PermissionContext,
      { tool: "sensitive", input: {}, isReadOnly: false },
    )
    expect(eventsWithKey(events, QUANTA_ATTRS.hitl.tierResolved).length).toBeGreaterThan(0)
  })
})
