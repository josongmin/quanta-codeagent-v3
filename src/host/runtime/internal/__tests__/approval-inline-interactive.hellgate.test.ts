import { describe, expect, test } from "bun:test"
import type { ToolAction } from "@/permission"
import { __testing as approvalTesting } from "../context-binding"

/**
 * Inline-interactive approval (jun-10 HITL restructure) — hellgate.
 *
 * Problem class this pins: on a surface WITH a live operator (interactive CLI),
 * the runtime approval protocol used to be deferred-ONLY — every mid-turn "ask"
 * threw `RuntimeApprovalRequiredError`, aborted the WHOLE turn, prompted, then
 * re-ran the turn from scratch (re-paying the full prompt: ~140k input tokens
 * per approval in real sessions). SOTA baseline (Claude Code / Codex): an
 * interactive surface confirms INLINE at the gate — the turn never aborts.
 *
 * Contract pinned here:
 *  1. `approvalProtocol.interactive === true` ⇒ the controller's swapped-in
 *     `onConfirm` DELEGATES to the surface confirm that was in the slot at
 *     `runWithProtocol` entry — no throw, no pending approval minted.
 *  2. An EXPLICIT `{decision:"allow", scope:"session"}` from the operator mints
 *     a STANDING session grant for that actionKey: later same-key confirms
 *     auto-allow without re-prompting. This is NOT the T03 H-1 leak (a silent
 *     single-approval auto-granting later turns): the standing grant requires
 *     the operator to pick the *session* verb explicitly; a plain allow (or
 *     scope:"once") stays single-shot.
 *  3. Session grants are actionKey-scoped (shell-aware): `bash|ls` never
 *     unlocks `bash|rm -rf /`. A SHELL_EXTRACT_FAILED key NEVER mints a grant
 *     (fail closed).
 *  4. `interactive` absent/false ⇒ byte-identical legacy deferred behavior
 *     (throw + pending minted) — web/SDK/headless surfaces unchanged.
 *  5. A lease minted via `resolveApproval` (the deferred/escalation path) is
 *     still claimed FIRST — the surface is not re-prompted for a leased re-run.
 */

const makeRegistry = (shellFor: (tool: string, input: unknown) => string | null) =>
  ({
    extractShellCommand: (tool: string, input: unknown) => shellFor(tool, input),
  }) as unknown as Parameters<
    typeof approvalTesting.createRuntimeApprovalProtocolController
  >[0]["registry"]

type SurfaceConfirm = (a: ToolAction) => Promise<unknown>

const makeBase = (
  registry: ReturnType<typeof makeRegistry>,
  opts: { interactive?: boolean; surface?: SurfaceConfirm } = {},
) => {
  const confirmSlot: { current: SurfaceConfirm | undefined } = {
    current: opts.surface ?? (async () => true),
  }
  return {
    base: {
      registry,
      approvalProtocol: {
        confirmSlot,
        ...(opts.interactive !== undefined ? { interactive: opts.interactive } : {}),
      },
    } as unknown as Parameters<typeof approvalTesting.createRuntimeApprovalProtocolController>[0],
    confirmSlot,
  }
}

const action = (tool: string, input: unknown = {}): ToolAction => ({
  tool,
  input,
  isReadOnly: false,
})

describe("inline-interactive — delegation instead of throw", () => {
  test("interactive:true ⇒ onConfirm delegates to the entry surface confirm (no throw, no pending)", async () => {
    const registry = makeRegistry(() => null)
    const surfaceCalls: ToolAction[] = []
    const surface: SurfaceConfirm = async (a) => {
      surfaceCalls.push(a)
      return true
    }
    const { base } = makeBase(registry, { interactive: true, surface })
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    const result = await ctrl.runWithProtocol(async () => await ctrl.onConfirm(action("edit")))

    expect(result).toBe(true)
    expect(surfaceCalls.length).toBe(1)
    expect(surfaceCalls[0]?.tool).toBe("edit")
    expect(ctrl.__pendingSize()).toBe(0)
  })

  test("rich decisions pass through VERBATIM (deny_and_steer reaches the gate untouched)", async () => {
    const registry = makeRegistry(() => null)
    const steer = { decision: "deny_and_steer", steer: "use scripted_replace instead" }
    const { base } = makeBase(registry, { interactive: true, surface: async () => steer })
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    const result = await ctrl.runWithProtocol(async () => await ctrl.onConfirm(action("edit")))
    expect(result).toBe(steer)
  })

  test("interactive absent ⇒ byte-identical legacy: throws RuntimeApprovalRequiredError + mints pending", async () => {
    const registry = makeRegistry(() => null)
    const { base } = makeBase(registry, {}) // no interactive flag
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    let thrown: unknown
    await ctrl.runWithProtocol(async () => {
      try {
        await ctrl.onConfirm(action("edit"))
      } catch (e) {
        thrown = e
      }
    })
    expect((thrown as { name?: string })?.name).toBe("RuntimeApprovalRequiredError")
  })

  test("outside any runWithProtocol scope an interactive controller still fails CLOSED (throws)", async () => {
    // No scope ⇒ no captured surface ⇒ the deferred path is the only safe
    // answer (there is no operator prompt bound to this call site).
    const registry = makeRegistry(() => null)
    const { base } = makeBase(registry, { interactive: true })
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)
    expect(ctrl.onConfirm(action("edit"))).rejects.toThrow(/runtime approval required/)
  })
})

describe("inline-interactive — explicit session grant (operator 'always' verb)", () => {
  test("allow scope:'session' mints a STANDING grant: later same-key confirms skip the surface", async () => {
    const registry = makeRegistry(() => null)
    let surfaceCalls = 0
    const surface: SurfaceConfirm = async () => {
      surfaceCalls += 1
      return { decision: "allow", scope: "session" }
    }
    const { base } = makeBase(registry, { interactive: true, surface })
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    const first = await ctrl.runWithProtocol(async () => await ctrl.onConfirm(action("agent")))
    expect(surfaceCalls).toBe(1)
    expect((first as { decision?: string })?.decision).toBe("allow")

    // LATER TURN (fresh scope): same actionKey ⇒ standing grant, no re-prompt.
    const second = await ctrl.runWithProtocol(async () => await ctrl.onConfirm(action("agent")))
    expect(surfaceCalls).toBe(1) // surface NOT called again
    expect(second === true || (second as { decision?: string })?.decision === "allow").toBe(true)
  })

  test("plain allow (no scope / scope:'once') does NOT mint a standing grant — re-prompts next turn", async () => {
    const registry = makeRegistry(() => null)
    let surfaceCalls = 0
    const answers: unknown[] = [true, { decision: "allow", scope: "once" }, true]
    const surface: SurfaceConfirm = async () => {
      surfaceCalls += 1
      return answers[surfaceCalls - 1]
    }
    const { base } = makeBase(registry, { interactive: true, surface })
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    await ctrl.runWithProtocol(async () => await ctrl.onConfirm(action("edit")))
    await ctrl.runWithProtocol(async () => await ctrl.onConfirm(action("edit")))
    await ctrl.runWithProtocol(async () => await ctrl.onConfirm(action("edit")))
    expect(surfaceCalls).toBe(3) // every turn re-prompted
  })

  test("session grant is SHELL-AWARE: bash|ls grant never unlocks bash|rm", async () => {
    const registry = makeRegistry((_tool, input) => (input as { command: string }).command)
    const prompts: string[] = []
    const surface: SurfaceConfirm = async (a) => {
      prompts.push((a.input as { command: string }).command)
      return { decision: "allow", scope: "session" }
    }
    const { base } = makeBase(registry, { interactive: true, surface })
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    await ctrl.runWithProtocol(async () => await ctrl.onConfirm(action("bash", { command: "ls" })))
    await ctrl.runWithProtocol(async () =>
      ctrl.onConfirm(action("bash", { command: "rm -rf /tmp/x" })),
    )
    // The second, DIFFERENT command re-prompted (grant did not widen).
    expect(prompts).toEqual(["ls", "rm -rf /tmp/x"])
  })

  test("SHELL_EXTRACT_FAILED actionKey NEVER mints a grant (fail closed — always re-prompts)", async () => {
    const registry = makeRegistry(() => {
      throw new Error("extractor blew up")
    })
    let surfaceCalls = 0
    const surface: SurfaceConfirm = async () => {
      surfaceCalls += 1
      return { decision: "allow", scope: "session" }
    }
    const { base } = makeBase(registry, { interactive: true, surface })
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    await ctrl.runWithProtocol(async () => await ctrl.onConfirm(action("bash", { command: "x" })))
    await ctrl.runWithProtocol(async () => await ctrl.onConfirm(action("bash", { command: "x" })))
    expect(surfaceCalls).toBe(2)
  })
})

describe("inline-interactive — concurrent confirms serialize (one operator, one question)", () => {
  test("two CONCURRENT same-key confirms: one prompt; the queued one reuses the just-minted session grant", async () => {
    // The parallel `agent` fan-out shape: N early-dispatched calls hit the gate
    // concurrently. The operator answers the FIRST with the session verb; the
    // queued sibling must observe that grant INSIDE the serialized section and
    // auto-allow — never a second prompt, never a lost/auto-denied question.
    const registry = makeRegistry(() => null)
    let surfaceCalls = 0
    let release: (() => void) | undefined
    const gateOpen = new Promise<void>((r) => {
      release = r
    })
    const surface: SurfaceConfirm = async () => {
      surfaceCalls += 1
      await gateOpen // hold the prompt "open" while the sibling queues behind it
      return { decision: "allow", scope: "session" }
    }
    const { base } = makeBase(registry, { interactive: true, surface })
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    const results = await ctrl.runWithProtocol(async () => {
      const first = ctrl.onConfirm(action("agent", { prompt: "a" }))
      const second = ctrl.onConfirm(action("agent", { prompt: "b" }))
      await Promise.resolve()
      release?.()
      return await Promise.all([first, second])
    })
    expect(surfaceCalls).toBe(1) // exactly ONE question for the whole fan-out
    const allowed = (r: unknown): boolean =>
      r === true || (r as { decision?: string })?.decision === "allow"
    expect(results.every(allowed)).toBe(true)
  })

  test("two CONCURRENT different-key confirms: both prompted, strictly one at a time", async () => {
    const registry = makeRegistry(() => null)
    let inFlight = 0
    let maxInFlight = 0
    let prompts = 0
    const surface: SurfaceConfirm = async () => {
      prompts += 1
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return true
    }
    const { base } = makeBase(registry, { interactive: true, surface })
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    await ctrl.runWithProtocol(async () => {
      await Promise.all([ctrl.onConfirm(action("edit")), ctrl.onConfirm(action("bash"))])
    })
    expect(prompts).toBe(2)
    expect(maxInFlight).toBe(1) // never two questions on screen at once
  })
})

describe("deferred protocol — explicit session grant via resolveApproval (web 'always' verb)", () => {
  /** Mint a pending approval through the deferred throw path and return its id. */
  const mintPending = async (
    ctrl: ReturnType<typeof approvalTesting.createRuntimeApprovalProtocolController>,
    a: ToolAction,
  ): Promise<string> => {
    let id: string | undefined
    await ctrl.runWithProtocol(async () => {
      try {
        await ctrl.onConfirm(a)
      } catch (e) {
        id = (e as { approval: { approvalId: string } }).approval.approvalId
      }
    })
    if (id === undefined) throw new Error("no approval minted")
    return id
  }

  test("approve with scope:'session' ⇒ standing grant: a LATER turn's same-key ask auto-allows", async () => {
    const registry = makeRegistry(() => null)
    const { base } = makeBase(registry, {}) // non-interactive (web/SDK shape)
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    const id = await mintPending(ctrl, action("edit"))
    ctrl.resolveApproval(id, "approve", { scope: "session" })

    // Immediate re-run: the single-use lease admits (unchanged protocol).
    const rerun = await ctrl.runWithProtocol(async () => await ctrl.onConfirm(action("edit")))
    expect(rerun === true || (rerun as { decision?: string })?.decision === "allow").toBe(true)

    // LATER turn — same actionKey: the standing grant admits WITHOUT a fresh
    // pending approval (no throw). This is what makes the web card's "always"
    // verb meaningful: one approval round-trip for the whole session, instead
    // of one full turn re-run PER ask.
    const later = await ctrl.runWithProtocol(async () => await ctrl.onConfirm(action("edit")))
    expect(later).toBe(true)
    expect(ctrl.__pendingSize()).toBe(0)
  })

  test("PAIRED CONTROL — plain approve (no scope) stays single-use: a later turn re-throws (T03)", async () => {
    const registry = makeRegistry(() => null)
    const { base } = makeBase(registry, {})
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    const id = await mintPending(ctrl, action("edit"))
    ctrl.resolveApproval(id, "approve")
    await ctrl.runWithProtocol(async () => await ctrl.onConfirm(action("edit"))) // lease consumed

    let rethrew = false
    await ctrl.runWithProtocol(async () => {
      try {
        await ctrl.onConfirm(action("edit"))
      } catch {
        rethrew = true
      }
    })
    expect(rethrew).toBe(true)
  })

  test("SHELL_EXTRACT_FAILED approval NEVER mints a grant even with scope:'session' (fail closed)", async () => {
    const registry = makeRegistry(() => {
      throw new Error("extractor blew up")
    })
    const { base } = makeBase(registry, {})
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    const id = await mintPending(ctrl, action("bash", { command: "x" }))
    ctrl.resolveApproval(id, "approve", { scope: "session" })

    // A failed-extraction key can never match a lease NOR a grant — the later
    // ask must re-mint a fresh pending approval (fail closed, always re-ask).
    let rethrew = false
    await ctrl.runWithProtocol(async () => {
      try {
        await ctrl.onConfirm(action("bash", { command: "x" }))
      } catch {
        rethrew = true
      }
    })
    expect(rethrew).toBe(true)
  })

  test("an ESCALATION approve scope:'session' does NOT mint a TOOL-level standing grant (skill axis only)", async () => {
    // Widening a skill scope for the session is the skill-scope machinery's
    // job (the lease carries the rich decision). It must not silently double
    // as a tool-level "never ask again" — that would let one skill escalation
    // unlock the tool for every later NON-skill context.
    const registry = makeRegistry(() => null)
    const { base } = makeBase(registry, {})
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    const escalated = {
      ...action("edit"),
      scopeContext: { activeSkill: "deploy", reason: "out of scope" },
    } as ToolAction
    const id = await mintPending(ctrl, escalated)
    ctrl.resolveApproval(id, "approve", { scope: "session" })
    // Consume the escalation lease in the immediate re-run.
    await ctrl.runWithProtocol(async () => await ctrl.onConfirm(escalated))

    // LATER turn, PLAIN (non-escalation) ask on the same tool: must re-ask.
    let rethrew = false
    await ctrl.runWithProtocol(async () => {
      try {
        await ctrl.onConfirm(action("edit"))
      } catch {
        rethrew = true
      }
    })
    expect(rethrew).toBe(true)
  })
})

describe("inline-interactive — lease precedence preserved", () => {
  test("a resolveApproval-minted lease is claimed FIRST: the surface is not prompted for the leased re-run", async () => {
    const registry = makeRegistry(() => null)
    let surfaceCalls = 0
    const surface: SurfaceConfirm = async () => {
      surfaceCalls += 1
      return true
    }
    // Deferred mint first (non-interactive shape inside THIS scope is simulated
    // by a direct pending mint via the legacy path: interactive controller with
    // NO active scope throws + mints).
    const { base } = makeBase(registry, { interactive: true, surface })
    const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

    let mintedId: string | undefined
    try {
      await ctrl.onConfirm(action("edit")) // no scope ⇒ deferred throw + mint
    } catch (e) {
      mintedId = (e as { approval: { approvalId: string } }).approval.approvalId
    }
    expect(mintedId).toBeDefined()
    ctrl.resolveApproval(mintedId as string, "approve")

    // The leased re-run claims the lease — surface must NOT be prompted.
    const result = await ctrl.runWithProtocol(async () => await ctrl.onConfirm(action("edit")))
    expect(result).toBe(true)
    expect(surfaceCalls).toBe(0)
  })
})
