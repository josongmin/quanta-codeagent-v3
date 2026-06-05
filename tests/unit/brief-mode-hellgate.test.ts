import { describe, expect, test } from "bun:test"
import { createBriefStore, parseBoolKnob } from "@/agent/brief"
import { applyBriefTransition, isSetBriefOp, isSetModeOp } from "@/agent/control-op-handler"
import type { TurnContextInput } from "@/agent/prompt"
import { buildSystemPrompt, buildTurnContext } from "@/agent/prompt"
import { BRIEF_NOTICE } from "@/agent/prompt-body"
import type { Submission } from "@/agent/submission"
import type { Message } from "@/llm"

/**
 * C3 — brief_mode (condensed output posture) hellgate.
 *
 * brief_mode is a PROMPT DIRECTIVE (not a render transform): when ON, a terse-
 * output directive (`BRIEF_NOTICE`) is spliced into the per-turn DYNAMIC
 * `<system-reminder>` slot, shaping the model's FINAL prose verbosity while
 * EXEMPTING correctness reporting (verification block / errors / evidence /
 * honesty ladder). It is ORTHOGONAL to the `effort` token ceiling and to `mode`.
 *
 * Invariants asserted here (RFC §6):
 *   1. ON  ⇒ the terse directive is present in the dynamic tail.
 *   2. OFF ⇒ absent, AND the dynamic tail is BYTE-IDENTICAL to the pre-feature
 *      golden (the headline safety invariant). `brief:false` ≡ brief omitted.
 *   3. The static cached prefix (`system` blocks) is identical ON vs OFF —
 *      brief rides the DYNAMIC slot only, never the cache prefix.
 *   4. The directive does NOT remove/alter the correctness-reporting
 *      instructions (Verification report fields stay in the static prefix).
 *   5. Toggle: `set_brief` control-op + the store flip it; the NEXT build emits
 *      the directive; flipping back restores byte-identical output.
 *   6. effort-tier remains independent — `mode` (a sibling dynamic notice) and
 *      brief compose: both can be set ("deep think + terse output"), with
 *      brief AFTER the mode notice.
 *   7. Defang safety: `BRIEF_NOTICE` carries no `<system-reminder>` tokens.
 *   8. Store + knob semantics.
 */

const seed: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }]

const base = (over: Partial<TurnContextInput> = {}): TurnContextInput => ({
  baseMessages: seed,
  cwd: "/repo",
  now: () => Date.parse("2026-06-05T00:00:00Z"),
  ...over,
})

const reminderText = (m: Message): string => {
  const block = m.content[0]
  return block?.type === "text" ? block.text : ""
}

const tailText = (input: TurnContextInput): string => {
  const { messages } = buildTurnContext(input)
  return reminderText(messages[messages.length - 1] as Message)
}

/** FROZEN GOLDEN of the LEGACY (pre-feature) no-brief reminder tail, pinned to
 *  the fixed clock (2026-06-05) + cwd (/repo) + no other dynamic context. This
 *  is the exact byte string `buildTurnContext` produced BEFORE the brief slice.
 *  Pinning it (not comparing two identical no-brief renders) lets the default-OFF
 *  test FAIL if any change ever emitted the directive unconditionally. */
const LEGACY_NO_BRIEF_TAIL =
  "<system-reminder>\nToday's date is 2026-06-05.\nWorking directory: /repo\n</system-reminder>"

const MARKER = "BRIEF MODE is active"

describe("brief_mode — toggle ON ⇒ directive present", () => {
  test("brief:true splices BRIEF_NOTICE into the dynamic tail", () => {
    const tail = tailText(base({ brief: true }))
    expect(tail).toContain(MARKER)
    expect(tail).toContain(BRIEF_NOTICE)
  })

  test("the marker is genuinely the BRIEF_NOTICE body, not an accident", () => {
    expect(BRIEF_NOTICE).toContain(MARKER)
  })
})

describe("brief_mode — default-OFF byte-identical (headline)", () => {
  test("brief omitted ⇒ tail equals the frozen legacy golden", () => {
    expect(tailText(base())).toBe(LEGACY_NO_BRIEF_TAIL)
  })

  test("brief:false ⇒ tail equals the frozen legacy golden (false ≡ omitted)", () => {
    expect(tailText(base({ brief: false }))).toBe(LEGACY_NO_BRIEF_TAIL)
  })

  test("brief:false ⇒ no marker leak", () => {
    expect(tailText(base({ brief: false }))).not.toContain(MARKER)
  })
})

describe("brief_mode — static cache prefix is untouched ON vs OFF", () => {
  const sys = (input: TurnContextInput) => buildTurnContext(input).system
  test("system blocks identical for brief:true vs brief:false", () => {
    expect(sys(base({ brief: true }))).toEqual(sys(base({ brief: false })))
  })
  test("brief NEVER perturbs the static prefix (matches brief omitted)", () => {
    expect(sys(base({ brief: true }))).toEqual(sys(base()))
  })
})

describe("brief_mode — does NOT suppress correctness reporting", () => {
  test("Verification report fields remain in the assembled prompt under brief", () => {
    const { system } = buildTurnContext(base({ brief: true }))
    const prefix = system.map((b) => (b.type === "text" ? b.text : "")).join("\n")
    // These live in the STATIC prefix (BODY_AFTER_PROMPT_PACK) — brief is a
    // DYNAMIC-slot directive and must never touch them.
    expect(prefix).toContain("Verification report")
    expect(prefix).toContain("verdict:")
    expect(prefix).toContain("Completion bar")
  })

  test("the directive itself self-exempts correctness reporting", () => {
    expect(BRIEF_NOTICE).toContain("EXPLANATORY prose ONLY")
    expect(BRIEF_NOTICE).toContain("Verification report")
    expect(BRIEF_NOTICE).toContain("file:line")
    expect(BRIEF_NOTICE).toContain("never an excuse to omit")
  })
})

describe("brief_mode — effort/mode orthogonality + ordering", () => {
  test("brief composes with an audit mode notice (both present)", () => {
    const tail = tailText(base({ brief: true, mode: "audit" }))
    expect(tail).toContain("AUDIT MODE is active")
    expect(tail).toContain(MARKER)
  })

  test("BRIEF_NOTICE appears AFTER the mode notice (deterministic position)", () => {
    const tail = tailText(base({ brief: true, mode: "audit" }))
    expect(tail.indexOf("AUDIT MODE is active")).toBeLessThan(tail.indexOf(MARKER))
  })

  test("mode-only (no brief) ⇒ no brief marker (independent axes)", () => {
    const tail = tailText(base({ mode: "audit" }))
    expect(tail).toContain("AUDIT MODE is active")
    expect(tail).not.toContain(MARKER)
  })
})

describe("brief_mode — defang safety", () => {
  test("BRIEF_NOTICE carries no <system-reminder> tokens", () => {
    expect(BRIEF_NOTICE.toLowerCase()).not.toContain("<system-reminder")
    expect(BRIEF_NOTICE.toLowerCase()).not.toContain("</system-reminder")
  })
  test("the outer wrapper stays well-formed under brief", () => {
    const tail = tailText(base({ brief: true }))
    expect(tail.startsWith("<system-reminder>\n")).toBe(true)
    expect(tail.endsWith("\n</system-reminder>")).toBe(true)
  })
})

describe("brief_mode — store + knob semantics", () => {
  test("createBriefStore default OFF; set flips; snapshot mirrors", () => {
    const store = createBriefStore()
    expect(store.get()).toBe(false)
    store.set(true)
    expect(store.get()).toBe(true)
    expect(store.snapshot()).toBe(true)
    store.set(false)
    expect(store.get()).toBe(false)
  })

  test("createBriefStore honors the seed value", () => {
    expect(createBriefStore(true).get()).toBe(true)
    expect(createBriefStore(false).get()).toBe(false)
  })

  test("parseBoolKnob maps the boolean knob vocabulary; unset ⇒ false", () => {
    for (const on of ["1", "true", "TRUE", "on", "ON", " true "]) {
      expect(parseBoolKnob(on)).toBe(true)
    }
    for (const off of [undefined, "", "0", "false", "no", "off", "yes-ish"]) {
      expect(parseBoolKnob(off)).toBe(false)
    }
  })
})

describe("brief_mode — set_brief control-op e2e self-mutation", () => {
  const setBriefSub = (on: boolean): Submission => ({
    id: "s1",
    op: { kind: "set_brief", on },
  })

  test("isSetBriefOp narrows; isSetModeOp does NOT match set_brief", () => {
    const sub = setBriefSub(true)
    expect(isSetBriefOp(sub)).toBe(true)
    expect(isSetModeOp(sub)).toBe(false)
  })

  test("applyBriefTransition flips the store; NEXT build emits the directive; flip back is byte-identical", () => {
    const store = createBriefStore(false)
    // Turn 1 (off): byte-identical golden.
    expect(tailText(base({ brief: store.get() }))).toBe(LEGACY_NO_BRIEF_TAIL)

    // Host receives set_brief(on) and applies it.
    const sub = setBriefSub(true)
    expect(isSetBriefOp(sub)).toBe(true)
    if (isSetBriefOp(sub)) {
      expect(applyBriefTransition(store, sub.op.on)).toBe(true)
    }
    // Turn 2 (on): directive present.
    expect(tailText(base({ brief: store.get() }))).toContain(MARKER)

    // set_brief(off) restores byte-identical output.
    applyBriefTransition(store, false)
    expect(store.get()).toBe(false)
    expect(tailText(base({ brief: store.get() }))).toBe(LEGACY_NO_BRIEF_TAIL)
  })
})

describe("brief_mode — buildSystemPrompt static prefix has no brief leak", () => {
  test("the static system prompt never mentions BRIEF MODE (dynamic-only)", () => {
    expect(buildSystemPrompt()).not.toContain(MARKER)
  })
})
