import { describe, expect, test } from "bun:test"
import { type AdmissibilityWaveAOptions, runAdmissibilityGate } from "@/agent/admissibility-gate"
import {
  type DenialMemory,
  OutcomeInvariantError,
  type PermissionContext,
  ReviewerUnavailableError,
  type ToolActionKeyed,
} from "@/permission"
import { RulesStore } from "@/rules"
import { ToolRegistry } from "@/tool"
import {
  actionOf,
  bashSchema,
  call,
  cfg,
  decision,
  loadedStore,
  makePort,
  makeTool,
} from "./_fixtures"

describe("Wave A: byte-identical bypass when no option supplied", () => {
  test("undefined wave → behaves exactly like legacy 5-arg call", async () => {
    const ro = makeTool("ro", { readOnly: true })
    const c = cfg({ registry: new ToolRegistry([ro]) })
    // legacy 5-arg call (no wave)
    const legacy = await runAdmissibilityGate(call("ro"), c, { mode: "default" }, actionOf(ro))
    // explicit undefined wave
    const explicit = await runAdmissibilityGate(
      call("ro"),
      c,
      { mode: "default" },
      actionOf(ro),
      undefined,
      undefined,
    )
    expect(legacy).toBeNull()
    expect(explicit).toBeNull()
  })

  test("empty wave object → byte-identical (no option asserted)", async () => {
    const ro = makeTool("ro", { readOnly: true })
    const c = cfg({ registry: new ToolRegistry([ro]) })
    const res = await runAdmissibilityGate(
      call("ro"),
      c,
      { mode: "default" },
      actionOf(ro),
      undefined,
      {},
    )
    expect(res).toBeNull()
  })

  test("empty wave object → mutating tool still asked via legacy onConfirm", async () => {
    const mut = makeTool("mut", { readOnly: false })
    let asked = false
    const c = cfg({
      registry: new ToolRegistry([mut]),
      onConfirm: async () => {
        asked = true
        return false
      },
    })
    const res = await runAdmissibilityGate(
      call("mut"),
      c,
      { mode: "default" },
      actionOf(mut),
      undefined,
      {},
    )
    expect(asked).toBe(true)
    expect(res?.preview).toBe("declined")
  })
})

// ─── 2. RulesStore only ───────────────────────────────────────────────────

describe("Wave A: RulesStore-only paths", () => {
  const bash = makeTool("bash", {
    readOnly: false,
    schema: bashSchema,
    extractShellCommand: (input) => (input as { command: string }).command,
  })

  test("rule allow → admit (skips HITL + mode policy)", async () => {
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("allow git status\n"),
    }
    const c = cfg({
      registry: new ToolRegistry([bash]),
      permission: { mode: "default" },
      // No onConfirm wired — proves the rule bypassed the mode ask path.
    })
    const input = { command: "git status" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "default" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    expect(res).toBeNull()
  })

  test("rule deny → terminal deny with rule_deny preview", async () => {
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("deny rm -rf\n"),
    }
    const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "bypass" } })
    const input = { command: "rm -rf ./dist" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("rule_deny")
    expect(res?.block.content).toContain("Permission denied by rule")
    expect(res?.block.content).toContain("rm -rf")
  })

  test("rule ask without ReviewerPort → deny with rule_ask preview", async () => {
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("ask git push\n"),
    }
    const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "bypass" } })
    const input = { command: "git push origin main" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("rule_ask")
    expect(res?.block.content).toContain("no ReviewerPort is wired")
  })

  test("rule no_match + default policy (fallthrough) → continue to legacy path", async () => {
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("allow git status\n"),
    }
    let asked = false
    const c = cfg({
      registry: new ToolRegistry([bash]),
      permission: { mode: "default" },
      onConfirm: async () => {
        asked = true
        return false
      },
    })
    const input = { command: "npm run build" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "default" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    // No rule fired → fallthrough → mode policy → onConfirm asked.
    expect(asked).toBe(true)
    expect(res?.preview).toBe("declined")
  })

  test("rule no_match + noMatchPolicy='fallthrough' explicit → same as default", async () => {
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("allow git status\n"),
      noMatchPolicy: "fallthrough",
    }
    const c = cfg({
      registry: new ToolRegistry([bash]),
      permission: { mode: "bypass" },
    })
    const input = { command: "npm run build" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    // bypass admits since no rule matched and we fell through.
    expect(res).toBeNull()
  })

  test("rule no_match + noMatchPolicy='deny' → terminal default-deny", async () => {
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("allow git status\n"),
      noMatchPolicy: "deny",
    }
    const c = cfg({
      registry: new ToolRegistry([bash]),
      permission: { mode: "bypass" }, // would have allowed legacy
    })
    const input = { command: "npm run build" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    expect(res?.preview).toBe("rule_no_match_deny")
    expect(res?.block.content).toContain("no rule matched")
  })

  test("3-layer precedence (project > user > system): project deny beats system allow", async () => {
    const store = new RulesStore()
    store.loadLayer("system", "allow npm run\n", "system.rules")
    store.loadLayer("project", "deny npm run build\n", "project.rules")
    const wave: AdmissibilityWaveAOptions = { rulesStore: store }
    const c = cfg({ registry: new ToolRegistry([bash]), permission: { mode: "bypass" } })
    const input = { command: "npm run build" }
    const res = await runAdmissibilityGate(
      call("bash", input),
      c,
      { mode: "bypass" },
      actionOf(bash, input),
      undefined,
      wave,
    )
    expect(res?.preview).toBe("rule_deny")
  })

  test("rule allow without shellCommand falls back to tool name match", async () => {
    const ro = makeTool("read_file", { readOnly: true })
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("allow read_file\n"),
    }
    const c = cfg({
      registry: new ToolRegistry([ro]),
      permission: { mode: "default" },
    })
    const res = await runAdmissibilityGate(
      call("read_file"),
      c,
      { mode: "default" },
      actionOf(ro),
      undefined,
      wave,
    )
    expect(res).toBeNull()
  })
})

// ─── 3. ReviewerPort only (HITL always-confirm escalation) ────────────────
