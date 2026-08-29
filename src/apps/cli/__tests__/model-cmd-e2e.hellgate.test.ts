/**
 * Hellgate — `/model` command e2e + drift-guard (ticket 14, §11.6).
 *
 * REGISTERED + GREEN: these cases drive the COMMAND through the real
 * `runSlashCommand` dispatcher, which resolves names against the assembled
 * `BUILTINS`. `modelCmd` IS registered in `src/apps/cli/slash/registry-surface.ts`
 * (SURFACE layer), so they exercise the live registered command end-to-end —
 * no command-body change needed.
 *
 * Coverage:
 *   - no-arg list ⇒ current model MARKED `*` + every candidate rendered + hint;
 *   - valid set ⇒ persisted via the slot's `set`, confirmation echoed, AND the
 *     effort-clamp notice fires when the new model drops the current tier;
 *   - valid set on a reasoning model ⇒ NO clamp (effort untouched);
 *   - invalid id ⇒ "unknown model" + known list + exit 1 (no set);
 *   - too many args ⇒ exit 1;
 *   - absent slot ⇒ "not wired in this surface" + exit 0;
 *   - tab-complete ⇒ `/model` discoverable as a NAME completion post-registration
 *     (candidate-id ARG filtering is covered by the direct `modelCmd.complete`
 *     suite; REPL slash-arg completion is unwired for all commands — latent gap);
 *   - drift-guard: `/model` registered exactly once, in the SURFACE layer.
 */
import { describe, expect, test } from "bun:test"
import type { EffortLevel } from "@/agent"
import { createEffortStore, EFFORT_LEVELS } from "@/agent"
import type { ModelEffortSupport } from "@/llm/provider-metadata"
import { ALL_REASONING_EFFORTS } from "@/llm/provider-metadata"
import { fakeModelRouting } from "../../../../tests/_support/fake-model-routing"
import { buildModelAdapter } from "../repl/ctx-adapters/model-adapter"
import { modelCmd } from "../slash/model-cmd"
import type { ModelLineMeta } from "../slash/model-picker"
import { SURFACE_SLASH_COMMANDS } from "../slash/registry-surface"
import { BUILTINS, runSlashCommand, slashCompleter } from "../slash-commands"
import type { SlashContext } from "../slash-contract"

const NON_REASONING: ModelEffortSupport = {
  supportedEfforts: ["default"],
  defaultEffort: "default",
  reasoning: false,
}
const REASONING: ModelEffortSupport = {
  supportedEfforts: ALL_REASONING_EFFORTS,
  defaultEffort: "default",
  reasoning: true,
}

const CANDIDATES: readonly ModelLineMeta[] = [
  {
    id: "gpt-5",
    contextWindow: 400_000,
    maxOutput: 128_000,
    recommended: true,
    hint: "most capable",
  },
  { id: "gpt-4o", contextWindow: 128_000, maxOutput: 16_384, hint: "lower cost" },
  { id: "future-xyz" }, // metadata-absent ⇒ degrade
]

interface Harness {
  ctx: SlashContext
  readonly stdout: string
  readonly stderr: string
  readonly setCalls: string[]
  readonly effortSetCalls: EffortLevel[]
  current: { value: string }
  effort: { value: EffortLevel }
}

const buildHarness = (opts?: {
  readonly initialModel?: string
  readonly initialEffort?: EffortLevel
  readonly withEffort?: boolean
  readonly withModel?: boolean
}): Harness => {
  let stdout = ""
  let stderr = ""
  const setCalls: string[] = []
  const effortSetCalls: EffortLevel[] = []
  const current = { value: opts?.initialModel ?? "gpt-5" }
  const effort = { value: opts?.initialEffort ?? "high" }
  const effortSupport = (id: string): ModelEffortSupport | undefined => {
    if (id === "gpt-4o") return NON_REASONING
    if (id === "gpt-5") return REASONING
    return undefined // future-xyz ⇒ conservative no-clamp
  }
  const ctx: SlashContext = {
    out: (s) => {
      stdout += s
    },
    err: (s) => {
      stderr += s
    },
    cwd: "/tmp",
    ...((opts?.withModel ?? true)
      ? {
          model: {
            current: () => current.value,
            candidates: () => CANDIDATES,
            set: async (id: string) => {
              setCalls.push(id)
              current.value = id
              return "ok" as const
            },
            // aug-28 — the `--clear` half of the wire. The fake mirrors the real
            // adapter's post-state: no pick ⇒ `current()` reports the boot model.
            clear: async () => {
              current.value = opts?.initialModel ?? "gpt-5"
              return "ok" as const
            },
            effortSupport,
          },
        }
      : {}),
    ...((opts?.withEffort ?? true)
      ? {
          effort: {
            get: () => effort.value,
            set: (lvl) => {
              effortSetCalls.push(lvl)
              effort.value = lvl
            },
            levels: ALL_REASONING_EFFORTS as readonly EffortLevel[],
            budgetTokens: () => undefined,
          },
        }
      : {}),
  }
  return {
    ctx,
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
    setCalls,
    effortSetCalls,
    current,
    effort,
  }
}

// Direct-invocation suite — proves the COMMAND BODY independent of registration
// (GREEN now). Once the orchestrator wires `modelCmd` into registry-surface.ts,
// the dispatcher-based suite below covers the identical behavior end-to-end.
describe("/model command body — direct invocation (GREEN now)", () => {
  test("no-arg list marks current + renders candidates + hint", async () => {
    const h = buildHarness({ initialModel: "gpt-5" })
    const code = await modelCmd.run([], h.ctx)
    expect(code).toBe(0)
    const starLines = h.stdout.split("\n").filter((l) => l.trimStart().startsWith("*"))
    expect(starLines.length).toBe(1)
    expect(starLines[0]).toContain("gpt-5")
    expect(h.stdout).toContain("400k ctx")
    expect(h.stdout).toContain("use: /model <id>")
  })

  test("set non-reasoning model clamps effort + notice", async () => {
    const h = buildHarness({ initialModel: "gpt-5", initialEffort: "high" })
    const code = await modelCmd.run(["gpt-4o"], h.ctx)
    expect(code).toBe(0)
    expect(h.setCalls).toEqual(["gpt-4o"])
    expect(h.effortSetCalls).toEqual(["default"])
    expect(h.stdout).toContain("not supported by gpt-4o")
  })

  test("set reasoning model keeps effort (no clamp)", async () => {
    const h = buildHarness({ initialModel: "gpt-4o", initialEffort: "high" })
    await modelCmd.run(["gpt-5"], h.ctx)
    expect(h.effortSetCalls).toEqual([])
  })

  test("unknown id ⇒ exit 1, no set", async () => {
    const h = buildHarness()
    const code = await modelCmd.run(["o3-mini"], h.ctx)
    expect(code).toBe(1)
    expect(h.stderr).toContain("unknown model 'o3-mini'")
    expect(h.setCalls).toEqual([])
  })

  test("absent slot ⇒ not wired + exit 0", async () => {
    const h = buildHarness({ withModel: false })
    const code = await modelCmd.run([], h.ctx)
    expect(code).toBe(0)
    expect(h.stdout).toContain("not wired in this surface")
  })

  test("complete ⇒ prefix filter", () => {
    const h = buildHarness()
    const hints = modelCmd.complete?.([], "gpt-4", h.ctx) ?? []
    expect(hints.map((x) => x.value)).toEqual(["gpt-4o"])
  })
})

describe("/model command e2e (registered command, via runSlashCommand)", () => {
  test("no-arg ⇒ current model MARKED + candidates + hint line", async () => {
    const h = buildHarness({ initialModel: "gpt-5" })
    const code = await runSlashCommand("/model", h.ctx)
    expect(code).toBe(0)
    expect(h.stdout).toContain("gpt-5")
    expect(h.stdout).toContain("gpt-4o")
    expect(h.stdout).toContain("future-xyz")
    // Current marked with `*` (exactly one body row).
    const starLines = h.stdout.split("\n").filter((l) => l.trimStart().startsWith("*"))
    expect(starLines.length).toBe(1)
    expect(starLines[0]).toContain("gpt-5")
    // Capability hints + window render inline.
    expect(h.stdout).toContain("400k ctx")
    expect(h.stdout).toContain("most capable")
    expect(h.stdout).toContain("lower cost")
    expect(h.stdout).toContain("use: /model <id>")
    expect(h.setCalls).toEqual([])
  })

  test("valid set on a NON-reasoning model ⇒ persist + effort-clamp notice", async () => {
    const h = buildHarness({ initialModel: "gpt-5", initialEffort: "high" })
    const code = await runSlashCommand("/model gpt-4o", h.ctx)
    expect(code).toBe(0)
    expect(h.setCalls).toEqual(["gpt-4o"])
    expect(h.current.value).toBe("gpt-4o")
    expect(h.stdout).toContain("model: gpt-4o")
    // Effort 'high' is unsupported by gpt-4o ⇒ clamped to 'default' + notice.
    expect(h.effortSetCalls).toEqual(["default"])
    expect(h.effort.value).toBe("default")
    expect(h.stdout).toContain("not supported by gpt-4o")
    expect(h.stdout).toContain("clamped to 'default'")
  })

  test("valid set on a REASONING model ⇒ NO clamp (effort untouched)", async () => {
    const h = buildHarness({ initialModel: "gpt-4o", initialEffort: "high" })
    const code = await runSlashCommand("/model gpt-5", h.ctx)
    expect(code).toBe(0)
    expect(h.setCalls).toEqual(["gpt-5"])
    expect(h.effortSetCalls).toEqual([])
    expect(h.effort.value).toBe("high")
    expect(h.stdout).not.toContain("clamped")
  })

  test("case-insensitive arg resolves to the canonical candidate id", async () => {
    const h = buildHarness()
    const code = await runSlashCommand("/model GPT-4O", h.ctx)
    expect(code).toBe(0)
    expect(h.setCalls).toEqual(["gpt-4o"])
  })

  test("unknown id ⇒ 'unknown model' + known list + exit 1, no set", async () => {
    const h = buildHarness()
    const code = await runSlashCommand("/model o3-mini", h.ctx)
    expect(code).toBe(1)
    expect(h.stderr).toContain("unknown model 'o3-mini'")
    expect(h.stderr).toContain("gpt-5")
    expect(h.setCalls).toEqual([])
    expect(h.effortSetCalls).toEqual([])
  })

  test("too many args ⇒ exit 1, no set", async () => {
    const h = buildHarness()
    const code = await runSlashCommand("/model gpt-5 gpt-4o", h.ctx)
    expect(code).toBe(1)
    expect(h.stderr).toContain("at most one argument")
    expect(h.setCalls).toEqual([])
  })

  test("absent slot ⇒ 'not wired in this surface' + exit 0", async () => {
    const h = buildHarness({ withModel: false })
    const code = await runSlashCommand("/model", h.ctx)
    expect(code).toBe(0)
    expect(h.stdout).toContain("/model: not wired in this surface")
    expect(h.stderr).toBe("")
  })

  test("set succeeds even when effort wire is absent (no clamp attempt)", async () => {
    const h = buildHarness({ withEffort: false })
    const code = await runSlashCommand("/model gpt-4o", h.ctx)
    expect(code).toBe(0)
    expect(h.setCalls).toEqual(["gpt-4o"])
    expect(h.stdout).not.toContain("clamped")
  })

  // The surface completer has the Node-readline shape `[matches, line]` and does
  // command-NAME completion only — registration makes `/model` discoverable
  // there. Candidate-id ARGUMENT prefix filtering is a command-body concern,
  // proven end-to-end by the GREEN direct-invocation suite above via
  // `modelCmd.complete`. NOTE: REPL slash-ARGUMENT tab-completion is not wired
  // for ANY command yet — the `.complete` hooks on /effort, /brief,
  // /sticky-model, /model are all unconsumed by the line reader (both the
  // `repl.ts` readline `completer` and the `prompt-pipeline` raw-reader take
  // only `slashCompleter(line)[0]`, the name matches). That latent gap is
  // orthogonal to ticket-14.
  test("tab-complete ⇒ `/model` offered as a name completion after registration", () => {
    const [matches] = slashCompleter("/mod")
    expect(matches).toContain("/model")
  })
})

describe("/model slash drift-guard (registered exactly once in SURFACE layer)", () => {
  test("`/model` registered exactly once across BUILTINS", () => {
    const names = BUILTINS.map((c) => c.name)
    expect(names.filter((n) => n === "/model").length).toBe(1)
  })

  test("`/model` lives in the SURFACE layer (not session/app)", () => {
    expect(SURFACE_SLASH_COMMANDS.some((c) => c.name === "/model")).toBe(true)
  })

  test("`/model` carries a describe + run + complete", () => {
    const cmd = BUILTINS.find((c) => c.name === "/model")
    expect(cmd).toBeDefined()
    expect(typeof cmd?.describe).toBe("string")
    expect(typeof cmd?.run).toBe("function")
    expect(typeof cmd?.complete).toBe("function")
  })
})

// ticket-14 REAL FIX #1+#2 — a REAL `buildModelAdapter` over an in-memory sticky
// store, mode-bound to `plan` (the derivation surface-compose now uses under
// --plan: resolveAgentMode(undefined, true) === 'plan'). This exercises the host
// wiring end-to-end: the SET must write the PLAN key (REAL FIX #2 — not the
// literal "default" the old IIFE bound, which the consume side never reads under
// --plan), and current() must reflect the set via the SYNC SHADOW (REAL FIX #1 —
// no `currentModel` host getter is supplied, exactly as surface-compose builds it,
// so a store read could only return a Promise).
describe("/model real adapter under --plan (buildModelAdapter + real effort)", () => {
  const buildPlanHarness = () => {
    const { routing, store } = fakeModelRouting({
      bootModelId: "gpt-5",
      ids: ["gpt-5", "gpt-4o"],
      mode: () => "plan",
    })
    // No `currentModel` getter — surface-compose does NOT supply one.
    const modelAdapter = buildModelAdapter({
      routing,
      bootModel: "gpt-5",
      candidateIds: () => ["gpt-5", "gpt-4o"],
      currentMode: () => "plan", // resolveAgentMode(undefined, /*planMode*/ true)
    })
    const effortStore = createEffortStore("high")
    let stdout = ""
    let stderr = ""
    const ctx: SlashContext = {
      out: (s) => {
        stdout += s
      },
      err: (s) => {
        stderr += s
      },
      cwd: "/tmp",
      model: modelAdapter,
      effort: {
        get: () => effortStore.get(),
        set: (lvl) => effortStore.set(lvl),
        levels: EFFORT_LEVELS as readonly EffortLevel[],
        budgetTokens: () => undefined,
      },
    }
    return {
      ctx,
      store,
      effortStore,
      modelAdapter,
      get stdout() {
        return stdout
      },
      get stderr() {
        return stderr
      },
    }
  }

  test("set under --plan writes the plan key + current() reflects it", async () => {
    const h = buildPlanHarness()
    expect(h.modelAdapter.current()).toBe("gpt-5") // boot anchor
    const code = await runSlashCommand("/model gpt-4o", h.ctx)
    expect(code).toBe(0)
    // REAL FIX #2 — the SET landed on the PLAN key (the consume side reads it
    // under --plan), NOT a literal "default" key.
    expect(await h.store.get({ mode: "plan", provider: "openai" })).toBe("gpt-4o")
    expect(await h.store.get({ mode: "default", provider: "openai" })).toBeUndefined()
    // REAL FIX #1 — current() reflects the set immediately via the sync shadow.
    expect(h.modelAdapter.current()).toBe("gpt-4o")
  })

  test("no-arg list after a --plan set MARKS the new model", async () => {
    const h = buildPlanHarness()
    await runSlashCommand("/model gpt-4o", h.ctx)
    const code = await runSlashCommand("/model", h.ctx)
    expect(code).toBe(0)
    const starLines = h.stdout.split("\n").filter((l) => l.trimStart().startsWith("*"))
    // Exactly one marked row, and it is the newly-set model (not the boot model).
    expect(starLines.length).toBe(1)
    expect(starLines[0]).toContain("gpt-4o")
  })

  test("set under --plan still clamps the global effort", async () => {
    const h = buildPlanHarness()
    expect(h.effortStore.get()).toBe("high")
    // gpt-4o is non-reasoning ⇒ 'high' unsupported ⇒ clamp to 'default'.
    const code = await runSlashCommand("/model gpt-4o", h.ctx)
    expect(code).toBe(0)
    expect(h.effortStore.get()).toBe("default")
    expect(h.stdout).toContain("not supported by gpt-4o")
  })
})
