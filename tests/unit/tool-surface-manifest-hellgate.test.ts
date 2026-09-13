// Hellgate — tool-surface SSOT two-way drift guard (jun-03).
//
// The manifest (`src/tool/surface/manifest.ts`) is the single managed catalog
// of the LLM tool-access axis. These tests PIN it against the REAL registry +
// the gated tool factories so it cannot silently rot:
//   - BASE: buildDefaultTools() (no ports) === BASE_TOOL_NAMES (exact, sorted).
//   - GATED: each gated factory's produced names === the manifest group for it
//     (two-way: a factory adding/removing a tool without a manifest edit fails).
//   - No duplicate names; the orphan `apply_patch_structured` (which was missing
//     from fc) is now accounted for AND only appears when its port is wired.
//   - The CLI default-ON tool-gate seed is derived from the SSOT, not a parallel
//     list — assert the resolved set.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { createSubagentMailbox } from "@/agent/subagent-mailbox"
import { buildEnterPlanBlock, buildPlanExitBlock } from "@/agent/tier1"
import { createObjectiveCapabilities, createObjectiveStore } from "@/objective"
import { createIntrospectTools, createSubagent6Tools, TaskRegistry } from "@/subagent"
import {
  ALL_MANIFEST_TOOL_NAMES,
  BASE_TOOL_NAMES,
  buildDefaultTools,
  buildTerminalTools,
  entryToolNames,
  GATED_TOOLS,
  seedEnvVarsForSurface,
  shouldSeedOn,
  TOOL_SURFACES,
  type Tool,
  type ToolSurfaceEntry,
} from "@/tool"
import { objectiveTools } from "@/tool/objective"
import { createTmuxAdapter } from "@/tool/pty"
import { subagentMailboxTools } from "@/tool/subagent-mailbox"
import {
  censusFiles,
  extractToolNameLiterals,
  SSOT_FILES,
  scanToolNameLiterals,
  TOOL_SHAPE_KEYS,
} from "../../tools/dev/tool-name-literals"
import { gatherYamlFiles, loadFeatures } from "../../tools/feature-catalog/schema"
import { assembleToolUniverse } from "./_shared/assembled-tool-universe"
import { assertScanPopulation } from "./_shared/scan-population"

// Load the REAL feature catalog once (top-level await, mirrors the pattern in
// feature-catalog-surface-integration.test.ts). Used by the manifest→catalog
// completeness gate below.
/**
 * Tools whose `name` is COMPUTED, so the source census can never see their literal. Each
 * must be minted by the assembled universe instead (`_shared/assembled-tool-universe.ts`).
 * These seven are built by `positionTool` in `src/tool/lsp_nav/index.ts`; they sat
 * uncatalogued until an audit followed a docstring to a runtime-parity gate that did not
 * exist. Pinned exactly, so a stale row cannot hide in "the census cannot see it".
 */
const COMPUTED_NAME_TOOLS: ReadonlySet<string> = new Set([
  "lsp_definition",
  "lsp_hover",
  "lsp_implementation",
  "lsp_incoming_calls",
  "lsp_outgoing_calls",
  "lsp_rename_preview",
  "lsp_type_definition",
])
const ASSEMBLED_NAMES: ReadonlySet<string> = new Set(
  (await assembleToolUniverse()).tools.map((t) => t.name),
)

const CATALOG_DIR = join(import.meta.dir, "..", "..", "tools/feature-catalog/features")
const CATALOG_YAMLS = await gatherYamlFiles(CATALOG_DIR)
assertScanPopulation(CATALOG_YAMLS, CATALOG_DIR, {
  collectable: (name) => name.endsWith(".yaml"),
  id: "tests/unit/tool-surface-manifest-hellgate.test.ts#FEATURE-YAMLS",
})
const CATALOG_FEATURES = await loadFeatures(CATALOG_DIR)
// Full serialized text of every feature — captures config_refs.{env,runtime,cli,
// prefs}, knobs[].name, evidence.code, purpose / notes / surface_integration
// evidence prose. A gate env is "catalogued" iff its EXACT token appears in ANY
// feature's serialized form (the honest "is this gate documented anywhere?"
// question — not tied to one field, so a legitimate cross-reference counts).
const CATALOG_HAYSTACKS = CATALOG_FEATURES.map((f) => JSON.stringify(f))
// WORD-BOUNDARY match, NOT substring: several gate envs are prefixes of siblings
// (QUANTA_SUBAGENT ⊂ QUANTA_SUBAGENT_6TOOLS; QUANTA_LSP ⊂ QUANTA_LSP_TOOLS). A
// naive `.includes(env)` would count `QUANTA_SUBAGENT` as catalogued merely
// because a longer sibling is mentioned — a false pass. Require the token NOT be
// followed by a further env-name char (`[A-Z0-9_]`) so only the exact gate env
// (or a longer env's OWN full mention) satisfies it.
const cataloguedCache = new Map<string, boolean>()
const isCataloguedGateEnv = (envToken: string): boolean => {
  const cached = cataloguedCache.get(envToken)
  if (cached !== undefined) return cached
  // Escape is unnecessary — QUANTA_* tokens are [A-Z0-9_] only.
  const re = new RegExp(`${envToken}(?![A-Z0-9_])`)
  const found = CATALOG_HAYSTACKS.some((h) => re.test(h))
  cataloguedCache.set(envToken, found)
  return found
}

const names = (tools: readonly Tool[]): string[] => tools.map((t) => t.name).sort()
const groupNames = (rep: string): string[] => {
  const entry = GATED_TOOLS.find((e) => e.name === rep)
  if (entry === undefined) throw new Error(`manifest has no entry for "${rep}"`)
  return [...entryToolNames(entry)].sort()
}

describe("tool-surface manifest — BASE drift guard", () => {
  test("buildDefaultTools() (no ports) === BASE_TOOL_NAMES exactly", () => {
    expect(names(buildDefaultTools())).toEqual([...BASE_TOOL_NAMES].sort())
  })

  test("every BASE name is unique and accounted for in the manifest", () => {
    const set = new Set(BASE_TOOL_NAMES)
    expect(set.size).toBe(BASE_TOOL_NAMES.length)
    for (const n of BASE_TOOL_NAMES) expect(ALL_MANIFEST_TOOL_NAMES).toContain(n)
  })
})

describe("tool-surface manifest — no orphans / no dups", () => {
  test("ALL_MANIFEST_TOOL_NAMES has no duplicates", () => {
    const set = new Set(ALL_MANIFEST_TOOL_NAMES)
    expect(set.size).toBe(ALL_MANIFEST_TOOL_NAMES.length)
  })

  test("apply_patch_structured is catalogued (the fc-orphan this SSOT fixes)", () => {
    expect(ALL_MANIFEST_TOOL_NAMES).toContain("apply_patch_structured")
  })

  test("apply_patch_structured registers ONLY when its port is set (byte-identical off)", () => {
    expect(names(buildDefaultTools())).not.toContain("apply_patch_structured")
    expect(names(buildDefaultTools({ structuredPatch: true }))).toContain("apply_patch_structured")
  })
})

describe("tool-surface manifest — terminal:'on' rows are BUILD-PROVEN by buildTerminalTools", () => {
  // Closes the drift-guard blind spot (R1 audit): the full-universe scan proves a `name:"x"`
  // literal is CATALOGUED, but not that any builder EMITS it. A manifest row claiming
  // `default.terminal === "on"` must be produced by the real terminal builder — else the row
  // is a lie. Wire BOTH ports so every terminal-default tool can mint.
  const terminalBuilt = new Set(
    buildTerminalTools({
      containerExec: { exec: async () => ({ stdout: "", stderr: "", code: 0 }) },
      ptySession: createTmuxAdapter({ exec: { run: async () => ({ ok: true, stdout: "" }) } }),
    }).map((t) => t.name),
  )
  const terminalRows = GATED_TOOLS.filter((e) => e.default.terminal === "on")
  // Anti-vacuum: a loop that generates zero tests passes silently. Pin the row count + built size
  // so deleting the terminal:on defaults (or the builder) trips THIS non-looped assertion.
  test("there ARE terminal:on rows and the builder emits them all (not a vacuous loop)", () => {
    expect(terminalRows.length).toBeGreaterThan(0)
    const expected = terminalRows.flatMap((e) => [...entryToolNames(e)])
    expect(expected.length).toBeGreaterThanOrEqual(7) // container_exec + 6 pty_*
    for (const n of expected) expect(terminalBuilt.has(n)).toBe(true)
  })
  for (const entry of terminalRows) {
    for (const toolName of entryToolNames(entry)) {
      test(`buildTerminalTools emits "${toolName}" (manifest row claims terminal:on)`, () => {
        expect(terminalBuilt.has(toolName)).toBe(true)
      })
    }
  }
})

describe("tool-surface manifest — GATED factories match the manifest two-way", () => {
  test("6-tool router names === manifest spawn_agent group", () => {
    const set = createSubagent6Tools({
      runner: async () => ({ ok: true, finalText: "", turns: 0, messages: [] }),
      registry: new TaskRegistry(),
    })
    expect(names(set.tools)).toEqual(groupNames("spawn_agent"))
  })

  test("objective tools === manifest objective_set group", () => {
    // GOAL-02: the trio is built over the actor-fixed model capability + read port.
    // GOAL-03: `objective_verify` joins the group only when the host wired a verifier.
    const caps = createObjectiveCapabilities(createObjectiveStore())
    const verify = {
      verify: async () => ({ kind: "no-checks" as const }),
      reconcile: async () => ({ kind: "no-objective" as const }),
    }
    expect(names(objectiveTools({ model: caps.model, read: caps.read, verify }))).toEqual(
      groupNames("objective_set"),
    )
    expect(names(objectiveTools({ model: caps.model, read: caps.read }))).toEqual(
      groupNames("objective_set").filter((n) => n !== "objective_verify"),
    )
  })

  test("mailbox tools === manifest subagent_send_message group", () => {
    expect(names(subagentMailboxTools(createSubagentMailbox()))).toEqual(
      groupNames("subagent_send_message"),
    )
  })

  test("introspect (enableIntrospect) produces list_agents — in the manifest", () => {
    const tools = createIntrospectTools({ registry: new TaskRegistry(), enableIntrospect: true })
    for (const t of tools) expect(ALL_MANIFEST_TOOL_NAMES).toContain(t.name)
    expect(tools.map((t) => t.name)).toContain("list_agents")
  })

  // R1/R3 audit blind-spot: the plan-lifecycle pair is registered off the
  // `planExitPort` AgentConfig slot (not a DefaultToolPort), so it bypassed the
  // terminal + GATED-factory two-way checks above. Pin BOTH directions here:
  // (a) the builder emits the manifest-catalogued name when the port is wired,
  // (b) it registers NOTHING when the port is absent (default-OFF byte-identical).
  const planExitPortStub = { requestExit: async () => ({ decision: "approved" as const }) }
  test("buildEnterPlanBlock emits enter_plan_mode (catalogued) when planExitPort wired", () => {
    const tool = buildEnterPlanBlock({ planExitPort: planExitPortStub } as never)
    expect(tool?.name).toBe("enter_plan_mode")
    expect(ALL_MANIFEST_TOOL_NAMES).toContain("enter_plan_mode")
  })
  test("buildPlanExitBlock emits request_plan_exit (catalogued) — the paired sibling", () => {
    const tool = buildPlanExitBlock({ planExitPort: planExitPortStub } as never)
    expect(tool?.name).toBe("request_plan_exit")
    expect(ALL_MANIFEST_TOOL_NAMES).toContain("request_plan_exit")
  })
  test("plan-lifecycle pair registers NOTHING without planExitPort (default-OFF, ship as a pair)", () => {
    expect(buildEnterPlanBlock({} as never)).toBeUndefined()
    expect(buildPlanExitBlock({} as never)).toBeUndefined()
  })
})

describe("tool-surface manifest — CLI default-ON seed derives from the SSOT", () => {
  test("search_codebase declares the default lexical wire, not the optional index promotion", () => {
    const entry = GATED_TOOLS.find((e) => e.name === "search_codebase")
    expect(entry).toBeDefined()
    expect(entry?.gate).toEqual({ kind: "config-slot", slot: "searchWire" })
    expect(entry?.default.cli).toBe("on")
    // QUANTA_INDEX controls semantic/hybrid promotion only.  If the manifest
    // grew an env gate here, the CLI seed would incorrectly turn indexing on.
    expect("env" in (entry?.gate ?? {})).toBe(false)
  })

  test("the Skill/ToolSearch row must NOT carry a gate env (it would seed the opt-OUT)", () => {
    // Same hazard as `search_codebase` above, hit for real while cataloguing these
    // two: the first version of the row said `env: "QUANTA_SKILLS"`, and the seed
    // assertion below went red with QUANTA_SKILLS added. `shouldSeedOn` turns a
    // config-slot gate WITH an env into a CLI seed, and the CLI exports its seeded
    // gates into child processes — so it would turn skills ON for surfaces that
    // pass `skillsConfig: undefined` today. QUANTA_SKILLS is the opt-OUT for this
    // slot (`readCliKnob("QUANTA_SKILLS","bool") ?? true` on the CLI,
    // `parseEnvFlag(env.QUANTA_SKILLS, true)` on the web daemon), not the opt-in.
    const entry = GATED_TOOLS.find((e) => e.name === "Skill")
    expect(entry, "the Skill row is gone — the two tools are uncatalogued again").toBeDefined()
    expect(entry?.gate).toEqual({ kind: "config-slot", slot: "skills" })
    expect("env" in (entry?.gate ?? {})).toBe(false)
    expect(entry?.group).toEqual(["ToolSearch"])
    expect(entry?.default.cli).toBe("on")
    expect(entry?.default.web).toBe("on")
    expect(shouldSeedOn(entry as ToolSurfaceEntry, "cli")).toBe(false)
  })

  test("branch_search is catalogued opt-in everywhere and never seeded", () => {
    const entry = GATED_TOOLS.find((e) => e.name === "branch_search")
    expect(entry, "the branch_search row is gone").toBeDefined()
    expect(entry?.risk).toBe("spawns-subagent")
    expect(entry?.default).toEqual({})
    for (const surface of TOOL_SURFACES) {
      expect(shouldSeedOn(entry as ToolSurfaceEntry, surface), `seeded on ${surface}`).toBe(false)
    }
  })

  test("seedEnvVarsForSurface('cli') is exactly the CLI-default-ON tool gates", () => {
    // jun-26 coordination-trio gating: QUANTA_SUBAGENT_MAILBOX / QUANTA_TEAM_PEER_MSG /
    // QUANTA_OBJECTIVE_TOOLS were FLIPPED to opt-in (engagement-UNVERIFIED, frontier
    // ships ONE Task tool), so the CLI no longer auto-seeds them. The remaining
    // spawn-core gates (subagent / 6tools / batch / introspect) stay default-ON.
    expect([...seedEnvVarsForSurface("cli")].sort()).toEqual(
      [
        "QUANTA_COVERAGE_TOOL",
        "QUANTA_ENABLE_STRUCTURED_PATCH",
        "QUANTA_MEMORY", // memory_search/write/update trio — CLI default-ON (ADR-0413)
        "QUANTA_PROMPT_CACHE_STATUS",
        "QUANTA_SIDE_AGENT",
        "QUANTA_SUBAGENT",
        "QUANTA_SUBAGENT_6TOOLS",
        "QUANTA_SUBAGENT_BATCH",
        "QUANTA_SUBAGENT_INTROSPECT",
      ].sort(),
    )
  })

  test("coordination trio (mailbox/team/objective) is NOT auto-seeded on any surface", () => {
    // jun-26 frontier tool-impl audit: these 3 are opt-in EVERYWHERE until a live
    // engagement smoke proves the model uses them. The CLI seed deriving from the
    // SSOT means flipping the manifest default is the ONLY lever — assert the
    // trio's env gates appear in NO surface's seed set (red-on-injection: restoring
    // any trio entry's `cli: "on"` re-introduces its env here and fails this).
    const trio = ["QUANTA_SUBAGENT_MAILBOX", "QUANTA_TEAM_PEER_MSG", "QUANTA_OBJECTIVE_TOOLS"]
    for (const surface of TOOL_SURFACES) {
      const seeded = new Set(seedEnvVarsForSurface(surface))
      for (const env of trio) expect(seeded.has(env)).toBe(false)
    }
  })

  test("coordination trio is opt-in on every surface in the manifest (no `on` default)", () => {
    for (const rep of ["subagent_send_message", "team_create", "objective_set"]) {
      const entry = GATED_TOOLS.find((e) => e.name === rep)
      if (entry === undefined) throw new Error(`manifest has no entry for "${rep}"`)
      for (const surface of TOOL_SURFACES) {
        // explicit `on` is the only state that auto-seeds; the trio must never carry it
        expect(entry.default[surface]).not.toBe("on")
      }
    }
  })

  test("bench surface seeds NOTHING (shared-assembler byte-identity)", () => {
    // objective/mailbox are opt-in on bench; nothing should auto-seed there.
    expect(seedEnvVarsForSurface("bench")).toEqual([])
  })
})

describe("tool-surface manifest — FULL-universe completeness (the guard that was missing)", () => {
  // The original drift guard only checked SPECIFIC factories, so 17 registered
  // tools (advisor/delegate/plan/mcp-tasks/... + 3 ORPHANS) sat uncatalogued.
  // This source-scan pins EVERY `name: "x"` in the tool-defining slices against
  // the manifest, so a new tool — or a new orphan — can never silently escape.
  /**
   * The completeness census.
   *
   * WAS a `grep -rhoE 'name: "[a-z_]+"'` over six hand-curated roots. Four holes,
   * every one measured on this tree:
   *
   *   1. `[a-z_]` excluded digits and uppercase. A tool named `apply_patch_v2`
   *      with `isReadOnly: () => false` and `hitlTier: () => "none"` — strictly
   *      weaker than the `apply_patch` beside it — registered behind a conditional
   *      port with no manifest row, and this file reported 38 pass / 0 fail.
   *      Two source files edited, zero test or manifest edits, `precommit` said
   *      `ok — 9 of 9`. Three real tools were living in that hole.
   *   2. grep read COMMENTS. Prose alone naming `zz_ghost_stale_tool` made the
   *      scan "find" it, masking a stale row; prose naming a DELETED tool
   *      produced a false RED whose natural repair is to ADD a ghost row.
   *   3. `--exclude=<basename>` matched a basename anywhere, not a path.
   *   4. `grep -r` ignored extensions, so the TRACKED
   *      `src/tool/lsp_nav/code-action.ts.tmp` contributed a name.
   *
   * Now an AST census — see `tools/dev/tool-name-literals`, which carries the
   * evidence for each hole. Comments and formatting are not in the AST;
   * exclusion is by PATH; the file list is `git ls-files` filtered to `*.ts`.
   *
   * MEASURED at the commit that wired it: 3430 files, 197 literals, 196 distinct,
   * and the manifest's 193 names are ALL found — the census is a superset by
   * exactly the three tools this commit catalogues, with zero false positives.
   * The three `name:` literals a widened regex would have added and this does not
   * (`Sheet1`, `Enter`, `...`) are excluded structurally: their object literals
   * carry no `TOOL_SHAPE_KEYS` member.
   *
   * STILL INVISIBLE, said rather than implied: a computed name (`name: TOOL_NAME`)
   * and an MCP-bridged tool built from a runtime handshake have no source literal
   * for ANY source instrument to find. That is why this is the cheap backstop and
   * the assembled-registry comparison is the authority.
   */
  const REPO_ROOT = join(import.meta.dir, "..", "..")
  const scanRegisteredToolNames = (): Set<string> =>
    new Set(scanToolNameLiterals(REPO_ROOT).map((h) => h.name))

  test("the manifest's own definition files cannot feed the census", () => {
    // WHY THIS MATTERS. If the manifest's rows reach the census, every catalogued
    // name is "found" by virtue of being catalogued and the reverse direction —
    // no stale manifest row — can never fail. Under the grep that was a fragile
    // `--exclude`: deleting two words from the command string restored the exact
    // vacuity it existed to prevent (one injected stale row: caught 35 pass /
    // 1 fail with the exclusion, silent 36 pass / 0 fail without it), and nothing
    // asserted it.
    //
    // Under the census it is STRUCTURAL, and the path exclusion is now merely
    // defence in depth. MEASURED: `gated-tools.ts` carries 73 raw `name: "x"`
    // literals and the extractor admits ZERO of them, because a manifest row's
    // siblings are `origin` / `gate` / `default` / `risk` / `note` and not one
    // `TOOL_SHAPE_KEYS` member. Stated this way rather than as a
    // "the exclusion has something to exclude" floor, which would be FALSE here —
    // I wrote that floor first and it failed with `Received: 0`.
    for (const f of SSOT_FILES) {
      const hits = extractToolNameLiterals(f, readFileSync(join(REPO_ROOT, f), "utf8"))
      expect(hits, `${f} now feeds the census — the reverse direction is vacuous`).toEqual([])
    }
    // The shape narrowing is load-bearing, so prove it on a manifest row verbatim.
    const row = `const r = { name: "read", origin: "@/tool/read", gate: { kind: "always" },`
    expect(extractToolNameLiterals("src/tool/surface/gated-tools.ts", `${row} }`)).toEqual([])
    // …and the path exclusion is still declared, so a future manifest that DOES
    // inline a tool-shaped literal is out by two independent mechanisms.
    expect(SSOT_FILES).toEqual([
      "src/tool/surface/manifest.ts",
      "src/tool/surface/gated-tools.ts",
      "src/tool/surface/gated-tools-ports.ts",
    ])
    for (const f of SSOT_FILES)
      expect(censusFiles(REPO_ROOT), `${f} is in the file list`).not.toContain(f)
  })

  test("the census reached something, and says how much", () => {
    // A scan that examined nothing reports "no uncatalogued tool" too. The real
    // floor here is the OTHER direction — an empty census fails "no stale rows"
    // with all 193 manifest names — but that couples two tests, so the reach is
    // also stated on its own. MEASURED at the commit that wired this: 3430 files,
    // 197 literals, 196 distinct names.
    const files = censusFiles(REPO_ROOT)
    expect(
      files.length,
      "the census reached almost no files — did git ls-files fail?",
    ).toBeGreaterThan(3000)
    const hits = scanToolNameLiterals(REPO_ROOT)
    expect(hits.length, "the extractor matched almost nothing").toBeGreaterThan(150)
    // Superset, not equality: a literal can legitimately appear in more than one
    // file, and the census is a backstop that may over-report a tool built in a
    // file the manifest groups elsewhere.
    const found = new Set(hits.map((h) => h.name))
    // Every catalogued name the census cannot see must be one the ASSEMBLED universe mints
    // — a computed name the runtime-parity gate vouches for — and that set is pinned, so
    // it cannot quietly absorb a stale row.
    const invisible = ALL_MANIFEST_TOOL_NAMES.filter((n) => !found.has(n)).sort()
    expect(invisible).toEqual([...COMPUTED_NAME_TOOLS].sort())
    for (const n of invisible) {
      expect(ASSEMBLED_NAMES.has(n), `${n} is invisible to the census AND not assembled`).toBe(true)
    }
  })

  test("the census is not scoped to a hand-curated root list", () => {
    // Hole 4. The grep named six roots; `src/agent/branch-search/` and `src/skill/`
    // (minus the one file bolted on after an EARLIER miss) were outside them, and
    // that is where the three uncatalogued tools lived. `buildSkillBlock` mints
    // three tools and only `skill_create` was catalogued — the two siblings from
    // the same builder in the same directory were never added.
    const files = censusFiles(REPO_ROOT)
    for (const f of [
      "src/agent/branch-search/tool.ts",
      "src/skill/skill-tool.ts",
      "src/skill/tool-search.ts",
    ]) {
      expect(files, `${f} is outside the census — the root-list hole is back`).toContain(f)
    }
    // A tracked non-`.ts` file must not contribute. `grep -r` read
    // `src/tool/lsp_nav/code-action.ts.tmp` and counted its `lsp_code_action`.
    expect(files.filter((f) => !f.endsWith(".ts"))).toEqual([])
  })

  /**
   * The extractor's VERDICT on each shape that beat the grep.
   *
   * The old file asserted `expect(SCAN_CMD).toContain("--exclude=…")` — it pinned
   * the command STRING and never the behaviour. That is the assertion whose
   * absence let a digit-named write-capable tool land green.
   */
  describe("the extractor's verdict on the shapes that beat the grep", () => {
    const F = "src/tool/fixture.ts"
    const namesIn = (src: string): string[] => extractToolNameLiterals(F, src).map((h) => h.name)

    test("a digit in the name is found (hole 1 — the live escape)", () => {
      expect(
        namesIn(`export const t = { name: "apply_patch_v2", isReadOnly: () => false }`),
      ).toEqual(["apply_patch_v2"])
    })

    test("an uppercase name is found (hole 1 — Skill / ToolSearch)", () => {
      expect(namesIn(`export const t = { name: "ToolSearch", inputSchema: z.object({}) }`)).toEqual(
        ["ToolSearch"],
      )
    })

    test("a name mentioned only in a comment is NOT found (hole 2, the masking half)", () => {
      const src = [
        `// Historical note: the registry once had \`{ name: "zz_ghost_stale_tool" }\`;`,
        `// it was removed in a refactor.`,
        `/* isReadOnly: () => true, name: "zz_block_comment_tool" */`,
        `export const t = { name: "real_tool", isReadOnly: () => true }`,
      ].join("\n")
      expect(namesIn(src)).toEqual(["real_tool"])
    })

    test("a name with no space after the colon is found (the formatting hole)", () => {
      expect(namesIn(`export const t = {name:"no_space_tool",isReadOnly:()=>true}`)).toEqual([
        "no_space_tool",
      ])
    })

    test("a line-wrapped literal is found (the formatting hole)", () => {
      expect(
        namesIn(`export const t = {\n  name:\n    "wrapped_tool",\n  isReadOnly: () => true,\n}`),
      ).toEqual(["wrapped_tool"])
    })

    test("a `name` on a non-tool object is NOT found (why the census can span all of src)", () => {
      // The three real occurrences on this tree: a spreadsheet tab, a key name, a
      // judge placeholder. A widened regex would have reported all three.
      const src = [
        `const sheet = { name: "Sheet1", rows: [] }`,
        `const key = { name: "Enter", code: 13 }`,
        `const t = { name: "real_tool", hitlTier: () => "none" }`,
      ].join("\n")
      expect(namesIn(src)).toEqual(["real_tool"])
    })

    test("the admitting key is reported, so a widening of TOOL_SHAPE_KEYS is auditable", () => {
      expect(TOOL_SHAPE_KEYS).toContain("isReadOnly")
      const hits = extractToolNameLiterals(
        F,
        `const t = { name: "x", isConcurrencySafe: () => true }`,
      )
      expect(hits.map((h) => h.admittedBy)).toEqual(["isConcurrencySafe"])
    })

    test("a computed name is NOT found, and the census says so rather than implying it", () => {
      // Stated as a KNOWN limit. The runtime-parity gate is the instrument that
      // closes it; a source census cannot.
      expect(namesIn(`const t = { name: TOOL_NAME, isReadOnly: () => true }`)).toEqual([])
    })
  })

  test("every registered tool name is catalogued in the manifest (no uncatalogued tool)", () => {
    const manifest = new Set(ALL_MANIFEST_TOOL_NAMES)
    const uncatalogued = [...scanRegisteredToolNames()].filter((n) => !manifest.has(n)).sort()
    expect(uncatalogued).toEqual([])
  })

  test("every manifest name is a real registered tool (no stale rows)", () => {
    // A row is real if the source census finds its literal OR the assembled builders mint
    // it. The second half exists for the seven LSP tools `positionTool` names at runtime;
    // it is not a general escape — `COMPUTED_NAME_TOOLS` pins exactly which names use it.
    const found = scanRegisteredToolNames()
    const stale = [...new Set(ALL_MANIFEST_TOOL_NAMES)]
      .filter((n) => !found.has(n) && !(COMPUTED_NAME_TOOLS.has(n) && ASSEMBLED_NAMES.has(n)))
      .sort()
    expect(stale).toEqual([])
  })

  test("jun-04 orphan resolution: all 3 former orphans are wired-or-deleted (zero unwired left)", () => {
    // The catalog opened jun-03 with 3 pure orphans (built, never wired). jun-04
    // resolved every one:
    //   - ai_attribution     → DELETED (no backend; only a no-op stub existed).
    //   - coverage_check      → WIRED (config-slot, QUANTA_COVERAGE_TOOL).
    //   - prompt_cache_status → WIRED (config-slot, QUANTA_PROMPT_CACHE_STATUS);
    //       the adapter→StreamEvent→loop cache-bucket feed was also wired so the
    //       observer the tool reads is actually populated.
    expect(ALL_MANIFEST_TOOL_NAMES).not.toContain("ai_attribution")
    expect(scanRegisteredToolNames().has("ai_attribution")).toBe(false)
    expect(GATED_TOOLS.find((e) => e.name === "coverage_check")?.gate.kind).toBe("config-slot")
    expect(GATED_TOOLS.find((e) => e.name === "prompt_cache_status")?.gate.kind).toBe("config-slot")
    expect(GATED_TOOLS.filter((e) => e.gate.kind === "unwired")).toEqual([])
  })

  test("the unwired-orphan catalog mechanism stays available (any future unwired entry must carry a reason)", () => {
    // `unwired` is still a valid catalogued state for a NEW orphan — it keeps the
    // orphan VISIBLE rather than silently dropped. Whenever one exists it must
    // document why it is parked (wire-or-delete decision pending).
    for (const e of GATED_TOOLS) {
      if (e.gate.kind === "unwired") expect(e.gate.reason.length).toBeGreaterThan(0)
    }
  })

  test("coverage_check registers ONLY when DefaultToolPorts.coverageCheck is true (default-OFF)", () => {
    const off = buildDefaultTools().map((t) => t.name)
    expect(off).not.toContain("coverage_check")
    const on = buildDefaultTools({ coverageCheck: true }).map((t) => t.name)
    expect(on).toContain("coverage_check")
  })
})

describe("tool-surface manifest — worktree group is CLI-honest (R4-5 finding #3)", () => {
  // The worktree slot (`AgentConfig.activeWorktreeSlot`) is MINTED at exactly ONE
  // call site — `mintActiveWorktreeSlot` in the CLI repl runtime-context. So the
  // worktree tools are reachable ONLY on the CLI surface; advertising them as
  // `opt-in` on bench/web/ide/headless claimed a capability those surfaces never
  // deliver (a 4-surface false-parity). The manifest must list the worktree group
  // as CLI-only so it does not over-promise.
  const worktreeEntry = () => {
    const e = GATED_TOOLS.find((x) => x.name === "enter_worktree")
    if (e === undefined) throw new Error("manifest has no enter_worktree entry")
    return e
  }

  test("the worktree group advertises availability on the CLI surface ONLY", () => {
    const e = worktreeEntry()
    // The EXPLICIT per-surface availability map names exactly `cli` — the single
    // surface that mints the slot. (Omitted surfaces inherit `opt-in` in the
    // resolver, but the manifest must not assert the others as deliverable.)
    expect(Object.keys(e.default)).toEqual(["cli"])
    expect(e.default.cli).toBe("opt-in")
    // The non-CLI surfaces are NOT explicitly advertised (no mint site there).
    for (const s of TOOL_SURFACES) {
      if (s === "cli") continue
      expect(e.default[s]).toBeUndefined()
    }
  })
})

describe("tool-surface manifest — manifest→CATALOG completeness gate (root-cause, jul-03)", () => {
  // ROOT-CAUSE GATE. The knob-registry completeness ratchet forces every gate
  // env to be DECLARED in a knob registry (discoverability). This is its FEATURE
  // -CATALOG counterpart: every gate env on a real GATED_TOOLS row must also be
  // CATALOGUED — mentioned by some feature yaml (config_refs / evidence / knobs /
  // prose). Together they close the drift that let jul-03 land tools + gates
  // (browser_network, projects_kb, threads_handoff, mcp_read_resource_dir, the
  // B5 presence gate, …) that were WIRED in src but INVISIBLE in the catalog.
  //
  // A NEW landed-but-uncatalogued gate goes RED here automatically → catalog it
  // (add its env to a feature yaml) or, if it is a known backlog stub not yet
  // written up, park it in KNOWN_UNCATALOGUED_GATES with a reason. That list may
  // only ever SHRINK (a decreasing-ceiling burn-down) — a NEW entry is a
  // governance regression, exactly like the knob ratchet's EXCEPTIONS.

  /** Every `gate.env` on a real GATED_TOOLS row (env-flag / config-slot /
   *  resource kinds carry an optional `env`). */
  const gateEnvs = (): string[] => {
    const out = new Set<string>()
    for (const e of GATED_TOOLS) {
      const g = e.gate as { env?: string }
      if (typeof g.env === "string" && g.env.length > 0) out.add(g.env)
    }
    return [...out].sort()
  }

  // PRE-EXISTING uncatalogued gate envs (jul-03 baseline high-water mark). These
  // are real gates whose FEATURE write-up is a known backlog item — NOT part of
  // the jul-03 absorbed-feature drift this gate was built to close. Each must
  // carry a reason. BURN-DOWN ONLY: remove an entry when its feature yaml lands;
  // never add one (a NEW uncatalogued gate is the regression this gate catches).
  const KNOWN_UNCATALOGUED_GATES: ReadonlyMap<string, string> = new Map<string, string>([
    [
      "QUANTA_CONTAINER_EXEC",
      "terminal container_exec gate — declared in the knob-inventory SSOT; a dedicated terminal-surface feature yaml is a backlog item",
    ],
    ["QUANTA_DEBUG_TOOLS", "debug tool group gate — pre-existing, no feature yaml yet"],
    [
      "QUANTA_SHADOW",
      "shadow-workspace checkpoint/rewind tool gate (shadowOdb) — pre-existing, no feature yaml yet (distinct from the catalogued QUANTA_SHADOW_VERIFY knob)",
    ],
    ["QUANTA_SUBAGENT_6TOOLS", "subagent 6-tool router gate — pre-existing, no feature yaml yet"],
    ["QUANTA_SUBAGENT_BG", "subagent background-run gate — pre-existing, no feature yaml yet"],
    [
      "QUANTA_TB_WRITE_TOOL",
      "terminal container_write_file gate (B2 TB lever) — pre-existing, no feature yaml yet",
    ],
    ["QUANTA_TEST_RUNNER", "test_runner tool gate — pre-existing, no feature yaml yet"],
  ])

  test("every GATED_TOOLS gate.env is catalogued in some feature yaml (or a known backlog stub)", () => {
    const uncatalogued = gateEnvs().filter(
      (env) => !isCataloguedGateEnv(env) && !KNOWN_UNCATALOGUED_GATES.has(env),
    )
    if (uncatalogued.length > 0) {
      throw new Error(
        `${uncatalogued.length} gated-tool gate env(s) are WIRED in src but CATALOGUED in NO ` +
          `feature yaml — a landed-but-uncatalogued tool/gate (the jul-03 drift class). ` +
          `Add each to a tools/feature-catalog/features/*.yaml (config_refs.env / evidence / ` +
          `knobs), or park it in KNOWN_UNCATALOGUED_GATES with a reason:\n` +
          uncatalogued.map((e) => `  ${e}`).join("\n"),
      )
    }
    expect(uncatalogued).toEqual([])
  })

  /**
   * The park list gets the three protections its sibling allowlist already has.
   *
   * `knob-registry-completeness-ratchet-hellgate` learned each of these the hard way:
   * a duplicate key (`QUANTA_TB_BEST_OF_N`, keyed twice, the later row silently
   * overwriting a better reason — invisible to every test that reads the Map), an
   * unpinned size (the docblock said "may only ever SHRINK" and nothing enforced it),
   * and a reason threshold of `> 0` that a single space satisfies. Measured on THIS
   * list before the port: an 8th row for an env that is not a gate, a duplicate key,
   * and a reason of `" "` all passed at 36 pass / 0 fail.
   */
  test("KNOWN_UNCATALOGUED_GATES is pinned in size and free of duplicate keys", () => {
    const src = readFileSync(join(import.meta.dir, basename(import.meta.path)), "utf8")
    const block = src.slice(
      src.indexOf("const KNOWN_UNCATALOGUED_GATES: ReadonlyMap<string, string> = new Map"),
    )
    const literalKeys = [...block.matchAll(/^\s*\[\s*"(QUANTA_[A-Z0-9_]+)"/gm)].map(
      (m) => m[1] as string,
    )
    expect(literalKeys.length, "could not parse the park literal").toBeGreaterThan(3)
    const dupes = literalKeys.filter((k, i) => literalKeys.indexOf(k) !== i)
    expect(dupes, "these keys appear twice — the Map keeps only the later row").toEqual([])
    expect(KNOWN_UNCATALOGUED_GATES.size).toBe(literalKeys.length)
    // BURN-DOWN ONLY. The docblock says a new entry is a governance regression;
    // this is what makes that true.
    expect(KNOWN_UNCATALOGUED_GATES.size).toBe(7)
  })

  test("KNOWN_UNCATALOGUED_GATES entries each carry a real reason (no bare parks)", () => {
    for (const [env, reason] of KNOWN_UNCATALOGUED_GATES) {
      // `> 0` let a single space through. The sibling requires 20 after trimming.
      expect(
        reason.trim().length,
        `park for ${env} needs a real reason, not "${reason}"`,
      ).toBeGreaterThanOrEqual(20)
    }
  })

  test("the parked list contains no gate that is ALREADY catalogued (stale-park hygiene)", () => {
    // If a parked env later gets a feature yaml, remove it from the park — else
    // the park masks nothing and rots. This keeps the burn-down honest.
    const staleParks = [...KNOWN_UNCATALOGUED_GATES.keys()].filter((e) => isCataloguedGateEnv(e))
    expect(staleParks).toEqual([])
  })

  // RED-ON-INJECTION: prove the gate actually FIRES for an uncatalogued gate and
  // does NOT vacuously pass. The jul-03 features MUST be catalogued now (they were
  // the drift); a synthetic never-catalogued token MUST read as uncatalogued.
  test("gate catches drift (red-on-injection) and confirms the jul-03 features are catalogued", () => {
    // (a) the newly-catalogued jul-03 absorbed-feature gates read as CATALOGUED —
    //     this is exactly the drift the gate was written to have caught.
    for (const env of [
      "QUANTA_BROWSER_NETWORK",
      "QUANTA_PROJECTS_KB",
      "QUANTA_AUTOMATION", // threads_handoff shares this gate
      "QUANTA_MCP_RESOURCES", // mcp_read_resource_dir + list_resource_templates
      "QUANTA_ARTIFACT_STORE",
      "QUANTA_ASK_USER",
      "QUANTA_CONTROL_REQUEST",
    ]) {
      expect(isCataloguedGateEnv(env), `${env} should be catalogued after the jul-03 fixes`).toBe(
        true,
      )
    }
    // (b) a token that no yaml mentions reads as UNCATALOGUED — proves the check
    //     is not a tautological `true` (mutation: if isCataloguedGateEnv always
    //     returned true this fails).
    expect(isCataloguedGateEnv("QUANTA_NEVER_CATALOGUED_SENTINEL_XYZ")).toBe(false)
  })

  test("catalogued-check is WORD-BOUNDARY, not substring (no prefix-sibling false pass)", () => {
    // QUANTA_SHADOW is uncatalogued even though QUANTA_SHADOW_VERIFY IS catalogued
    // (shadow-verify.yaml) — a naive `.includes("QUANTA_SHADOW")` would falsely
    // pass. This pins the boundary so a prefix env can never be masked by a longer
    // sibling's mention (the exact hole a substring match would leave open).
    expect(isCataloguedGateEnv("QUANTA_SHADOW_VERIFY")).toBe(true)
    expect(isCataloguedGateEnv("QUANTA_SHADOW")).toBe(false)
  })
})
