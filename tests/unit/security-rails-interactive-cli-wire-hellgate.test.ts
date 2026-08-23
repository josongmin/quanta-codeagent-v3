/**
 * ★ HELLGATE — SECURITY RAILS on the PRIMARY INTERACTIVE CLI (composition
 *   BEHAVIOR, not "port exists").
 *
 * PINNED BUG: two jun-6 anti-exfil / authority rails were wired for the host
 * assembler (apps/agent presets + SDK) but DARK on the interactive `quanta`
 * REPL, which builds its per-turn config through the runtime-context OVERLAY —
 * NOT `assembleProductionConfig`. So on interactive `quanta`:
 *   - `QUANTA_WRITE_BUDGET=1` gave ZERO protection (no `cfg.writeBudget` ⇒ the
 *     dispatch chokepoint never binds a counter ⇒ unbounded writes), and
 *   - `QUANTA_SANDBOX_ESCALATION=1` never installed the bash escalation handler.
 *
 * FIX: a narrow shared OWNER (`@/host/runtime/security-rails-wire`,
 * `wireSecurityRails` / `wireSecurityRailsForOverlay`) both the assembler AND the
 * interactive-CLI compose route through. The CLI compose calls
 * `wireSecurityRailsForOverlay(runtimeConfigFromEnv(env), { permissionStore,
 * onConfirm })`, threads the returned `writeBudget` onto its overlay (→ base →
 * per-turn AgentConfig), and the escalation handler installs as a side-effect.
 *
 * THIS BATTERY asserts the ACTUAL deny/confirm behavior end-to-end through the
 * SAME functions the interactive CLI compose invokes:
 *   1. write-budget — the value the CLI threads onto its overlay, carried on the
 *      base and built into the CLI's per-turn `AgentConfig` (the REAL
 *      no-turnAssembler `buildAgentConfigFromBase` path), makes the REAL
 *      `buildToolContext` bind a turn counter so the (N+1)th REAL `writeTool`
 *      dispatch is DENIED.
 *   2. sandbox-escalation — the handler the SAME call installs fires the injected
 *      `onConfirm` on a sandboxed nonzero exit (approve ⇒ re-run unsandboxed;
 *      deny ⇒ stays blocked) through the REAL `bashTool`.
 *   3. overlay→base LIFT — `buildBaseFromBootstrap` (the REAL CLI base builder)
 *      carries `overlay.writeBudget` onto the base so the chain is unbroken.
 *
 * aug-23 — BOTH rails are now per-SESSION `AgentConfig` slots (the escalation
 * handler stopped being a module-global; it is minted once per session and
 * projected onto `ToolContext.sandboxEscalation` per turn). So
 * `wireSecurityRailsForOverlay` must RETURN both slots and the compose must
 * thread both onto the overlay — a dropped slot is a DARK rail with no global
 * back channel to save it. The source-regression guards below pin both.
 *
 * RED-ON-INJECTION (proof the assertions are load-bearing, not vacuous):
 *   - write-budget: SKIP the `wireSecurityRailsForOverlay` call (the removed CLI
 *     wire) ⇒ overlay `writeBudget` undefined ⇒ config carries no budget ⇒ the
 *     dispatch counter never binds ⇒ the (N+1)th write is `ok` again (RED).
 *   - escalation: the SAME skip ⇒ no handler installed ⇒ a sandboxed failure
 *     surfaces as a plain blocked result, onConfirm never consulted (RED).
 *   - a SOURCE regression guard that the CLI compose actually CALLS
 *     `wireSecurityRailsForOverlay` and threads its `writeBudget` onto the overlay
 *     (deleting the call site is the exact dark-rail bug this fix closes).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ConfirmDecision } from "@/agent"
import { buildToolContext } from "@/agent/dispatch/tool-context"
import { resolveCollaborationMode } from "@/agent/mode"
import type { AgentConfig } from "@/agent/types"
import { buildAgentConfigFromBase } from "@/host/runtime/internal/context-binding/base"
import type { RuntimeBase } from "@/host/runtime/internal/context-binding/types"
import {
  type SecurityRailsSurfaceDeps,
  wireSecurityRailsForOverlay,
} from "@/host/runtime/security-rails-wire"
import {
  __resetDefaultPermissionStore,
  createPermissionStore,
  type PermissionStore,
  type ToolAction,
} from "@/permission"
import { __resetShellSandbox } from "@/runtime"
import type { PerCallSandboxAvailability, PerCallSandboxPort } from "@/runtime/os-sandbox"
import { __resetRuntimeConfig, runtimeConfigFromEnv } from "@/shared"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import { bashTool } from "@/tool/bash"
import { __setBashPerCallSandboxFactory } from "@/tool/bash/per-call-factory"
import { writeTool } from "@/tool/write"

const dir = mkdtempSync(join(tmpdir(), "sec-rails-cli-"))

let store: PermissionStore

beforeEach(async () => {
  __resetShellSandbox()
  __resetDefaultPermissionStore()
  __resetRuntimeConfig()
  store = createPermissionStore({ filePath: join(dir, "perm-state.json"), debounceMs: 0 })
  await store.load()
})

afterEach(() => {
  __resetShellSandbox()
  __setBashPerCallSandboxFactory(undefined)
  __resetDefaultPermissionStore()
  __resetRuntimeConfig()
})

// ── the ENV both interactive rails are driven by (knobs ON + caps) ──────────────
const RAILS_ON: Record<string, string> = {
  QUANTA_WRITE_BUDGET: "1",
  QUANTA_WRITE_BUDGET_MAX: "2",
  // untrusted context is the precondition for the write-budget to fire at all.
  QUANTA_UNTRUSTED_ENVELOPE: "1",
  QUANTA_SANDBOX_ESCALATION: "1",
}

const surfaceDeps = (approve: boolean): SecurityRailsSurfaceDeps => ({
  permissionStore: store,
  onConfirm: async (_a: ToolAction): Promise<ConfirmDecision> => ({
    decision: approve ? "allow" : "deny",
  }),
})

/** Drive the EXACT interactive-CLI compose seam: `wireSecurityRailsForOverlay`
 *  with the in-scope permissionStore + onConfirm. Returns the overlay writeBudget
 *  (what the CLI threads onto its overlay) and installs the escalation handler as
 *  a side-effect — exactly as `composeCliRuntimeContext` does. */
const composeRails = (env: Record<string, string>, approve = true) =>
  wireSecurityRailsForOverlay(runtimeConfigFromEnv(env), surfaceDeps(approve))

// ── write-budget behavior: overlay → base → per-turn config → REAL dispatch ─────

/** Build the CLI's REAL per-turn AgentConfig from a base carrying the overlay
 *  writeBudget (the no-turnAssembler branch `buildAgentConfigFromBase` uses on
 *  the interactive surface: base `...rest` spread), then bind the turn ctx via
 *  the REAL `buildToolContext` dispatch seam. */
const ctxFor = (
  writeBudget: AgentConfig["writeBudget"],
  env: Record<string, string>,
): ToolContext => {
  const base = {
    llm: { model: "test", async *stream() {} },
    stream: { emit: () => {} },
    permission: { mode: "acceptEdits" },
    messages: [],
    system: "test",
    cwd: dir,
    maxTurns: 4,
    signal: new AbortController().signal,
    planMode: false,
    run: { turn: 0 },
    ...(writeBudget !== undefined ? { writeBudget } : {}),
  } as unknown as RuntimeBase
  // The interactive CLI has NO turnAssembler ⇒ this is the exact per-turn config
  // builder the REPL uses (base `...rest` spread carries writeBudget through).
  const config = buildAgentConfigFromBase({ base, messages: [] })
  // runtimeConfig() (read by buildToolContext for writeBudgetMax) must see the
  // same env the compose seam did.
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  __resetRuntimeConfig()
  return buildToolContext({
    config,
    workingState: undefined,
    collabMode: resolveCollaborationMode({ planMode: false }),
    toolCallId: "tc-1",
  })
}

const clearEnv = (env: Record<string, string>): void => {
  for (const k of Object.keys(env)) delete process.env[k]
  __resetRuntimeConfig()
}

const runWrite = async (name: string, ctx: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of writeTool.execute({ path: join(dir, name), content: "x" } as never, ctx)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("HELLGATE — interactive CLI write-budget wires to a REAL dispatch deny", () => {
  test("GREEN: the CLI overlay writeBudget denies the (N+1)th write in an untrusted turn", async () => {
    // Drive the REAL compose seam ⇒ the writeBudget the CLI threads onto its overlay.
    const { writeBudget } = composeRails(RAILS_ON)
    expect(writeBudget).not.toBeUndefined() // sanity: the rail actually minted one
    const ctx = ctxFor(writeBudget, RAILS_ON)
    try {
      // MAX=2 ⇒ first two writes ok, the 3rd (N+1) is DENIED by the composed budget.
      expect((await runWrite("w1.txt", ctx)).ok).toBe(true)
      expect((await runWrite("w2.txt", ctx)).ok).toBe(true)
      const over = await runWrite("w3.txt", ctx)
      expect(over.ok).toBe(false)
      // The over-cap write never touched the filesystem.
      expect(() => readFileSync(join(dir, "w3.txt"), "utf8")).toThrow()
    } finally {
      clearEnv(RAILS_ON)
    }
  })

  test("RED-ON-INJECTION: WITHOUT the compose wire, writeBudget is absent ⇒ the (N+1)th write is OK again", async () => {
    // Simulate the removed CLI wire: the overlay carries NO writeBudget.
    const ctx = ctxFor(undefined, RAILS_ON)
    try {
      // No budget bound on the ctx ⇒ dispatch never denies ⇒ unbounded writes.
      expect(ctx.writeBudget).toBeUndefined()
      for (let i = 0; i < 5; i++) {
        expect((await runWrite(`nb-${i}.txt`, ctx)).ok).toBe(true)
      }
    } finally {
      clearEnv(RAILS_ON)
    }
  })

  test("COMP-ROOT: the interactive overlay carries writeBudget when the knob is ON (and omits it OFF)", () => {
    const on = composeRails(RAILS_ON)
    expect(on.writeBudget).not.toBeUndefined()
    // Knob OFF ⇒ no budget minted ⇒ overlay slot omitted (default-OFF byte-identical).
    const off = composeRails({})
    expect(off.writeBudget).toBeUndefined()
  })
})

// ── sandbox-escalation behavior: the SAME compose call installs the handler ─────

/** A fake per-call sandbox that APPLIES + rewrites argv so the SANDBOXED spawn
 *  fails with a Seatbelt-deny stderr (the high-confidence block signal). The
 *  UNSANDBOXED re-run runs the ORIGINAL command verbatim. */
const blockingSandbox = (): PerCallSandboxPort => ({
  availability: (): PerCallSandboxAvailability => ({ supported: true }),
  wrap: () => ({
    argv: ["bash", "-lc", 'echo "Sandbox: app(1) deny(1) file-write-data" 1>&2; exit 1'],
    sandboxApplied: true,
  }),
})

/** The bash ctx the per-turn dispatch seam would build: the SESSION's
 *  sandbox-escalation handler (stage 1, minted by the compose wire) projected onto
 *  `ToolContext.sandboxEscalation` (stage 2). Pass `undefined` for the
 *  no-compose-wire control. */
const bashCtx = (sandboxEscalation?: AgentConfig["bashSandboxEscalation"]): ToolContext =>
  ({
    cwd: dir,
    signal: new AbortController().signal,
    agentLabel: "root",
    turnId: "turn-1",
    ...(sandboxEscalation !== undefined ? { sandboxEscalation } : {}),
  }) as ToolContext

const runBash = async (command: string, ctx: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of bashTool.execute(
    { command, mode: "read" } as never,
    ctx,
  ) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("HELLGATE — interactive CLI sandbox-escalation mints a FIRING per-session handler", () => {
  beforeEach(() => {
    __setBashPerCallSandboxFactory(() => blockingSandbox())
  })

  test("GREEN: compose wire mints the handler ⇒ block + APPROVE re-runs UNSANDBOXED (failure → success)", async () => {
    // The compose wire RETURNS the per-session handler; the CLI threads it onto
    // its overlay → base → per-turn config → ctx. A dropped return value is a
    // DARK rail (there is no process-global back channel any more).
    const { bashSandboxEscalation } = composeRails(RAILS_ON, /* approve */ true)
    expect(bashSandboxEscalation).toBeDefined()
    const r = await runBash("echo unsandboxed-ok", bashCtx(bashSandboxEscalation))
    // onConfirm FIRED (approve) ⇒ the unsandboxed re-run flipped failure → success.
    expect(r.ok).toBe(true)
    expect(r.output).toContain("unsandboxed-ok")
    expect(r.output).toContain("blocked by the OS sandbox")
    expect(r.output.toLowerCase()).toContain("approved")
  })

  test("GREEN: block + DENY ⇒ onConfirm fired, escalation declined, command stays blocked", async () => {
    const { bashSandboxEscalation } = composeRails(RAILS_ON, /* approve */ false)
    const r = await runBash("echo SHOULD-NOT-RUN", bashCtx(bashSandboxEscalation))
    expect(r.ok).toBe(false)
    expect(r.output).not.toContain("SHOULD-NOT-RUN")
    expect(r.output).toContain("blocked by the OS sandbox")
    expect(r.output.toLowerCase()).toContain("declined")
  })

  test("RED-ON-INJECTION: WITHOUT the compose wire, NO handler ⇒ block surfaces as a plain failure (never escalated)", async () => {
    // Do NOT call composeRails — the removed CLI wire ⇒ no handler on the ctx.
    // The GREEN test above proves that WITH the wire this exact sandboxed failure
    // routes through onConfirm + emits the "blocked by the OS sandbox" note and
    // (on approve) flips to success. Here neither happens: the failure stands and
    // no escalation note appears — the rail is dark, exactly the pinned bug.
    const r = await runBash("echo never-unsandboxed", bashCtx(undefined))
    expect(r.ok).toBe(false)
    expect(r.output).not.toContain("never-unsandboxed")
    expect(r.output).not.toContain("blocked by the OS sandbox")
  })

  test("OFF ⇒ knobs unset ⇒ compose mints NO handler (default-OFF byte-identical)", async () => {
    const { bashSandboxEscalation } = composeRails({}) // both knobs off
    expect(bashSandboxEscalation).toBeUndefined()
    const r = await runBash("echo off-plain", bashCtx(bashSandboxEscalation))
    expect(r.ok).toBe(false)
    expect(r.output).not.toContain("blocked by the OS sandbox")
  })
})

// ── overlay → base LIFT (the REAL CLI base builder carries the slot) ─────────────

describe("HELLGATE — overlay writeBudget is lifted onto the base by the REAL CLI base builder", () => {
  test("buildAgentConfigFromBase (no turnAssembler = the interactive path) carries base.writeBudget", () => {
    const { writeBudget } = composeRails(RAILS_ON)
    const base = {
      llm: { model: "t", async *stream() {} },
      stream: { emit: () => {} },
      permission: { mode: "acceptEdits" },
      messages: [],
      system: "s",
      cwd: dir,
      maxTurns: 4,
      signal: new AbortController().signal,
      writeBudget,
    } as unknown as RuntimeBase
    const cfg = buildAgentConfigFromBase({ base, messages: [] })
    expect(cfg.writeBudget).toBe(writeBudget)
  })

  test("absent ⇒ slot omitted on the per-turn config (default-OFF byte-identical)", () => {
    const base = {
      llm: { model: "t", async *stream() {} },
      stream: { emit: () => {} },
      permission: { mode: "acceptEdits" },
      messages: [],
      system: "s",
      cwd: dir,
      maxTurns: 4,
      signal: new AbortController().signal,
    } as unknown as RuntimeBase
    const cfg = buildAgentConfigFromBase({ base, messages: [] })
    expect(Object.hasOwn(cfg, "writeBudget")).toBe(false)
  })
})

// ── SOURCE regression guard: the CLI compose actually CALLS the owner ────────────

describe("HELLGATE — the interactive CLI compose CALLS the security-rails owner", () => {
  const composeSrc = readFileSync(
    join(import.meta.dir, "../../src/apps/cli/repl/runtime-context-compose.ts"),
    "utf8",
  )

  test("composeCliRuntimeContext invokes wireSecurityRailsForOverlay with permissionStore + onConfirm", () => {
    expect(composeSrc).toContain("wireSecurityRailsForOverlay")
    // The call passes the in-scope gate-shared store + composed onConfirm.
    expect(
      /wireSecurityRailsForOverlay\([\s\S]{0,160}permissionStore,\s*onConfirm/.test(composeSrc),
    ).toBe(true)
  })

  test("the minted writeBudget is threaded onto the overlay (base carries it to dispatch)", () => {
    // comp-root → bootstrap args (via the shared slot projection) → overlay slot.
    expect(composeSrc).toMatch(/securityOverlaySlots\(securityRails\)/)
    expect(composeSrc).toMatch(/writeBudget: rails\.writeBudget/)
    expect(composeSrc).toMatch(/writeBudget !== undefined \? \{ writeBudget \}/)
  })

  test("the minted PER-SESSION sandbox-escalation handler is ALSO threaded onto the overlay", () => {
    // aug-23 — the handler stopped being a process-global, so the compose MUST
    // carry the returned slot onto the overlay or the rail is silently dark on the
    // interactive CLI (exactly the class of bug the write-budget guard above pins).
    expect(composeSrc).toMatch(/bashSandboxEscalation: rails\.bashSandboxEscalation/)
    expect(composeSrc).toMatch(/bashSandboxEscalation !== undefined \? \{ bashSandboxEscalation \}/)
  })
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))
