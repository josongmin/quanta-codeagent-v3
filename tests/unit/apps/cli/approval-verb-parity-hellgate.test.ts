/**
 * ★ HELLGATE — Wave-4 verbs cluster (jul-10 uiux structural):
 *
 *   UUX-1-06 (A-r2) — DEFERRED approval verb parity. The deferred NORMAL
 *   prompt (`buildCliApprovalPrompt`, non-escalation arm) offered only
 *   [y]/[a]/[N] while the inline confirm offered deny+s[t]eer too — answering
 *   "t <steer>" at the deferred prompt yielded a PLAIN deny and the operator's
 *   corrective steer silently vanished. Both arms must render/map through ONE
 *   shared helper (capability-declared: verbs that structurally need the
 *   ToolAction — [p]/[P] prefix, [h]unk — stay inline-only, DECLARED not forked).
 *
 *   UUX-2-18 (CLI half) — an empty deny-steer answer RE-PROMPTS once
 *   ("steer text required (or N to deny)") instead of silently degrading to a
 *   plain deny.
 *
 *   C2 — a SUPERSEDED channel release is diagnosable: the consumer notice names
 *   WHICH ask superseded which (label threaded through `awaitLine`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { MidTurnLineResult } from "@/apps/cli/repl/mid-turn-approval-channel"
import { __testing } from "@/apps/cli/repl/runtime-context-compose"
import type { ToolAction } from "@/permission"
import type { PendingApprovalView } from "@/protocol/session"
import { normalizeApprovalDecision } from "@/runner/orchestrate"

// ── fixtures ──────────────────────────────────────────────────────────────────

/** A scripted channel: each awaitLine consumes the next entry (a raw line or a
 *  typed release). Captures the labels consumers pass (C2). */
const scriptedChannel = (script: readonly (string | MidTurnLineResult)[]) => {
  const queue = [...script]
  const labels: (string | undefined)[] = []
  return {
    labels,
    channel: {
      active: true,
      awaitLine: async (_signal?: AbortSignal, label?: string): Promise<MidTurnLineResult> => {
        labels.push(label)
        const next = queue.shift()
        if (next === undefined) throw new Error("channel script exhausted — prompt over-asked")
        return typeof next === "string" ? { kind: "line", line: next } : next
      },
      tryResolve: () => false,
      clear: () => {},
    },
  }
}

const makeDeps = (script: readonly (string | MidTurnLineResult)[]) => {
  const counters = { accepts: 0, denies: 0 }
  const { channel, labels } = scriptedChannel(script)
  return {
    counters,
    labels,
    deps: {
      idleMonitor: { markActive: () => {} } as never,
      rejectCounter: {
        recordAccept: () => {
          counters.accepts += 1
        },
        recordDeny: () => {
          counters.denies += 1
        },
      } as never,
      channel: channel as never,
    },
  }
}

const approval: PendingApprovalView = {
  approvalId: "ap-1",
  reason: "terminal.needs_approval",
  requestedAt: "2026-07-10T00:00:00.000Z",
}

const plainAction: ToolAction = { tool: "edit_file", input: {}, isReadOnly: false }

const captureStderr = async (fn: () => Promise<unknown>): Promise<string> => {
  const orig = process.stderr.write.bind(process.stderr)
  let buf = ""
  process.stderr.write = ((chunk: unknown) => {
    buf += String(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    await fn()
  } finally {
    process.stderr.write = orig
  }
  return buf
}

// Quiet gates so the inline confirm renders ONLY the verb prompt.
const ENV_KEYS = ["QUANTA_PREFLIGHT_CHECK", "QUANTA_DIFF_PREVIEW", "QUANTA_HUNK_APPROVAL"] as const
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    process.env[k] = "0"
  }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

// ── UUX-1-06 — deferred verb parity ──────────────────────────────────────────

describe("HELLGATE UUX-1-06 — deferred approval verb parity (shared helper)", () => {
  test("RED pin: deferred 't' + steer text ⇒ the steer SURVIVES as {decision:'deny', steer}", async () => {
    const { deps } = makeDeps(["t", "edit the fixture copy instead"])
    const prompt = __testing.buildCliApprovalPrompt(deps as never)
    const raw = await captureStderr(async () => {
      const result = await prompt(approval)
      expect(normalizeApprovalDecision(result)).toEqual({
        decision: "deny",
        steer: "edit the fixture copy instead",
      })
    })
    expect(raw).toContain("Steer")
  })

  test("deferred prompt OFFERS the deny+steer verb (verb parity with the inline confirm)", async () => {
    const { deps } = makeDeps(["y"])
    const prompt = __testing.buildCliApprovalPrompt(deps as never)
    const out = await captureStderr(() => prompt(approval))
    expect(out).toContain("deny+s[t]eer")
    expect(out).toContain("[a]lways session")
  })

  test("capability flags: the deferred arm (no ToolAction) offers NO [p]/[P] prefix and NO hunk verb", async () => {
    const { deps } = makeDeps(["y"])
    const prompt = __testing.buildCliApprovalPrompt(deps as never)
    const out = await captureStderr(() => prompt(approval))
    expect(out).not.toContain("[p]")
    expect(out).not.toContain("hunk")
    expect(out).not.toContain("ALL sessions")
  })

  test("PAIRED control: 'a' still maps to approve+session (pre-existing verb intact)", async () => {
    const { deps, counters } = makeDeps(["a"])
    const prompt = __testing.buildCliApprovalPrompt(deps as never)
    await captureStderr(async () => {
      expect(normalizeApprovalDecision(await prompt(approval))).toEqual({
        decision: "approve",
        scope: "session",
      })
    })
    expect(counters.accepts).toBe(1)
  })

  test("PAIRED control: 'y' approves; empty answer fail-closes to a plain deny", async () => {
    {
      const { deps } = makeDeps(["y"])
      const prompt = __testing.buildCliApprovalPrompt(deps as never)
      await captureStderr(async () => {
        expect(normalizeApprovalDecision(await prompt(approval))).toEqual({ decision: "approve" })
      })
    }
    {
      const { deps, counters } = makeDeps([""])
      const prompt = __testing.buildCliApprovalPrompt(deps as never)
      await captureStderr(async () => {
        expect(normalizeApprovalDecision(await prompt(approval))).toEqual({ decision: "deny" })
      })
      expect(counters.denies).toBe(1)
    }
  })

  test("SAME-HELPER proof: inline and deferred render the IDENTICAL verb tail for a plain action", async () => {
    const verbTail = "[y]es / [a]lways session / [N]o / deny+s[t]eer: "
    const inline = makeDeps(["y"])
    const inlineOut = await captureStderr(() =>
      __testing.buildCliOnConfirm(inline.deps as never)(plainAction),
    )
    const deferred = makeDeps(["y"])
    const deferredOut = await captureStderr(() =>
      __testing.buildCliApprovalPrompt(deferred.deps as never)(approval),
    )
    expect(inlineOut).toContain(verbTail)
    expect(deferredOut).toContain(verbTail)
    // The inline wording the hitl e2e pins stays byte-identical.
    expect(inlineOut).toContain(`Allow edit_file? ${verbTail}`)
  })
})

// ── UUX-2-18 — empty steer re-asks once ──────────────────────────────────────

describe("HELLGATE UUX-2-18 — empty deny-steer re-prompts once (never silent degrade)", () => {
  test("deferred: 't' → empty → re-prompt → steer text ⇒ steer survives", async () => {
    const { deps } = makeDeps(["t", "", "run the linter first"])
    const prompt = __testing.buildCliApprovalPrompt(deps as never)
    const out = await captureStderr(async () => {
      expect(normalizeApprovalDecision(await prompt(approval))).toEqual({
        decision: "deny",
        steer: "run the linter first",
      })
    })
    expect(out).toContain("steer text required (or N to deny)")
  })

  test("deferred: 't' → empty → empty again ⇒ plain deny (no phantom steer)", async () => {
    const { deps } = makeDeps(["t", "", ""])
    const prompt = __testing.buildCliApprovalPrompt(deps as never)
    await captureStderr(async () => {
      expect(normalizeApprovalDecision(await prompt(approval))).toEqual({ decision: "deny" })
    })
  })

  test("deferred: 't' → empty → 'N' ⇒ plain deny (the offered escape hatch)", async () => {
    const { deps } = makeDeps(["t", "", "N"])
    const prompt = __testing.buildCliApprovalPrompt(deps as never)
    await captureStderr(async () => {
      expect(normalizeApprovalDecision(await prompt(approval))).toEqual({ decision: "deny" })
    })
  })

  test("inline confirm: 't' → empty → re-prompt → steer ⇒ deny_and_steer (not a silent plain deny)", async () => {
    const { deps, counters } = makeDeps(["t", "", "prefer rg over grep"])
    const onConfirm = __testing.buildCliOnConfirm(deps as never)
    const out = await captureStderr(async () => {
      expect(await onConfirm(plainAction)).toEqual({
        decision: "deny_and_steer",
        steer: "prefer rg over grep",
      })
    })
    expect(out).toContain("steer text required (or N to deny)")
    expect(counters.denies).toBe(1)
  })

  test("inline ESCALATION arm re-asks too (the shared steer reader, no fork)", async () => {
    const { deps } = makeDeps(["t", "", "use the scoped variant"])
    const onConfirm = __testing.buildCliOnConfirm(deps as never)
    const escalation: ToolAction = {
      tool: "bash",
      input: {},
      isReadOnly: false,
      scopeContext: { activeSkill: "deploy", reason: "out of scope" },
    } as never
    await captureStderr(async () => {
      expect(await onConfirm(escalation)).toEqual({
        decision: "deny_and_steer",
        steer: "use the scoped variant",
      })
    })
  })
})

// ── C2 — superseded release diagnosability at the consumer ───────────────────

describe("HELLGATE C2 — a superseded ask names its superseder (diagnosable, still fail-closed)", () => {
  test("deferred prompt: a superseded release prints WHICH ask superseded it, maps to deny", async () => {
    const { deps } = makeDeps([
      { kind: "released", cause: "superseded", supersededBy: "elicitation" },
    ])
    const prompt = __testing.buildCliApprovalPrompt(deps as never)
    let decision: unknown
    const out = await captureStderr(async () => {
      decision = await prompt(approval)
    })
    expect(normalizeApprovalDecision(decision as never)).toEqual({ decision: "deny" })
    expect(out).toContain("superseded by elicitation")
  })

  test("the approval prompts LABEL their asks 'approval' on the channel", async () => {
    const { deps, labels } = makeDeps(["y"])
    const prompt = __testing.buildCliApprovalPrompt(deps as never)
    await captureStderr(() => prompt(approval))
    expect(labels).toEqual(["approval"])
  })

  test("elicitation reads LABEL their asks 'elicitation' on the channel", async () => {
    const { readViaMidTurnChannelOrReadline } = await import("@/apps/cli/mcp-elicitation-prompter")
    const { registerMidTurnApprovalChannel, createMidTurnApprovalChannel } = await import(
      "@/apps/cli/repl/mid-turn-approval-channel"
    )
    const labels: (string | undefined)[] = []
    const real = createMidTurnApprovalChannel()
    const spy = {
      active: true,
      awaitLine: (signal?: AbortSignal, label?: string) => {
        labels.push(label)
        return real.awaitLine(signal, label)
      },
      tryResolve: (line: string) => real.tryResolve(line),
      clear: (cause: never) => real.clear(cause),
    }
    registerMidTurnApprovalChannel(spy as never)
    const read = readViaMidTurnChannelOrReadline(new AbortController().signal)
    real.tryResolve("blue")
    expect(await read).toBe("blue")
    expect(labels).toEqual(["elicitation"])
    // Restore a benign registration for other tests in this process.
    registerMidTurnApprovalChannel(real)
  })
})
