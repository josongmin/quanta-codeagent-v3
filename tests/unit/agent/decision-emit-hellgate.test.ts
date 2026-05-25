/**
 * ADR-0267 (Phase 2 of ADR-0239) — `decision` event emit hellgate.
 *
 * Locks the contract for the 3 emit sites in `runAdmissibilityGate`:
 *   - rule  (allow / deny / ask / no_match-deny) — kind:"rule" with ruleId.
 *   - hook  (pre_tool_use admit / deny)         — kind:"hook" with hookName.
 *   - permission (mode policy + stack)          — kind:"permission".
 *
 * Invariants asserted:
 *   1. emit produces the EXACT DecisionEvent shape (kind/outcome/reason).
 *   2. `toolCallId` is populated and matches `call.id` so the debug-tracer
 *      can pair the row with the upstream `tool_call`.
 *   3. `decisionEmitter: undefined` ⇒ ZERO emits + the gate result is
 *      byte-identical to the legacy path (verified by comparing the result
 *      with the no-emitter run vs the emitter-wired run).
 *   4. An emitter that THROWS does not affect the gate result (try/catch
 *      isolation — observational sink contract).
 *   5. Same logical decision emits ONCE per call (no duplicates inside one
 *      gate run, even when the rule branch routes through the pre-hook).
 *   6. `metadata` carries ONLY `{ tool }` — never `action.input` (PII/secret
 *      scrub at the emit site).
 *
 * Slice fence: imports the agent slice (admissibility-gate) + stream port +
 * permission types. No CLI, no apps wiring.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { HookBus } from "@/agent"
import { type AdmissibilityAction, runAdmissibilityGate } from "@/agent/admissibility-gate"
import type { ToolUseBlock } from "@/llm"
import type { HITLTier, PermissionContext } from "@/permission"
import { RulesStore } from "@/rules"
import type { DecisionEmitter, DecisionEvent } from "@/stream"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

// ── helpers ───────────────────────────────────────────────────────────────

const makeTool = (
  name: string,
  opts: {
    readOnly?: boolean
    schema?: z.ZodTypeAny
    hitlTier?: (input: unknown) => HITLTier
    run?: () => AsyncIterable<ToolEvent>
  } = {},
): Tool => {
  const tool: Tool = {
    name,
    description: `${name} tool`,
    inputSchema: (opts.schema ?? z.object({})) as z.ZodType<unknown>,
    isReadOnly: () => opts.readOnly ?? false,
    isConcurrencySafe: () => opts.readOnly ?? false,
    execute: () =>
      opts.run
        ? opts.run()
        : (async function* () {
            yield { type: "result", result: { ok: true, output: "ran" } }
          })(),
  }
  if (opts.hitlTier) {
    ;(tool as Tool & { hitlTier: (input: unknown) => HITLTier }).hitlTier = opts.hitlTier
  }
  return tool
}

const call = (name: string, input: unknown = {}, id = "tc_7a"): ToolUseBlock => ({
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

const actionOf = (tool: Tool, input: unknown = {}): AdmissibilityAction => ({
  tool: tool.name,
  input,
  isReadOnly: tool.isReadOnly(),
})

const bashSchema = z.object({ command: z.string() })

/** Collecting emitter — records every emit into a frozen array per call. */
const collector = (): {
  emitter: DecisionEmitter
  events: () => readonly DecisionEvent[]
} => {
  const events: DecisionEvent[] = []
  return {
    emitter: {
      emit(e: DecisionEvent): void {
        events.push(e)
      },
    },
    events: () => events,
  }
}

/** Emitter that throws on every call — used to prove emit failure does NOT
 *  poison the gate's return path. */
const poisonEmitter: DecisionEmitter = {
  emit(): void {
    throw new Error("simulated tracer crash")
  },
}

// ── site 1 — rule (4 cases) ───────────────────────────────────────────────

describe("ADR-0267 emit: rule gate", () => {
  test("rule allow emits kind:rule, outcome:allow, ruleId, toolCallId paired", async () => {
    const read = makeTool("read", { readOnly: true })
    const rules = new RulesStore()
    rules.loadLayer("project", "allow read", "/tmp/.quanta/rules")
    const cap = collector()
    const c = cfg({ registry: new ToolRegistry([read]), decisionEmitter: cap.emitter })
    const u = call("read", {}, "tc_allow")
    const res = await runAdmissibilityGate(u, c, c.permission, actionOf(read), undefined, {
      rulesStore: rules,
    })
    expect(res).toBe(null)
    const ruleEvents = cap.events().filter((e) => e.kind === "rule")
    expect(ruleEvents.length).toBe(1)
    expect(ruleEvents[0]?.outcome).toBe("allow")
    expect(ruleEvents[0]?.toolCallId).toBe("tc_allow")
    expect(ruleEvents[0]?.ruleId).toContain("project:")
    // Reason mentions the prefix + layer, but NOT the matched command.
    expect(ruleEvents[0]?.reason).toContain("read")
    expect(ruleEvents[0]?.reason).toContain("project")
  })

  test("rule deny emits kind:rule, outcome:deny + ruleId; gate denies", async () => {
    const bash = makeTool("bash", { schema: bashSchema })
    const rules = new RulesStore()
    rules.loadLayer("project", "deny bash", "/tmp/.quanta/rules")
    const cap = collector()
    const c = cfg({ registry: new ToolRegistry([bash]), decisionEmitter: cap.emitter })
    const u = call("bash", { command: "ls" }, "tc_deny")
    const res = await runAdmissibilityGate(
      u,
      c,
      c.permission,
      actionOf(bash, { command: "ls" }),
      undefined,
      { rulesStore: rules },
    )
    expect(res).not.toBe(null)
    const ruleEvents = cap.events().filter((e) => e.kind === "rule")
    expect(ruleEvents.length).toBe(1)
    expect(ruleEvents[0]?.outcome).toBe("deny")
    expect(ruleEvents[0]?.toolCallId).toBe("tc_deny")
  })

  test("rule ask (no reviewer wired) emits ask BEFORE the rule_ask wiring-deny", async () => {
    const bash = makeTool("bash", { schema: bashSchema })
    const rules = new RulesStore()
    rules.loadLayer("project", "ask bash", "/tmp/.quanta/rules")
    const cap = collector()
    const c = cfg({ registry: new ToolRegistry([bash]), decisionEmitter: cap.emitter })
    const u = call("bash", { command: "ls" }, "tc_ask")
    const res = await runAdmissibilityGate(
      u,
      c,
      c.permission,
      actionOf(bash, { command: "ls" }),
      undefined,
      { rulesStore: rules },
    )
    expect(res).not.toBe(null)
    const ruleEvents = cap.events().filter((e) => e.kind === "rule")
    expect(ruleEvents.length).toBe(1)
    expect(ruleEvents[0]?.outcome).toBe("ask")
  })

  test("noMatchPolicy='deny' emits kind:rule, outcome:deny, no ruleId", async () => {
    const read = makeTool("read", { readOnly: true })
    const rules = new RulesStore()
    // empty rules — every match is no_match
    const cap = collector()
    const c = cfg({ registry: new ToolRegistry([read]), decisionEmitter: cap.emitter })
    const u = call("read", {}, "tc_no_match")
    const res = await runAdmissibilityGate(u, c, c.permission, actionOf(read), undefined, {
      rulesStore: rules,
      noMatchPolicy: "deny",
    })
    expect(res).not.toBe(null)
    const ruleEvents = cap.events().filter((e) => e.kind === "rule")
    expect(ruleEvents.length).toBe(1)
    expect(ruleEvents[0]?.outcome).toBe("deny")
    expect(ruleEvents[0]?.ruleId).toBeUndefined()
  })
})

// ── site 2 — hook (pre_tool_use) ──────────────────────────────────────────

describe("ADR-0267 emit: pre_tool_use hook gate", () => {
  test("hook deny emits kind:hook, outcome:deny + hookName='pre_tool_use'", async () => {
    const read = makeTool("read", { readOnly: true })
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ deny: "blocked by hook" }))
    const cap = collector()
    const c = cfg({
      registry: new ToolRegistry([read]),
      hooks,
      decisionEmitter: cap.emitter,
    })
    const u = call("read", {}, "tc_hook_deny")
    const res = await runAdmissibilityGate(u, c, c.permission, actionOf(read))
    expect(res).not.toBe(null)
    const hookEvents = cap.events().filter((e) => e.kind === "hook")
    expect(hookEvents.length).toBe(1)
    expect(hookEvents[0]?.outcome).toBe("deny")
    expect(hookEvents[0]?.hookName).toBe("pre_tool_use")
    expect(hookEvents[0]?.toolCallId).toBe("tc_hook_deny")
    expect(hookEvents[0]?.reason).toContain("blocked by hook")
  })

  test("hook admit emits kind:hook, outcome:allow on the admit path", async () => {
    const read = makeTool("read", { readOnly: true })
    const hooks = new HookBus()
    // no handler ⇒ default admit
    const cap = collector()
    const c = cfg({
      registry: new ToolRegistry([read]),
      hooks,
      decisionEmitter: cap.emitter,
    })
    const u = call("read", {}, "tc_hook_ok")
    const res = await runAdmissibilityGate(u, c, c.permission, actionOf(read))
    expect(res).toBe(null)
    const hookEvents = cap.events().filter((e) => e.kind === "hook")
    expect(hookEvents.length).toBe(1)
    expect(hookEvents[0]?.outcome).toBe("allow")
  })

  test("no hooks configured ⇒ ZERO hook decision events (gate skips the seam)", async () => {
    const read = makeTool("read", { readOnly: true })
    const cap = collector()
    const c = cfg({ registry: new ToolRegistry([read]), decisionEmitter: cap.emitter })
    const u = call("read", {}, "tc_no_hooks")
    const res = await runAdmissibilityGate(u, c, c.permission, actionOf(read))
    expect(res).toBe(null)
    expect(cap.events().filter((e) => e.kind === "hook").length).toBe(0)
  })
})

// ── site 3 — permission (mode policy) ─────────────────────────────────────

describe("ADR-0267 emit: permission mode-policy gate", () => {
  test("mode='bypass' on mutating tool emits kind:permission, outcome:allow", async () => {
    const write = makeTool("write")
    const cap = collector()
    const c = cfg({
      registry: new ToolRegistry([write]),
      permission: { mode: "bypass" },
      decisionEmitter: cap.emitter,
    })
    const u = call("write", {}, "tc_perm_allow")
    const res = await runAdmissibilityGate(u, c, c.permission, actionOf(write))
    expect(res).toBe(null)
    const permEvents = cap.events().filter((e) => e.kind === "permission")
    expect(permEvents.length).toBe(1)
    expect(permEvents[0]?.outcome).toBe("allow")
    expect(permEvents[0]?.toolCallId).toBe("tc_perm_allow")
  })

  test("mode='default' on mutating tool with NO onConfirm denies — emits ask first, then declined", async () => {
    const write = makeTool("write")
    const cap = collector()
    const c = cfg({
      registry: new ToolRegistry([write]),
      permission: { mode: "default" },
      // no onConfirm wired ⇒ default-deny
      decisionEmitter: cap.emitter,
    })
    const u = call("write", {}, "tc_perm_ask")
    const res = await runAdmissibilityGate(u, c, c.permission, actionOf(write))
    expect(res).not.toBe(null)
    const permEvents = cap.events().filter((e) => e.kind === "permission")
    expect(permEvents.length).toBe(1)
    expect(permEvents[0]?.outcome).toBe("ask")
  })

  test("read-only tool allowed under mode='default' emits kind:permission, outcome:allow", async () => {
    const read = makeTool("read", { readOnly: true })
    const cap = collector()
    const c = cfg({
      registry: new ToolRegistry([read]),
      permission: { mode: "default" },
      decisionEmitter: cap.emitter,
    })
    const u = call("read", {}, "tc_ro_allow")
    const res = await runAdmissibilityGate(u, c, c.permission, actionOf(read))
    expect(res).toBe(null)
    const permEvents = cap.events().filter((e) => e.kind === "permission")
    expect(permEvents.length).toBe(1)
    expect(permEvents[0]?.outcome).toBe("allow")
  })
})

// ── default-OFF + isolation invariants ────────────────────────────────────

describe("ADR-0267 invariants", () => {
  test("decisionEmitter:undefined ⇒ gate result is byte-identical to wired path (admit + deny + ask)", async () => {
    // Audit-strengthen: previous version only checked `resBare === null` and
    // `resWired === null` on the SAME admit path. That proves nothing about
    // "byte-identical" — both paths converging on null isn't a test, it's
    // a tautology. We now exercise THREE branches (admit / deny / ask) and
    // for each one verify `resBare === resWired` value-wise (JSON-equal).
    const write = makeTool("write")
    const bash = makeTool("bash", { schema: bashSchema })

    // Branch 1: admit (bypass mode + mutating tool — both return null).
    {
      const u = call("write", { x: 1 }, "tc_iso_admit")
      const cWired = cfg({
        registry: new ToolRegistry([write]),
        permission: { mode: "bypass" },
        decisionEmitter: collector().emitter,
      })
      const cBare = cfg({
        registry: new ToolRegistry([write]),
        permission: { mode: "bypass" },
      })
      const resWired = await runAdmissibilityGate(u, cWired, cWired.permission, actionOf(write))
      const resBare = await runAdmissibilityGate(u, cBare, cBare.permission, actionOf(write))
      expect(resBare).toBe(null)
      expect(resWired).toBe(null)
      // Stronger: equal structurally — `toEqual(null)` proves no hidden field.
      expect(resWired).toEqual(resBare)
    }

    // Branch 2: rule deny — non-null result. Both paths must produce the
    // SAME deny envelope (id, name, isError, content shape).
    {
      const rules = new RulesStore()
      rules.loadLayer("project", "deny bash", "/tmp/.quanta/rules")
      const u = call("bash", { command: "ls" }, "tc_iso_deny")
      const cWired = cfg({
        registry: new ToolRegistry([bash]),
        decisionEmitter: collector().emitter,
      })
      const cBare = cfg({ registry: new ToolRegistry([bash]) })
      const resWired = await runAdmissibilityGate(
        u,
        cWired,
        cWired.permission,
        actionOf(bash, { command: "ls" }),
        undefined,
        { rulesStore: rules },
      )
      const resBare = await runAdmissibilityGate(
        u,
        cBare,
        cBare.permission,
        actionOf(bash, { command: "ls" }),
        undefined,
        { rulesStore: rules },
      )
      expect(resBare).not.toBe(null)
      expect(resWired).not.toBe(null)
      // Byte-identical (JSON) — proves the emit-wired path produced the SAME
      // deny envelope as the bare path.
      expect(JSON.stringify(resWired)).toBe(JSON.stringify(resBare))
    }

    // Branch 3: rule ask (no reviewer wired ⇒ wiring-deny). Same shape lock.
    {
      const rules = new RulesStore()
      rules.loadLayer("project", "ask bash", "/tmp/.quanta/rules")
      const u = call("bash", { command: "echo hi" }, "tc_iso_ask")
      const cWired = cfg({
        registry: new ToolRegistry([bash]),
        decisionEmitter: collector().emitter,
      })
      const cBare = cfg({ registry: new ToolRegistry([bash]) })
      const resWired = await runAdmissibilityGate(
        u,
        cWired,
        cWired.permission,
        actionOf(bash, { command: "echo hi" }),
        undefined,
        { rulesStore: rules },
      )
      const resBare = await runAdmissibilityGate(
        u,
        cBare,
        cBare.permission,
        actionOf(bash, { command: "echo hi" }),
        undefined,
        { rulesStore: rules },
      )
      expect(JSON.stringify(resWired)).toBe(JSON.stringify(resBare))
    }
  })

  test("throwing emitter does NOT poison the gate's deny result + result equals bare-path deny", async () => {
    const bash = makeTool("bash", { schema: bashSchema })
    const rules = new RulesStore()
    rules.loadLayer("project", "deny bash", "/tmp/.quanta/rules")
    const cPoison = cfg({
      registry: new ToolRegistry([bash]),
      decisionEmitter: poisonEmitter,
    })
    const cBare = cfg({ registry: new ToolRegistry([bash]) })
    const u = call("bash", { command: "ls" }, "tc_poison")
    // The gate must still deny — the throw is swallowed by safeEmitDecision.
    const resPoison = await runAdmissibilityGate(
      u,
      cPoison,
      cPoison.permission,
      actionOf(bash, { command: "ls" }),
      undefined,
      { rulesStore: rules },
    )
    const resBare = await runAdmissibilityGate(
      u,
      cBare,
      cBare.permission,
      actionOf(bash, { command: "ls" }),
      undefined,
      { rulesStore: rules },
    )
    expect(resPoison).not.toBe(null)
    expect(resBare).not.toBe(null)
    // Stronger: result is byte-identical to the bare path. A `not null` check
    // alone could pass if the gate substituted a different deny (e.g., a
    // generic "internal-error" envelope) — that would be a regression masked
    // by the weak assertion.
    expect(JSON.stringify(resPoison)).toBe(JSON.stringify(resBare))
  })

  test("throwing emitter — subsequent emit calls also do NOT propagate (post-throw state stable)", async () => {
    // Audit-add: a throw on call #1 could leave the safeEmit helper in a
    // broken try/catch state (e.g., a stale promise rejection). Fire two
    // gate runs back-to-back through the same poison emitter — both must
    // return their stable deny envelopes.
    const bash = makeTool("bash", { schema: bashSchema })
    const rules = new RulesStore()
    rules.loadLayer("project", "deny bash", "/tmp/.quanta/rules")
    const c = cfg({ registry: new ToolRegistry([bash]), decisionEmitter: poisonEmitter })
    const r1 = await runAdmissibilityGate(
      call("bash", { command: "ls" }, "tc_poison_1"),
      c,
      c.permission,
      actionOf(bash, { command: "ls" }),
      undefined,
      { rulesStore: rules },
    )
    const r2 = await runAdmissibilityGate(
      call("bash", { command: "pwd" }, "tc_poison_2"),
      c,
      c.permission,
      actionOf(bash, { command: "pwd" }),
      undefined,
      { rulesStore: rules },
    )
    expect(r1).not.toBe(null)
    expect(r2).not.toBe(null)
  })

  test("rule allow does NOT double-emit through the routed pre-hook (admit path) + emit order is rule→hook + no permission leak", async () => {
    const read = makeTool("read", { readOnly: true })
    const rules = new RulesStore()
    rules.loadLayer("project", "allow read", "/tmp/.quanta/rules")
    const hooks = new HookBus()
    // no handler ⇒ default admit. We expect EXACTLY 1 rule emit + 1 hook
    // emit (the routed pre-hook), each kind-distinct, each one-shot.
    const cap = collector()
    const c = cfg({
      registry: new ToolRegistry([read]),
      hooks,
      decisionEmitter: cap.emitter,
    })
    const u = call("read", {}, "tc_chain")
    const res = await runAdmissibilityGate(u, c, c.permission, actionOf(read), undefined, {
      rulesStore: rules,
    })
    expect(res).toBe(null)
    const ev = cap.events()
    // Audit-strengthen: previous test only checked rule=1 + hook=1, which
    // would pass even if a SPURIOUS permission event also fired (the
    // permission gate runs before rule in the gate's call graph). Pin the
    // FULL event sequence so any future leak (perm/cap/jail/budget on the
    // admit path) shows up as a regression.
    expect(ev.length).toBe(2)
    expect(ev.map((e) => e.kind)).toEqual(["rule", "hook"])
    expect(ev.filter((e) => e.kind === "permission").length).toBe(0)
    expect(ev.filter((e) => e.kind === "cap").length).toBe(0)
    // Each toolCallId is paired with the same call id.
    expect(ev[0]?.toolCallId).toBe("tc_chain")
    expect(ev[1]?.toolCallId).toBe("tc_chain")
    // Outcomes: rule=allow, hook=allow on the admit path.
    expect(ev[0]?.outcome).toBe("allow")
    expect(ev[1]?.outcome).toBe("allow")
  })

  test("rule deny does NOT route through the pre-hook — ZERO hook emits on deny path", async () => {
    // Audit-add: the "no double emit" lock is for the ADMIT path. The DENY
    // path has the symmetric invariant — once rule denies, we MUST NOT also
    // emit a hook decision (the gate short-circuits before reaching it).
    const bash = makeTool("bash", { schema: bashSchema })
    const rules = new RulesStore()
    rules.loadLayer("project", "deny bash", "/tmp/.quanta/rules")
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ deny: "would-be-blocked" })) // installed but unreached
    const cap = collector()
    const c = cfg({
      registry: new ToolRegistry([bash]),
      hooks,
      decisionEmitter: cap.emitter,
    })
    const res = await runAdmissibilityGate(
      call("bash", { command: "ls" }, "tc_deny_short_circuit"),
      c,
      c.permission,
      actionOf(bash, { command: "ls" }),
      undefined,
      { rulesStore: rules },
    )
    expect(res).not.toBe(null)
    const ev = cap.events()
    // Exactly one rule deny, ZERO hook events (short-circuit lock).
    expect(ev.length).toBe(1)
    expect(ev[0]?.kind).toBe("rule")
    expect(ev[0]?.outcome).toBe("deny")
    expect(ev.filter((e) => e.kind === "hook").length).toBe(0)
  })

  test("metadata carries ONLY the tool name — never action.input keys", async () => {
    const bash = makeTool("bash", { schema: bashSchema })
    const rules = new RulesStore()
    rules.loadLayer("project", "deny bash", "/tmp/.quanta/rules")
    const cap = collector()
    const c = cfg({
      registry: new ToolRegistry([bash]),
      decisionEmitter: cap.emitter,
    })
    const sensitiveInput = { command: "echo SECRET_TOKEN_42" }
    const u = call("bash", sensitiveInput, "tc_meta")
    await runAdmissibilityGate(u, c, c.permission, actionOf(bash, sensitiveInput), undefined, {
      rulesStore: rules,
    })
    const ev = cap.events()[0]
    expect(ev).toBeDefined()
    // metadata must EXIST + carry the tool name, but NEVER the command body.
    expect(ev?.metadata).toBeDefined()
    expect(ev?.metadata?.tool).toBe("bash")
    // serialise the whole event and assert the secret token never leaks
    // through ANY field (reason / metadata / hookName / ruleId).
    const serialised = JSON.stringify(ev)
    expect(serialised).not.toContain("SECRET_TOKEN_42")
  })

  test("turn defaults to 0 when config.run is absent", async () => {
    const read = makeTool("read", { readOnly: true })
    const rules = new RulesStore()
    rules.loadLayer("project", "allow read", "/tmp/.quanta/rules")
    const cap = collector()
    const c = cfg({ registry: new ToolRegistry([read]), decisionEmitter: cap.emitter })
    await runAdmissibilityGate(call("read"), c, c.permission, actionOf(read), undefined, {
      rulesStore: rules,
    })
    const ev = cap.events()[0]
    expect(ev?.turn).toBe(0)
  })

  test("turn flows from config.run.turn when present", async () => {
    const read = makeTool("read", { readOnly: true })
    const rules = new RulesStore()
    rules.loadLayer("project", "allow read", "/tmp/.quanta/rules")
    const cap = collector()
    const c = cfg({
      registry: new ToolRegistry([read]),
      decisionEmitter: cap.emitter,
      run: { turn: 7, runId: "r1" },
    })
    await runAdmissibilityGate(call("read"), c, c.permission, actionOf(read), undefined, {
      rulesStore: rules,
    })
    const ev = cap.events().find((e) => e.kind === "rule")
    expect(ev?.turn).toBe(7)
  })
})
