/**
 * HELLGATE — jun-7-misc 04: `evaluateAuto` overlay + circumvention WIRING.
 *
 * Pins the policy-layer integration of both halves, with the DEFAULT-OFF
 * byte-identity ratchet at its core:
 *
 *  - DEFAULT-OFF RATCHET: `evaluateAuto(action, ctx, classifier)` with NO 4th
 *    `opts` arg behaves EXACTLY as before — the classifier sees the canonical
 *    `CLASSIFIER_SYSTEM_PROMPT` (no overlay section, no circumvention line), and
 *    no tracker is consulted. If the OFF path ever drifts (e.g. always composing
 *    an overlay), every auto-mode classification changes silently.
 *  - OVERLAID PROMPT: when `opts.overlaidSystemPrompt` is supplied, the
 *    classifier sees THAT prompt verbatim (the gate composed the operator rules).
 *  - CIRCUMVENTION ADVISORY (default posture): a soft-denied write to X, then a
 *    same-path write via a DIFFERENT tool, threads the verbatim circumvention
 *    taxonomy line + advisory into the NEXT classification — never an auto-block.
 *  - CIRCUMVENTION ESCALATE (strict posture): the same match forces a HITL
 *    `ask` — never an `allow`.
 *  - SOFT-DENY RECORDS / ALLOW CLEARS: a classifier `deny` records the effect; a
 *    classifier `allow` clears it.
 *  - HARD_DENY UNAFFECTED: a HARD_DENY hit is terminal and is NEVER routed
 *    through the tracker (no signature recorded).
 *
 * Source under test:
 *   src/permission/policy.ts — evaluateAuto(opts) + precheckCircumvention
 */
import { describe, expect, test } from "bun:test"
import {
  AutoModeClassifier,
  CIRCUMVENTION_TAXONOMY_LINE,
  CircumventionTracker,
  CLASSIFIER_SYSTEM_PROMPT,
  type ClassifyDecision,
  type ClassifyRequest,
  type EffectSignature,
  evaluateAuto,
  type PermissionContext,
  type ToolAction,
} from "@/permission"

/** A classifier port that returns a fixed verdict and records every prompt. */
const recordingPort = (verdict: "allow" | "block") => {
  const prompts: string[] = []
  const port = (req: ClassifyRequest): Promise<ClassifyDecision> => {
    prompts.push(req.systemPrompt)
    return Promise.resolve({ verdict, reason: `${verdict} (mock)` })
  }
  return { port, prompts }
}

const autoCtx = (port: (r: ClassifyRequest) => Promise<ClassifyDecision>): PermissionContext => ({
  mode: "auto",
  classify: port,
})

const action = (tool: string, input: unknown): ToolAction => ({
  tool,
  input,
  isReadOnly: false,
})

const writeSig = (path: string): EffectSignature => ({ kind: "write", path })

describe("DEFAULT-OFF ratchet — no opts ⇒ canonical prompt, no wiring", () => {
  test("classifier sees CLASSIFIER_SYSTEM_PROMPT verbatim when opts omitted", async () => {
    const { port, prompts } = recordingPort("allow")
    const clf = new AutoModeClassifier(port)
    const dec = await evaluateAuto(action("bash", { command: "ls" }), autoCtx(port), clf)
    expect(dec.kind).toBe("allow")
    // The fast-stage prompt is exactly the canonical taxonomy — no overlay
    // section, no circumvention line appended.
    expect(prompts[0]).toBe(CLASSIFIER_SYSTEM_PROMPT)
    expect(prompts[0]).not.toContain("Operator Rules")
    expect(prompts[0]).not.toContain("TOOL-SWITCH CIRCUMVENTION")
  })
})

describe("overlaid prompt passes through verbatim", () => {
  test("opts.overlaidSystemPrompt is what the classifier sees", async () => {
    const { port, prompts } = recordingPort("allow")
    const clf = new AutoModeClassifier(port)
    const overlaid = `${CLASSIFIER_SYSTEM_PROMPT}\n\n## Operator Rules (auto-mode overlay)\n- mine`
    await evaluateAuto(action("bash", { command: "ls" }), autoCtx(port), clf, {
      overlaidSystemPrompt: overlaid,
    })
    expect(prompts[0]).toBe(overlaid)
  })
})

describe("circumvention — ADVISORY posture (default)", () => {
  test("same-path write via a different tool threads the verbatim taxonomy line", async () => {
    const tracker = new CircumventionTracker()
    // A prior soft-deny of a Write to /repo/X (recorded directly).
    tracker.noteDenied(writeSig("/repo/X"), "Write", 1)

    const { port, prompts } = recordingPort("allow")
    const clf = new AutoModeClassifier(port)
    const dec = await evaluateAuto(
      action("bash", { command: "echo > /repo/X" }),
      autoCtx(port),
      clf,
      {
        tracker,
        effect: writeSig("/repo/X"),
        turn: 2,
        posture: "advisory",
      },
    )
    // Advisory NEVER auto-blocks — the LLM (here mock-allow) still decides.
    expect(dec.kind).toBe("allow")
    expect(prompts[0]).toContain(CIRCUMVENTION_TAXONOMY_LINE)
    expect(prompts[0]).toContain("/repo/X")
  })

  test("no live signal ⇒ no circumvention line (byte-identical to canonical)", async () => {
    const tracker = new CircumventionTracker()
    const { port, prompts } = recordingPort("allow")
    const clf = new AutoModeClassifier(port)
    await evaluateAuto(action("bash", { command: "echo > /repo/Y" }), autoCtx(port), clf, {
      tracker,
      effect: writeSig("/repo/Y"),
      turn: 2,
    })
    expect(prompts[0]).toBe(CLASSIFIER_SYSTEM_PROMPT)
  })
})

describe("circumvention — ESCALATE posture (strict)", () => {
  test("a match forces a HITL `ask` — never allow, classifier not even consulted", async () => {
    const tracker = new CircumventionTracker()
    tracker.noteDenied(writeSig("/repo/X"), "Write", 1)
    const { port, prompts } = recordingPort("allow") // would allow if consulted
    const clf = new AutoModeClassifier(port)
    const dec = await evaluateAuto(
      action("bash", { command: "echo > /repo/X" }),
      autoCtx(port),
      clf,
      {
        tracker,
        effect: writeSig("/repo/X"),
        turn: 2,
        posture: "escalate",
      },
    )
    expect(dec.kind).toBe("ask")
    // The forced ask short-circuits BEFORE the classifier — no prompt recorded.
    expect(prompts.length).toBe(0)
  })
})

describe("soft-deny records / allow clears the tracker", () => {
  test("a classifier DENY records the denied write effect", async () => {
    const tracker = new CircumventionTracker()
    const { port } = recordingPort("block")
    const clf = new AutoModeClassifier(port)
    const dec = await evaluateAuto(action("Write", { path: "/repo/X" }), autoCtx(port), clf, {
      tracker,
      effect: writeSig("/repo/X"),
      turn: 1,
    })
    expect(dec.kind).toBe("deny")
    // The effect is now memorized: a later DIFFERENT-tool write to X matches.
    expect(tracker.matchCircumvention(writeSig("/repo/X"), "bash", 2)).toBeDefined()
  })

  test("a classifier ALLOW clears any prior signature for that effect", async () => {
    const tracker = new CircumventionTracker()
    tracker.noteDenied(writeSig("/repo/X"), "Write", 1)
    const { port } = recordingPort("allow")
    const clf = new AutoModeClassifier(port)
    const dec = await evaluateAuto(
      action("bash", { command: "echo > /repo/X" }),
      autoCtx(port),
      clf,
      {
        tracker,
        effect: writeSig("/repo/X"),
        turn: 2,
      },
    )
    expect(dec.kind).toBe("allow")
    expect(tracker.size()).toBe(0)
  })
})

describe("circumvention — MULTI-PATH decoy (round-4) at the policy layer", () => {
  test("escalate fires when the SOFT-DENIED path is the SECOND write in a chain", async () => {
    // /repo/SECRET soft-denied via Edit; the agent runs a decoy redirect FIRST.
    const tracker = new CircumventionTracker()
    tracker.noteDenied(writeSig("/repo/SECRET"), "Edit", 1)
    const { port, prompts } = recordingPort("allow") // would allow if not escalated
    const clf = new AutoModeClassifier(port)
    const dec = await evaluateAuto(
      action("bash", { command: "echo decoy > /repo/DECOY; echo evil > /repo/SECRET" }),
      autoCtx(port),
      clf,
      {
        tracker,
        // The gate now supplies ALL effects (plural); the single `effect` is the
        // decoy and would MISS the match if `effects` were ignored.
        effect: writeSig("/repo/DECOY"),
        effects: [writeSig("/repo/DECOY"), writeSig("/repo/SECRET")],
        turn: 2,
        posture: "escalate",
      },
    )
    expect(dec.kind).toBe("ask")
    expect(prompts.length).toBe(0)
  })

  test("advisory threads the line for a decoy-prefixed match (LLM still decides)", async () => {
    const tracker = new CircumventionTracker()
    tracker.noteDenied(writeSig("/repo/SECRET"), "Write", 1)
    const { port, prompts } = recordingPort("allow")
    const clf = new AutoModeClassifier(port)
    const dec = await evaluateAuto(
      action("bash", { command: "echo a > /repo/A; echo b > /repo/SECRET" }),
      autoCtx(port),
      clf,
      {
        tracker,
        effect: writeSig("/repo/A"),
        effects: [writeSig("/repo/A"), writeSig("/repo/SECRET")],
        turn: 2,
        posture: "advisory",
      },
    )
    expect(dec.kind).toBe("allow")
    expect(prompts[0]).toContain(CIRCUMVENTION_TAXONOMY_LINE)
    expect(prompts[0]).toContain("/repo/SECRET")
  })

  test("soft-deny records EVERY effect in a multi-path chain", async () => {
    const tracker = new CircumventionTracker()
    const { port } = recordingPort("block")
    const clf = new AutoModeClassifier(port)
    const dec = await evaluateAuto(
      action("bash", { command: "echo a > /repo/A; echo b > /repo/B" }),
      autoCtx(port),
      clf,
      {
        tracker,
        effects: [writeSig("/repo/A"), writeSig("/repo/B")],
        turn: 1,
      },
    )
    expect(dec.kind).toBe("deny")
    // BOTH paths are now memorized — a later tool-switch to EITHER matches.
    expect(tracker.matchCircumvention(writeSig("/repo/A"), "Edit", 2)).toBeDefined()
    expect(tracker.matchCircumvention(writeSig("/repo/B"), "Edit", 2)).toBeDefined()
  })

  test("back-compat: a single `effect` (no `effects`) still matches", async () => {
    const tracker = new CircumventionTracker()
    tracker.noteDenied(writeSig("/repo/X"), "Write", 1)
    const { port } = recordingPort("allow")
    const clf = new AutoModeClassifier(port)
    const dec = await evaluateAuto(
      action("bash", { command: "echo > /repo/X" }),
      autoCtx(port),
      clf,
      {
        tracker,
        effect: writeSig("/repo/X"),
        turn: 2,
        posture: "escalate",
      },
    )
    expect(dec.kind).toBe("ask")
  })
})

describe("HARD_DENY is terminal — NEVER tracked", () => {
  test("a HARD_DENY hit denies and records ZERO signatures", async () => {
    const tracker = new CircumventionTracker()
    const { port } = recordingPort("allow")
    const clf = new AutoModeClassifier(port)
    // `rm -rf /` is a HARD_DENY denylist hit (shell-equivalent action).
    const act: ToolAction = {
      tool: "bash",
      input: { command: "rm -rf /" },
      isReadOnly: false,
      shellCommand: "rm -rf /",
    }
    const dec = await evaluateAuto(act, autoCtx(port), clf, {
      tracker,
      effect: writeSig("/"),
      turn: 1,
    })
    expect(dec.kind).toBe("deny")
    // Terminal HARD_DENY short-circuits BEFORE any tracker bookkeeping.
    expect(tracker.size()).toBe(0)
  })
})
