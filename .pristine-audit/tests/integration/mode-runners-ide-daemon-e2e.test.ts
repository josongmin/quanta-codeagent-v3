/**
 * ADR-0092 (C1) — run-mode-expansion-ide-daemon, L4 promotion battery.
 *
 * Drives the FULL `runMode(ide)` and `runMode(daemon)` end-to-end through
 * `assembleAgentConfig` + `runAgent` (via the real seam-resolved runner,
 * not the per-mode unit-test stub). Asserts:
 *
 *   Preset binding (config assembly):
 *     - modePolicy fields match the canonical IDE / DAEMON lever vector
 *       (permission/termination/sandbox/output/externalDeps/toolSurface/
 *       promptPack/memory/observation/network/gitWrite/secrets).
 *     - BudgetMeter dials match BUDGET_PRESETS[mode] post-clamp.
 *     - branch_search default-ON: IDE → N=3 tsc+lint worktree, DAEMON →
 *       N=3 tsc+lint+lsp_diag worktree.
 *     - maxTurns / cwd / permission default-fallback per spec.
 *
 *   Hellgate:
 *     - IDE preset with branchSearch missing on the request retains the
 *       runner-provided default (does not throw, does not produce a null
 *       branchSearch).
 *     - DAEMON preset second start with same sessionId is IDEMPOTENT — a
 *       second `runMode` invocation does NOT throw, produces the same
 *       lever vector + a FRESH BudgetMeter (per-task contract).
 *     - Cross-mode req mismatch is rejected (mode === "ide" runner cannot
 *       be called with req.mode === "daemon").
 *
 *   End-to-end:
 *     - Full `runMode(ide)` with an InMemoryStream + scripted LLM that
 *       finishes in one turn → AgentEvents recorded (session_start +
 *       assistant_text + done), exitCode 0.
 *     - Full `runMode(daemon)` ditto.
 *     - Both modes propagate the configured signal — aborting before the
 *       call completes produces an `aborted` outcome (exit 130).
 *     - Both modes carry sessionId through assembly so persistent-memory
 *       hosts can correlate across runs.
 */
import { describe, expect, test } from "bun:test"
import type { AssembleRequest } from "@/../src/apps/agent/assemble"
import { runMode as runDaemonMode } from "@/../src/apps/agent/mode-presets/daemon"
import { runMode as runIdeMode } from "@/../src/apps/agent/mode-presets/ide"
import type { AgentConfig } from "@/agent"
import { BUDGET_PRESETS, MODE_PRESETS } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

// ─────────────────────────────────────────────────────────────────────────
// InMemoryStream — full event capture so e2e assertions can inspect the
// trajectory after the run completes. Mirrors RecordingStream used in
// `tests/integration/_harness.ts` but kept hermetic to this file.
// ─────────────────────────────────────────────────────────────────────────

class InMemoryStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
  /** True when at least one event of `type` was emitted. */
  hasType(type: AgentEvent["type"]): boolean {
    return this.events.some((e) => e.type === type)
  }
  /** First event of `type`, or undefined if none. */
  firstOfType(type: AgentEvent["type"]): AgentEvent | undefined {
    return this.events.find((e) => e.type === type)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Scripted LLM that completes in one turn — enough for the runAgent loop
// to emit session_start + turn_start + llm_request + assistant_text + done.
// ─────────────────────────────────────────────────────────────────────────

class OneTurnLLM implements LLMPort {
  readonly model = "test-one-turn"
  readonly seenInputs: StreamInput[] = []
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.seenInputs.push(input)
    yield { type: "text_delta", delta: "done." }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Request builder
// ─────────────────────────────────────────────────────────────────────────

const baseReq = (
  mode: "ide" | "daemon",
  over: Partial<AssembleRequest["base"]> = {},
): AssembleRequest => ({
  mode,
  base: {
    llm: new OneTurnLLM(),
    registry: new ToolRegistry(defaultTools),
    stream: new InMemoryStream(),
    permission:
      mode === "ide"
        ? ({ mode: "default" } as PermissionContext)
        : ({ mode: "acceptEdits" } as PermissionContext),
    messages: [{ role: "user", content: [{ type: "text", text: "fix the typo" }] }] as Message[],
    system: "test-system",
    cwd: "/tmp",
    maxTurns: 5,
    signal: new AbortController().signal,
    onConfirm: async () => false,
    ...over,
  },
})

// ─────────────────────────────────────────────────────────────────────────
// (1) Preset binding — IDE
// ─────────────────────────────────────────────────────────────────────────

describe("ide.runMode — full lever-vector binding (e2e)", () => {
  test("modePolicy carries the canonical IDE lever vector (all 12)", async () => {
    let seen: AgentConfig | undefined
    await runIdeMode({
      ...baseReq("ide"),
      seams: {
        runAgent: async (cfg) => {
          seen = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    const policy = seen?.modePolicy
    expect(policy?.mode).toBe("ide")
    expect(policy?.permission.kind).toBe("reviewer-backed")
    expect(policy?.termination.kind).toBe("user-stop")
    expect(policy?.sandbox.kind).toBe("user-cwd")
    expect(policy?.output.kind).toBe("structured")
    expect(policy?.externalDeps.kind).toBe("host")
    expect(policy?.toolSurface.kind).toBe("full")
    expect(policy?.promptPack.kind).toBe("assistant")
    expect(policy?.memory.kind).toBe("persistent")
    expect(policy?.observation.kind).toBe("full-trajectory")
    expect(policy?.network.kind).toBe("open")
    expect(policy?.gitWrite.kind).toBe("free")
    expect(policy?.secrets.kind).toBe("host-env")
  })

  test("BudgetMeter dials match BUDGET_PRESETS.ide post-clamp", async () => {
    let seen: AgentConfig | undefined
    await runIdeMode({
      ...baseReq("ide"),
      seams: {
        runAgent: async (cfg) => {
          seen = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    const dials = seen?.budgetMeter?.dials
    expect(dials).toBeDefined()
    expect(dials?.maxTurns).toBe(BUDGET_PRESETS.ide.maxTurns)
    expect(dials?.maxRetries).toBe(BUDGET_PRESETS.ide.maxRetries)
    expect(dials?.maxConsecutiveFailures).toBe(BUDGET_PRESETS.ide.maxConsecutiveFailures)
  })

  test("branch_search default-ON: N=3, tsc+lint, worktree, 60s/branch", async () => {
    let seen: AgentConfig | undefined
    await runIdeMode({
      ...baseReq("ide"),
      seams: {
        runAgent: async (cfg) => {
          seen = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    expect(seen?.branchSearch).toBeDefined()
    expect(seen?.branchSearch?.defaultN).toBe(3)
    expect(seen?.branchSearch?.defaultVerifierKinds).toEqual(["tsc", "lint"])
    expect(seen?.branchSearch?.isolation).toBe("worktree")
    expect(seen?.branchSearch?.timeoutPerBranchMs).toBe(60_000)
  })

  test("MODE_PRESETS.ide cell matches the assembler's bound policy (no drift)", async () => {
    let seen: AgentConfig | undefined
    await runIdeMode({
      ...baseReq("ide"),
      seams: {
        runAgent: async (cfg) => {
          seen = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    // Lever-vector equality — protects against assembler / preset drift.
    expect(seen?.modePolicy).toEqual(MODE_PRESETS.ide)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// (2) Preset binding — DAEMON
// ─────────────────────────────────────────────────────────────────────────

describe("daemon.runMode — full lever-vector binding (e2e)", () => {
  test("modePolicy carries the canonical DAEMON lever vector (all 12)", async () => {
    let seen: AgentConfig | undefined
    await runDaemonMode({
      ...baseReq("daemon"),
      seams: {
        runAgent: async (cfg) => {
          seen = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    const policy = seen?.modePolicy
    expect(policy?.mode).toBe("daemon")
    expect(policy?.permission.kind).toBe("auto")
    expect(policy?.termination.kind).toBe("diff-ready")
    expect(policy?.sandbox.kind).toBe("per-instance")
    expect(policy?.output.kind).toBe("structured")
    expect(policy?.externalDeps.kind).toBe("hermetic-with-overrides")
    expect(policy?.toolSurface.kind).toBe("headless-safe")
    expect(policy?.promptPack.kind).toBe("task-runner")
    expect(policy?.memory.kind).toBe("persistent")
    expect(policy?.observation.kind).toBe("full-trajectory")
    expect(policy?.network.kind).toBe("allowlist")
    expect(policy?.gitWrite.kind).toBe("branch-only")
    expect(policy?.secrets.kind).toBe("scoped")
  })

  test("BudgetMeter dials match BUDGET_PRESETS.daemon post-clamp", async () => {
    let seen: AgentConfig | undefined
    await runDaemonMode({
      ...baseReq("daemon"),
      seams: {
        runAgent: async (cfg) => {
          seen = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    const dials = seen?.budgetMeter?.dials
    expect(dials).toBeDefined()
    expect(dials?.maxTurns).toBe(BUDGET_PRESETS.daemon.maxTurns)
    expect(dials?.maxWallClockMs).toBe(BUDGET_PRESETS.daemon.maxWallClockMs)
    expect(dials?.maxCostUsd).toBe(BUDGET_PRESETS.daemon.maxCostUsd)
    expect(dials?.maxModelCalls).toBe(BUDGET_PRESETS.daemon.maxModelCalls)
  })

  test("branch_search default-ON: N=3, tsc+lint+lsp_diag, worktree, 90s/branch", async () => {
    let seen: AgentConfig | undefined
    await runDaemonMode({
      ...baseReq("daemon"),
      seams: {
        runAgent: async (cfg) => {
          seen = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    expect(seen?.branchSearch).toBeDefined()
    expect(seen?.branchSearch?.defaultN).toBe(3)
    expect(seen?.branchSearch?.defaultVerifierKinds).toEqual(["tsc", "lint", "lsp_diag"])
    expect(seen?.branchSearch?.isolation).toBe("worktree")
    expect(seen?.branchSearch?.timeoutPerBranchMs).toBe(90_000)
  })

  test("MODE_PRESETS.daemon cell matches the assembler's bound policy (no drift)", async () => {
    let seen: AgentConfig | undefined
    await runDaemonMode({
      ...baseReq("daemon"),
      seams: {
        runAgent: async (cfg) => {
          seen = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    expect(seen?.modePolicy).toEqual(MODE_PRESETS.daemon)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// (3) Hellgate
// ─────────────────────────────────────────────────────────────────────────

describe("mode-runner hellgate — guards & idempotency", () => {
  test("IDE preset with branchSearch missing on request ⇒ runner default applied (no throw, no null)", async () => {
    let seen: AgentConfig | undefined
    const req = baseReq("ide")
    // Strip branchSearch to confirm the runner injects its default.
    expect("branchSearch" in req.base).toBe(false) // canary
    const out = await runIdeMode({
      ...req,
      seams: {
        runAgent: async (cfg) => {
          seen = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    expect(out.exitCode).toBe(0)
    expect(seen?.branchSearch).toBeDefined()
    expect(seen?.branchSearch?.defaultN).toBe(3)
  })

  test("DAEMON preset second start with the same sessionId is idempotent (no throw, fresh BudgetMeter)", async () => {
    const sessionId = "daemon-cron-abc-123"
    const seenCfgs: AgentConfig[] = []
    const seams = {
      runAgent: async (cfg: AgentConfig) => {
        seenCfgs.push(cfg)
        return { reason: "completed" as const, turns: 0, messages: [] }
      },
    }
    const r1 = await runDaemonMode({
      ...baseReq("daemon", { sessionId }),
      seams,
    })
    const r2 = await runDaemonMode({
      ...baseReq("daemon", { sessionId }),
      seams,
    })
    expect(r1.exitCode).toBe(0)
    expect(r2.exitCode).toBe(0)
    expect(seenCfgs.length).toBe(2)
    // sessionId carried through both assemblies (host correlation).
    expect(seenCfgs[0]?.sessionId).toBe(sessionId)
    expect(seenCfgs[1]?.sessionId).toBe(sessionId)
    // Lever vector identical (no per-call drift).
    expect(seenCfgs[0]?.modePolicy).toEqual(seenCfgs[1]?.modePolicy)
    // BudgetMeter is a fresh instance each call (per-task contract).
    expect(seenCfgs[0]?.budgetMeter).not.toBe(seenCfgs[1]?.budgetMeter)
  })

  test("IDE preset second start with the same sessionId is idempotent (lever vector stable)", async () => {
    const sessionId = "ide-resume-xyz"
    const seenCfgs: AgentConfig[] = []
    const seams = {
      runAgent: async (cfg: AgentConfig) => {
        seenCfgs.push(cfg)
        return { reason: "completed" as const, turns: 0, messages: [] }
      },
    }
    await runIdeMode({ ...baseReq("ide", { sessionId }), seams })
    await runIdeMode({ ...baseReq("ide", { sessionId }), seams })
    expect(seenCfgs.length).toBe(2)
    expect(seenCfgs[0]?.modePolicy).toEqual(seenCfgs[1]?.modePolicy)
  })

  test("ide.runMode rejects req.mode='daemon' with a clear error", async () => {
    const req = { ...baseReq("ide"), mode: "daemon" as const }
    await expect(runIdeMode(req)).rejects.toThrow(/req\.mode must be "ide"/)
  })

  test("daemon.runMode rejects req.mode='ide' with a clear error", async () => {
    const req = { ...baseReq("daemon"), mode: "ide" as const }
    await expect(runDaemonMode(req)).rejects.toThrow(/req\.mode must be "daemon"/)
  })

  test("ide.runMode rejects req.mode='batch' (cross-cell mismatch)", async () => {
    const req = { ...baseReq("ide"), mode: "batch" as const }
    await expect(runIdeMode(req)).rejects.toThrow(/req\.mode must be "ide"/)
  })

  test("daemon.runMode rejects req.mode='ci-bot' (cross-cell mismatch — both branch-only modes, still rejected)", async () => {
    const req = { ...baseReq("daemon"), mode: "ci-bot" as const }
    await expect(runDaemonMode(req)).rejects.toThrow(/req\.mode must be "daemon"/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// (4) End-to-end through the REAL runAgent loop with InMemoryStream
// ─────────────────────────────────────────────────────────────────────────

describe("mode-runner end-to-end through real runAgent + InMemoryStream", () => {
  test("ide.runMode full flow → InMemoryStream sees session_start + assistant_text + done", async () => {
    const stream = new InMemoryStream()
    const llm = new OneTurnLLM()
    const out = await runIdeMode(baseReq("ide", { llm, stream }))
    expect(out.exitCode).toBe(0)
    expect(out.outcome?.reason).toBe("completed")
    expect(stream.events.length).toBeGreaterThan(0)
    expect(stream.hasType("session_start")).toBe(true)
    expect(stream.hasType("turn_start")).toBe(true)
    expect(stream.hasType("assistant_text")).toBe(true)
    expect(stream.hasType("done")).toBe(true)
    // The LLM saw EXACTLY one stream() call (single-turn completion).
    expect(llm.seenInputs.length).toBe(1)
    // The user message we seeded landed in the LLM's input.
    const messages = llm.seenInputs[0]?.messages ?? []
    const userTexts = messages
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text))
    expect(userTexts.some((t) => t.includes("fix the typo"))).toBe(true)
  })

  test("daemon.runMode full flow → InMemoryStream sees session_start + assistant_text + done", async () => {
    const stream = new InMemoryStream()
    const llm = new OneTurnLLM()
    const out = await runDaemonMode(baseReq("daemon", { llm, stream }))
    expect(out.exitCode).toBe(0)
    expect(out.outcome?.reason).toBe("completed")
    expect(stream.events.length).toBeGreaterThan(0)
    expect(stream.hasType("session_start")).toBe(true)
    expect(stream.hasType("turn_start")).toBe(true)
    expect(stream.hasType("assistant_text")).toBe(true)
    expect(stream.hasType("done")).toBe(true)
    expect(llm.seenInputs.length).toBe(1)
  })

  test("ide.runMode propagates a pre-aborted signal → outcome.reason=aborted, exit 130", async () => {
    // Pre-abort the signal so the loop's turn-1 guard (signal.aborted check
    // at line 1449 of loop.ts) immediately returns the aborted outcome.
    // This is the contract that matters for daemon retry / IDE cancel — the
    // host signals abort and the runner exits clean with code 130 (SIGINT
    // convention 128 + 2).
    const controller = new AbortController()
    controller.abort()
    const stream = new InMemoryStream()
    const llm = new OneTurnLLM() // never reached
    const out = await runIdeMode(baseReq("ide", { llm, stream, signal: controller.signal }))
    expect(out.exitCode).toBe(130)
    expect(out.outcome?.reason).toBe("aborted")
  })

  test("daemon.runMode propagates a pre-aborted signal → outcome.reason=aborted, exit 130", async () => {
    const controller = new AbortController()
    controller.abort()
    const stream = new InMemoryStream()
    const llm = new OneTurnLLM()
    const out = await runDaemonMode(baseReq("daemon", { llm, stream, signal: controller.signal }))
    expect(out.exitCode).toBe(130)
    expect(out.outcome?.reason).toBe("aborted")
  })

  test("ide.runMode default maxTurns = 200 (interactive-class budget)", async () => {
    let seen: AgentConfig | undefined
    const req = baseReq("ide")
    // Strip the test default so the runner's default applies.
    delete (req.base as { maxTurns?: number }).maxTurns
    await runIdeMode({
      ...req,
      seams: {
        runAgent: async (cfg) => {
          seen = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    expect(seen?.maxTurns).toBe(200)
  })

  test("daemon.runMode default maxTurns = 40 (cron-bounded budget)", async () => {
    let seen: AgentConfig | undefined
    const req = baseReq("daemon")
    delete (req.base as { maxTurns?: number }).maxTurns
    await runDaemonMode({
      ...req,
      seams: {
        runAgent: async (cfg) => {
          seen = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    expect(seen?.maxTurns).toBe(40)
  })

  test("ide.runMode default permission = { mode: 'default' } (reviewer-backed lever)", async () => {
    let seen: AgentConfig | undefined
    const req = baseReq("ide")
    delete (req.base as { permission?: PermissionContext }).permission
    await runIdeMode({
      ...req,
      seams: {
        runAgent: async (cfg) => {
          seen = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    expect(seen?.permission?.mode).toBe("default")
  })

  test("daemon.runMode default permission = { mode: 'acceptEdits' } (no human)", async () => {
    let seen: AgentConfig | undefined
    const req = baseReq("daemon")
    delete (req.base as { permission?: PermissionContext }).permission
    await runDaemonMode({
      ...req,
      seams: {
        runAgent: async (cfg) => {
          seen = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    expect(seen?.permission?.mode).toBe("acceptEdits")
  })

  test("ide.runMode + daemon.runMode produce DIFFERENT lever vectors (matrix integrity)", async () => {
    let ideCfg: AgentConfig | undefined
    let daemonCfg: AgentConfig | undefined
    await runIdeMode({
      ...baseReq("ide"),
      seams: {
        runAgent: async (cfg) => {
          ideCfg = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    await runDaemonMode({
      ...baseReq("daemon"),
      seams: {
        runAgent: async (cfg) => {
          daemonCfg = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    // Each row differs at at least one of: permission, termination, sandbox,
    // externalDeps, toolSurface, promptPack, observation, network, gitWrite,
    // secrets. (Output is the same: both `structured`.)
    expect(ideCfg?.modePolicy?.permission.kind).not.toBe(daemonCfg?.modePolicy?.permission.kind)
    expect(ideCfg?.modePolicy?.sandbox.kind).not.toBe(daemonCfg?.modePolicy?.sandbox.kind)
    expect(ideCfg?.modePolicy?.network.kind).not.toBe(daemonCfg?.modePolicy?.network.kind)
    expect(ideCfg?.modePolicy?.gitWrite.kind).not.toBe(daemonCfg?.modePolicy?.gitWrite.kind)
    expect(ideCfg?.modePolicy?.toolSurface.kind).not.toBe(daemonCfg?.modePolicy?.toolSurface.kind)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// (5) Caller-override semantics
// ─────────────────────────────────────────────────────────────────────────

describe("mode-runner caller overrides", () => {
  test("IDE: caller-supplied branchSearch is preserved (runner default does NOT override)", async () => {
    let seen: AgentConfig | undefined
    const override = {
      defaultN: 7,
      defaultVerifierKinds: ["tsc"] as const,
      timeoutPerBranchMs: 1000,
      isolation: "tmpdir" as const,
    }
    await runIdeMode({
      ...baseReq("ide", { branchSearch: override }),
      seams: {
        runAgent: async (cfg) => {
          seen = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    expect(seen?.branchSearch?.defaultN).toBe(7)
    expect(seen?.branchSearch?.defaultVerifierKinds).toEqual(["tsc"])
    expect(seen?.branchSearch?.isolation).toBe("tmpdir")
  })

  test("DAEMON: caller-supplied branchSearch is preserved (runner default does NOT override)", async () => {
    let seen: AgentConfig | undefined
    const override = {
      defaultN: 5,
      defaultVerifierKinds: ["lint"] as const,
      timeoutPerBranchMs: 2000,
      isolation: "worktree" as const,
    }
    await runDaemonMode({
      ...baseReq("daemon", { branchSearch: override }),
      seams: {
        runAgent: async (cfg) => {
          seen = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    expect(seen?.branchSearch?.defaultN).toBe(5)
    expect(seen?.branchSearch?.defaultVerifierKinds).toEqual(["lint"])
  })

  test("IDE: caller-supplied dials are merged over BUDGET_PRESETS.ide (operator override semantics)", async () => {
    let seen: AgentConfig | undefined
    await runIdeMode({
      ...baseReq("ide"),
      dials: { maxTurns: 11 },
      seams: {
        runAgent: async (cfg) => {
          seen = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    expect(seen?.budgetMeter?.dials?.maxTurns).toBe(11)
    // Preset dials NOT overridden by the caller stay at their preset value.
    expect(seen?.budgetMeter?.dials?.maxRetries).toBe(BUDGET_PRESETS.ide.maxRetries)
  })

  test("DAEMON: caller-supplied dials are merged over BUDGET_PRESETS.daemon", async () => {
    let seen: AgentConfig | undefined
    await runDaemonMode({
      ...baseReq("daemon"),
      dials: { maxTurns: 7, maxCostUsd: 0.5 },
      seams: {
        runAgent: async (cfg) => {
          seen = cfg
          return { reason: "completed", turns: 0, messages: [] }
        },
      },
    })
    expect(seen?.budgetMeter?.dials?.maxTurns).toBe(7)
    expect(seen?.budgetMeter?.dials?.maxCostUsd).toBe(0.5)
    // Preset wallClock NOT overridden — preserved.
    expect(seen?.budgetMeter?.dials?.maxWallClockMs).toBe(BUDGET_PRESETS.daemon.maxWallClockMs)
  })
})
