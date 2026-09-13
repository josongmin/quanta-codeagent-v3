/**
 * Hellgate — a write-capable tool must not be able to DECLARE its way out of HITL.
 *
 * # The hole
 *
 * `inferToolTierDetailed` (`src/permission/policy.ts`) is:
 *
 *   if (confirm) return { tier: "always-confirm", reason: "declared" }
 *   if (explicit) return { tier: explicit, reason: "declared" }
 *   return tool.isReadOnly()
 *     ? { tier: "none", reason: "inferred" }
 *     : { tier: "always-confirm", reason: "needs-sandbox" }
 *
 * `"none"` is a truthy string, so an EXPLICIT `hitlTier: () => "none"`
 * short-circuits the fail-closed branch directly below it. The fail-closed
 * default protects only tools that OMIT `hitlTier`. A tool that declares its way
 * out is never questioned, and `src/agent/hitl-tier-registry.ts` does not help:
 * it ratchets operator OVERRIDES escalate-only, ships zero built-in annotations,
 * and clamps nothing about a tool's own declaration.
 *
 * MEASURED before this file existed. A probe `apply_patch_v2` with
 * `isReadOnly: () => false` and `hitlTier: (): "none" => "none"` — strictly
 * weaker than the `apply_patch` beside it, which is `pre-approval-ok` — passed:
 *
 *   125 HITL / permission / tool test files   2419 pass, 1 skip, 0 fail
 *   bun run precommit                         ok — 9 of 9
 *
 * Every existing assertion on this axis is per-tool
 * (`expect(tool.hitlTier?.(x)).toBe("none")` in advisor-tool-hellgate,
 * ci-finding, reflect-tool-hellgate, …). None loops a set. Today the pairs are
 * consistent — 12 `hitlTier: () => "none"` sites, all 12 with
 * `isReadOnly: () => true`. What was missing is the invariant that keeps them
 * that way.
 *
 * # What each layer here is — corrected
 *
 * This header used to call the SOURCE census "the authority" because the broadest
 * fixture of the time reached 66 of 193 names. Both halves moved. The runtime arms
 * now loop the assembled universe (`_shared/assembled-tool-universe.ts`: 157 of the
 * manifest's 203 names at sep-14; the other 46 are the caller-wire ledger), and
 * 9ec5db85a moved the guarantee into the POLICY: `inferToolTierDetailed` voids a
 * declared "none" on any tool whose `isReadOnly()` is false, whatever shape declares
 * it. The AST census below is an EARLY WARNING over every tool with a literal name —
 * useful because it names the file and line — not the thing that holds the invariant.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { classifiedMutatingKind } from "@/agent/mode"
import { type HITLTier, inferToolTierDetailed } from "@/permission"
import type { OsSandboxProfile } from "@/runtime"
import type { Tool } from "@/tool"
import { makeBashTool } from "@/tool/bash"
import {
  extractToolPostures,
  HITL_TIERS,
  scanToolPostures,
  scanUnattributedTierDeclarations,
  type ToolPosture,
} from "../../tools/dev/tool-name-literals"
import { assembleToolUniverse } from "./_shared/assembled-tool-universe"
import { assertBroadlyWiredFixture, buildBroadlyWiredTools } from "./_shared/wired-tool-ports"

const REPO_ROOT = new URL("../..", import.meta.url).pathname
const UNIVERSE = await assembleToolUniverse()
const POSTURES: readonly ToolPosture[] = scanToolPostures(REPO_ROOT)

/* ── the declaration invariant, over every tool literal in src/ ───────────── */

describe("HITL — a write-capable declaration may not claim tier none", () => {
  test("the census reached the whole tool population", () => {
    // A census of nothing satisfies every "for each" assertion below.
    // MEASURED at the commit that wired this: 197 postures.
    expect(POSTURES.length, "the posture census collapsed").toBeGreaterThan(150)
    expect(
      POSTURES.filter((p) => p.readOnly === "false").length,
      "no write-capable tool was found at all — the isReadOnly reduction broke",
    ).toBeGreaterThan(50)
    expect(
      POSTURES.filter((p) => p.tiers.includes("none")).length,
      "no tier-none declaration was found — the hitlTier reduction broke",
    ).toBeGreaterThan(5)
  })

  test("no `isReadOnly: () => false` tool declares a tier of none", () => {
    const violators = POSTURES.filter(
      (p) => p.readOnly === "false" && p.tiers.includes("none"),
    ).map((p) => `${p.name} (${p.file}:${p.line})`)
    expect(
      violators,
      "a write-capable tool declared hitlTier none. `inferToolTierDetailed` returns a " +
        "DECLARED tier before it ever reaches the isReadOnly fail-closed branch, so this " +
        "tool asks the operator for nothing.",
    ).toEqual([])
  })

  test("every tier literal is in the closed vocabulary", () => {
    // A typo (`"None"`, `"pre-approval"`) silently becomes an UNRECOGNIZED truthy
    // value. `inferToolTierDetailed` keeps the legacy escalation for those, so it
    // is not a security hole — but it is a declaration nobody reads, and it would
    // make the arm above blind to the real spelling.
    const strays = POSTURES.flatMap((p) =>
      p.tiers.filter((t) => !HITL_TIERS.includes(t)).map((t) => `${p.name}: ${t}`),
    )
    expect(strays).toEqual([])
  })

  test("the tier-none population is an exact, reviewed set", () => {
    // Pinned by NAME, not counted. A count lets one tool leave and another arrive
    // unreviewed. Each of these is read-only; two are self-reports the type system
    // cannot check and the manifest documents the reasoning: `fork_session` claims
    // read-only while forking a session, `projects_kb` claims read-only while
    // carrying a project_write op (justified as in-session-store-only).
    const names = POSTURES.filter((p) => p.tiers.includes("none"))
      .map((p) => p.name)
      .sort()
    expect(names).toEqual([
      "advisor",
      "ask_user",
      "ci_finding",
      "fetch_rules",
      "fork_session",
      "gh_pr_code_tour",
      "git_compose_commit",
      "git_compose_pr",
      "git_review_diff",
      "projects_kb",
      "reflect",
      "report_agent_job_result",
    ])
    for (const p of POSTURES.filter((x) => x.tiers.includes("none"))) {
      expect(p.readOnly, `${p.name} declares tier none without isReadOnly: () => true`).toBe("true")
    }
  })

  test("a hitlTier the census cannot reduce is named, with the reason it is safe", () => {
    // `dynamic` is its own answer, not a synonym for assume-safe. Exactly one tool
    // returns a tier the AST cannot reduce to a literal, and the runtime arm below
    // discharges it rather than an allowlist asserting it.
    const unresolved = POSTURES.filter((p) => p.tierDynamic && p.tiers.length === 0).map(
      (p) => p.name,
    )
    expect(unresolved).toEqual(["bash"])
  })

  test("every tier declaration the census cannot attribute is a reviewed non-tool", () => {
    // THE CENSUS IS NOT TOTAL, and this arm is what keeps that honest. It keys on a
    // `name` STRING LITERAL, so a tool built by a generic factory with a computed
    // name is invisible: `make(name, description, schema, readOnly, …)` in
    // `src/subagent/agent-tools-6.ts` builds the six router tools that way.
    //
    // Those six are safe STRUCTURALLY, not luckily: that factory takes no
    // `hitlTier` parameter and sets none, so `inferToolTierDetailed` falls through
    // to the `isReadOnly()` fail-closed branch. Give the factory a `hitlTier`
    // parameter and this arm is what notices.
    const unattributed = scanUnattributedTierDeclarations(REPO_ROOT)
    // Keyed by file WITH AN EXACT COUNT. Keyed by file alone, an audit appended a
    // const-named, write-capable, tier-none tool to `src/permission/inspect.ts`: the scan
    // reported a new declaration at L436, and the gate stayed green because the file was
    // already reviewed.
    const REVIEWED_NON_TOOLS: Readonly<Record<string, { count: number; why: string }>> = {
      "src/apps/cli/permission-explain.ts": {
        count: 1,
        why: "buildToolMeta returns InspectToolMeta — it REPORTS the tier resolveToolTier handed it for a tool found in the registry; it declares nothing",
      },
      "src/permission/inspect.ts": {
        count: 1,
        why: "the inspector's result object echoes the resolved tier for the /permission surface; it declares nothing",
      },
    }
    const perFile = new Map<string, number>()
    for (const d of unattributed) perFile.set(d.file, (perFile.get(d.file) ?? 0) + 1)
    for (const d of unattributed) {
      expect(
        REVIEWED_NON_TOOLS[d.file],
        `${d.file}:${d.line} declares a HITL tier the posture census cannot attribute to a ` +
          `tool name (spreads=${d.spreads} hasNameKey=${d.hasNameKey}). Either give it a ` +
          `literal name so the invariant covers it, or review it here.`,
      ).toBeDefined()
    }
    for (const [file, { count, why }] of Object.entries(REVIEWED_NON_TOOLS)) {
      expect(
        perFile.get(file) ?? 0,
        `${file}: reviewed ${count}, found ${perFile.get(file) ?? 0}`,
      ).toBe(count)
      expect(why.split(" ").length, `the reason for ${file} is not a reason`).toBeGreaterThan(10)
    }
    // The 6-tool router's factory must stay tier-free — the structural reason above.
    const factory = readFileSync(join(REPO_ROOT, "src/subagent/agent-tools-6.ts"), "utf8")
    expect(
      factory.includes("hitlTier"),
      "agent-tools-6.ts now mentions hitlTier. Its `make` factory builds six tools with " +
        "COMPUTED names, so a tier set there is invisible to the posture census.",
    ).toBe(false)
  })

  test("a tool literal without isReadOnly is a CONTRACT, not a tool object", () => {
    // Six literals carry a name + inputSchema and no `isReadOnly`. All six are
    // entries in `SUBAGENT_6_TOOL_CONTRACTS` — declarations of the 6-tool router's
    // wire contract, whose real tool objects are built elsewhere. Pinned so a real
    // tool that FORGETS isReadOnly cannot hide in this bucket: `ToolCore` requires
    // the member, so a missing one means the literal is not a tool.
    const absent = POSTURES.filter((p) => p.readOnly === "absent")
    expect(absent.map((p) => p.file).filter((f) => f !== "src/subagent/tools-6.ts")).toEqual([])
    expect(absent.map((p) => p.name).sort()).toEqual([
      "close_agent",
      "exec_command",
      "send_input",
      "spawn_agent",
      "wait_agent",
      "write_stdin",
    ])
  })
})

/* ── the posture extractor's verdict on the shapes that beat it ───────────── */

describe("HITL — the posture census reads the shapes an audit used to escape it", () => {
  // 22 shapes got a write-capable tier-none tool past the first census. The POLICY now
  // voids that declaration whatever its shape, so these are about the census's accuracy
  // as an early warning: each shape is either reduced exactly, or reported as dynamic
  // with nothing reduced, so the unresolved arm names it.
  const one = (src: string): ToolPosture => {
    const hits = extractToolPostures("src/tool/fixture.ts", src)
    expect(hits.length, `expected one posture in: ${src}`).toBe(1)
    return hits[0] as ToolPosture
  }

  test("method shorthand is reduced exactly", () => {
    const p = one(
      `const t = { name: "m", isReadOnly() { return false }, hitlTier() { return "none" } }`,
    )
    expect([p.readOnly, p.tiers, p.tierDynamic]).toEqual(["false", ["none"], false])
  })

  test("a block-bodied arrow with a single return is reduced exactly", () => {
    const p = one(
      `const t = { name: "b", isReadOnly: () => { return false }, hitlTier: () => { return "none" } }`,
    )
    expect([p.readOnly, p.tiers, p.tierDynamic]).toEqual(["false", ["none"], false])
  })

  test("a computed string key is the same key", () => {
    const p = one(
      `const t = { name: "c", ["isReadOnly"]: () => false, ["hitlTier"]: () => "none" }`,
    )
    expect([p.readOnly, p.tiers]).toEqual(["false", ["none"]])
  })

  test("a class with methods is read", () => {
    const p = one(
      `class K { name = "k"; isReadOnly() { return false } hitlTier() { return "none" as const } }`,
    )
    expect([p.readOnly, p.tiers, p.tierDynamic]).toEqual(["false", ["none"], false])
  })

  test("a tier held in a module const reduces to NOTHING and is reported dynamic", () => {
    // The apply_patch escape: `(input) => blank ? "pre-approval-ok" : PATCH_TIER`. The
    // census collects "pre-approval-ok" as a lower bound and cannot see PATCH_TIER — so it
    // must say dynamic, never claim the set is complete.
    const p = one(
      `const t = { name: "k2", isReadOnly: () => false, hitlTier: (i) => (i ? "pre-approval-ok" : PATCH_TIER) }`,
    )
    expect(p.tierDynamic).toBe(true)
    expect(p.tiers).toEqual(["pre-approval-ok"])
  })

  test("a shorthand `{ hitlTier }` is declared-but-unreducible", () => {
    const p = one(`const t = { name: "s", isReadOnly: () => false, hitlTier }`)
    expect([p.hasHitlTier, p.tierDynamic, p.tiers]).toEqual([true, true, []])
  })
})

/* ── the runtime cross-check ──────────────────────────────────────────────── */

const PROBE = { command: "echo hi", path: "x.ts", content: "", op: "read" } as never

const tierOf = (t: Tool): string => inferToolTierDetailed(t as never, PROBE).tier

describe("HITL — the assembled registry agrees with the declarations", () => {
  // The ASSEMBLED universe, not only `buildDefaultTools`: an audit found `container_exec`
  // and `container_write_file` never reached these arms, because their ports feed
  // `buildTerminalTools`, and the fixture's docstring said everything that could add a
  // tool was wired.
  const TOOLS = UNIVERSE.tools

  test("the fixture is intact (an empty set satisfies every loop below)", () => {
    assertBroadlyWiredFixture(buildBroadlyWiredTools())
    expect(TOOLS.length, "the assembled universe collapsed").toBeGreaterThan(140)
    for (const name of ["container_exec", "container_write_file"]) {
      expect(
        TOOLS.some((t) => t.name === name),
        `${name} is not assembled`,
      ).toBe(true)
    }
  })

  test("no assembled write-capable tool resolves to tier none", () => {
    const violators = TOOLS.filter((t) => !t.isReadOnly() && tierOf(t) === "none").map(
      (t) => t.name,
    )
    expect(violators).toEqual([])
  })

  test("bash is never tier none, on any sandbox profile", () => {
    // The one declaration the source census cannot reduce: `hitlTier: () => tier`
    // where `tier = tierForProfile(opts.sandboxProfile)`. That is an exhaustive
    // switch returning only pre-approval-ok or always-confirm — asserted here
    // rather than read once and trusted.
    // EXHAUSTIVE by type, not by memory: an audit added a `"workspace-write-audit"` member
    // to `SandboxProfile` with `tierForProfile` returning "none" for it, and this arm —
    // then a hand-typed array — stayed green. A `Record` over the union is a compile
    // error until the new profile is listed here.
    const PROFILE_PLAN: Record<OsSandboxProfile, true> = {
      off: true,
      "read-only": true,
      "workspace-write": true,
      "workspace-write-net": true,
      "danger-full-access": true,
    }
    const PROFILES = [undefined, ...(Object.keys(PROFILE_PLAN) as OsSandboxProfile[])]
    for (const profile of PROFILES) {
      const tool =
        profile === undefined ? makeBashTool() : makeBashTool({ sandboxProfile: profile })
      expect(tool.isReadOnly(), "bash stopped being write-capable").toBe(false)
      expect(tool.hitlTier?.(PROBE), `bash on profile ${String(profile)}`).not.toBe("none")
      expect(tierOf(tool), `bash on profile ${String(profile)}`).not.toBe("none")
    }
  })

  test("a plan-mode-safe classification implies the tool is actually read-only (assembled)", () => {
    // My escape declared a write-capable tool plan-mode-safe (`apply_patch_v2: null`
    // in MUTATING_TOOL_TABLE) and nothing noticed: the table is a hand-maintained
    // name→kind map with no link back to `isReadOnly()`.
    //
    // WHY THERE IS NO EXEMPTION LIST ANY MORE. This arm used to carry two reviewed
    // exceptions, `test_runner` and `session_config`. An adversarial audit showed the
    // reasons were false in the posture that mattered. Plan mode has two layers: the
    // admissibility gate blocks every non-read-only tool when the live AGENT mode is
    // `plan`, while `consultPlanModeSeam` consults only this table when
    // `collaborationMode` is `plan`. A write-capable `null` row is therefore a write
    // exemption for the weaker layer alone — measured: `test_runner` ran
    // `echo pwned > src/x.ts` with zero confirms there. Both are classified mutating
    // now, and the invariant is strict.
    const lies = TOOLS.filter(
      (t) => classifiedMutatingKind(t.name) === null && !t.isReadOnly(),
    ).map((t) => t.name)
    expect(
      lies,
      "a tool is classified null (plan-mode-safe) in MUTATING_TOOL_TABLE while its own " +
        "isReadOnly() says it writes — the collaboration-mode plan layer will let it run",
    ).toEqual([])
  })

  test("the same invariant over EVERY tool literal in src/, not just the assembled universe", () => {
    // The assembled universe does not reach the caller-wire ledger's names. The source
    // census reaches every tool with a literal name, so the plan-mode row of a
    // write-capable tool no fixture builds is checked here too.
    const writeCapableNull = POSTURES.filter(
      (p) => p.readOnly === "false" && classifiedMutatingKind(p.name) === null,
    ).map((p) => `${p.name} (${p.file}:${p.line})`)
    expect(writeCapableNull).toEqual([])
    // …and the converse: a tool that SAYS read-only while its row says it mutates. Both plan
    // layers and the policy key on `isReadOnly()`, so the row would be dead. The runtime
    // parity gate checks both directions only for ASSEMBLED tools; a caller-wire ledger
    // tool flipped to `isReadOnly: () => true` passed every gate (round-9 audit).
    const readOnlyWithMutatingRow = POSTURES.filter((p) => {
      const kind = classifiedMutatingKind(p.name)
      return p.readOnly === "true" && kind !== null && kind !== undefined
    }).map((p) => `${p.name} (${p.file}:${p.line}, row=${classifiedMutatingKind(p.name)})`)
    expect(readOnlyWithMutatingRow).toEqual([])
    // Anti-vacuity: the arm must actually meet write-capable tools that HAVE a row.
    expect(
      POSTURES.filter((p) => p.readOnly === "false" && classifiedMutatingKind(p.name) !== undefined)
        .length,
    ).toBeGreaterThan(50)
  })
})

/* ── the enforcement: the policy, not a census ────────────────────────────── */

describe("HITL — the POLICY voids a writer's declared none, whatever shape declares it", () => {
  // The census above is an EARLY WARNING. It cannot be the guarantee: whether a function
  // can return "none" is not decidable from its source, and an adversarial audit made the
  // always-on `apply_patch` and `bash` resolve to "none" for real inputs (a ternary keyed
  // on the input, a module const for the tier) with both source hellgates, typecheck,
  // lint and 2255 HITL/permission/tool tests green. `inferToolTierDetailed` now treats a
  // declared "none" on a write-capable tool as no declaration at all.
  const NONE = "none" as const
  const SHAPES: ReadonlyArray<
    readonly [string, { isReadOnly(): boolean; hitlTier(i: unknown): HITLTier }]
  > = [
    ["arrow literal", { isReadOnly: () => false, hitlTier: () => "none" }],
    [
      "method shorthand",
      {
        isReadOnly: () => false,
        hitlTier() {
          return "none"
        },
      },
    ],
    ["module const", { isReadOnly: () => false, hitlTier: () => NONE }],
    [
      "input-conditional (the apply_patch escape)",
      {
        isReadOnly: () => false,
        hitlTier: (i: unknown) =>
          ((i as { patch?: string } | undefined)?.patch ?? "") === "" ? "pre-approval-ok" : NONE,
      },
    ],
    [
      "class instance",
      new (class {
        isReadOnly(): boolean {
          return false
        }
        hitlTier(): HITLTier {
          return "none"
        }
      })(),
    ],
  ]

  for (const [label, tool] of SHAPES) {
    test(`${label}: a writer declaring none resolves exactly as an undeclared writer`, () => {
      const input = { patch: "*** Begin Patch\n*** Update File: a.ts\n", command: "npm run x" }
      expect(tool.hitlTier(input), "the probe must really declare none").toBe("none")
      expect(inferToolTierDetailed(tool as never, input)).toEqual({
        tier: "always-confirm",
        reason: "needs-sandbox",
      })
    })
  }

  test("the real apply_patch and bash, rewired the way the audit did, are clamped", () => {
    const TOOLS_BY_NAME = new Map(buildBroadlyWiredTools().map((t) => [t.name, t]))
    for (const name of ["apply_patch", "bash"]) {
      const real = TOOLS_BY_NAME.get(name)
      expect(real, `${name} is not assembled`).toBeDefined()
      const rewired = { ...(real as Tool), hitlTier: (): HITLTier => NONE }
      expect(rewired.isReadOnly()).toBe(false)
      expect(inferToolTierDetailed(rewired as never, { command: "npm run x" }).tier).not.toBe(
        "none",
      )
    }
  })

  test("PAIRED CONTROL: a read-only tool's declared none stands", () => {
    // Without this the clamp could be "none never survives", which would put every
    // read-only tool behind a prompt.
    expect(
      inferToolTierDetailed({ isReadOnly: () => true, hitlTier: () => "none" } as never, {}),
    ).toEqual({ tier: "none", reason: "declared" })
  })

  test("PAIRED CONTROL: a writer's other declarations are untouched", () => {
    for (const tier of ["pre-approval-ok", "always-confirm", "hand-off-required"] as const) {
      expect(
        inferToolTierDetailed({ isReadOnly: () => false, hitlTier: () => tier } as never, {}),
      ).toEqual({ tier, reason: "declared" })
    }
  })
})
