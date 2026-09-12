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
 * # Why the SOURCE census is the authority here
 *
 * The manifest names 60 distinct origin modules for its gated rows. A runtime
 * two-way comparison means importing and port-stubbing all 60, and it would
 * still miss MCP-bridged tools built from a runtime handshake. MEASURED: the
 * broadest assemblable fixture reaches 66 of 193 names.
 *
 * The invariant, though, is about what a tool is ALLOWED TO SAY — so the
 * declaration is the right object to check, and the AST census is complete over
 * every tool with a literal name (197 literals). The runtime arms below are the
 * cross-check for the cases a source census cannot reduce.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isMutatingTool, mutatingToolKind } from "@/agent/mode"
import { inferToolTierDetailed } from "@/permission"
import type { Tool } from "@/tool"
import { makeBashTool } from "@/tool/bash"
import {
  HITL_TIERS,
  scanToolPostures,
  scanUnattributedTierDeclarations,
  type ToolPosture,
} from "../../tools/dev/tool-name-literals"
import { assertBroadlyWiredFixture, buildBroadlyWiredTools } from "./_shared/wired-tool-ports"

const REPO_ROOT = new URL("../..", import.meta.url).pathname
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
    const REVIEWED_NON_TOOLS: Readonly<Record<string, string>> = {
      "src/apps/cli/permission-explain.ts":
        "buildToolMeta returns InspectToolMeta — it REPORTS the tier resolveToolTier handed it for a tool found in the registry; it declares nothing",
      "src/permission/inspect.ts":
        "the inspector's result object echoes the resolved tier for the /permission surface; it declares nothing",
    }
    for (const d of unattributed) {
      expect(
        REVIEWED_NON_TOOLS[d.file],
        `${d.file}:${d.line} declares a HITL tier the posture census cannot attribute to a ` +
          `tool name (spreads=${d.spreads} hasNameKey=${d.hasNameKey}). Either give it a ` +
          `literal name so the invariant covers it, or review it here.`,
      ).toBeDefined()
    }
    // The reviewed list must not outlive what it exempts, and each reason must be one.
    const seen = new Set(unattributed.map((d) => d.file))
    for (const [file, why] of Object.entries(REVIEWED_NON_TOOLS)) {
      expect(seen.has(file), `${file} is reviewed but declares no tier any more`).toBe(true)
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

/* ── the runtime cross-check ──────────────────────────────────────────────── */

const PROBE = { command: "echo hi", path: "x.ts", content: "", op: "read" } as never

const tierOf = (t: Tool): string => inferToolTierDetailed(t as never, PROBE).tier

describe("HITL — the assembled registry agrees with the declarations", () => {
  const TOOLS = buildBroadlyWiredTools()

  test("the fixture is intact (an empty set satisfies every loop below)", () => {
    assertBroadlyWiredFixture(TOOLS)
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
    const PROFILES = [
      undefined,
      "off",
      "read-only",
      "workspace-write",
      "workspace-write-net",
      "danger-full-access",
    ] as const
    for (const profile of PROFILES) {
      const tool =
        profile === undefined ? makeBashTool() : makeBashTool({ sandboxProfile: profile })
      expect(tool.isReadOnly(), "bash stopped being write-capable").toBe(false)
      expect(tool.hitlTier?.(PROBE), `bash on profile ${String(profile)}`).not.toBe("none")
      expect(tierOf(tool), `bash on profile ${String(profile)}`).not.toBe("none")
    }
  })

  /**
   * Plan-mode-safe despite being write-capable — the reviewed exceptions.
   *
   * Keyed by name with the REASON, not a bare name list, because this arm found
   * two entries whose paperwork was wrong in opposite directions and a bare
   * exemption would have hidden both.
   */
  const PLAN_MODE_SAFE_DESPITE_WRITE: Readonly<Record<string, string>> = {
    test_runner:
      "running the project's own suite is the canonical inner-loop action; it carries " +
      "hitlTier pre-approval-ok for the same reason, and its resolved command still " +
      "faces the HARD_DENY denylist through the permission policy",
    session_config:
      "only op:set_effort mutates, and it changes an in-session preference with no FS / " +
      "shell / git / network effect; it mirrors the operator /effort slash, which plan " +
      "mode also allows, and every mutation is a visible tool call in the trace",
  }

  test("each plan-mode-safe write-capable tool is a reviewed exception with a reason", () => {
    for (const [name, why] of Object.entries(PLAN_MODE_SAFE_DESPITE_WRITE)) {
      expect(why.split(" ").length, `the reason for ${name} is not a reason`).toBeGreaterThan(12)
    }
    // The exemption list must not outlive what it exempts.
    const assembled = new Set(TOOLS.map((t) => t.name))
    for (const name of Object.keys(PLAN_MODE_SAFE_DESPITE_WRITE)) {
      expect(assembled.has(name), `${name} is exempted but no longer assembled`).toBe(true)
    }
  })

  test("a plan-mode-safe classification implies the tool is actually read-only", () => {
    // My escape declared a write-capable tool plan-mode-safe (`apply_patch_v2: null`
    // in MUTATING_TOOL_TABLE) and nothing noticed, because the table is a
    // hand-maintained name→kind map with no link back to `isReadOnly()`.
    const lies: string[] = []
    for (const t of TOOLS) {
      let classified: boolean
      try {
        isMutatingTool(t.name)
        classified = true
      } catch {
        classified = false
      }
      if (!classified) continue
      if (mutatingToolKind(t.name) === null && !t.isReadOnly()) lies.push(t.name)
    }
    // MEASURED when this arm was written: two, and both had bad paperwork.
    // `test_runner` sat under a `// Read-only built-ins` heading in
    // MUTATING_TOOL_TABLE — false of a tool whose own docstring says "NOT
    // read-only" — with no stated reason for the exemption. `session_config`'s own
    // docstring said "Plan-mode dispatch will block it unless the registry
    // classifies the per-call op, which it does not today", directly contradicting
    // the table entry that allows it. Both corrected in the same commit; neither
    // CLASSIFICATION was changed, because that is a behaviour decision and not a
    // documentation one.
    expect(
      lies.filter((n) => PLAN_MODE_SAFE_DESPITE_WRITE[n] === undefined),
      "a tool is classified null (plan-mode-safe) in MUTATING_TOOL_TABLE while its own " +
        "isReadOnly() says it writes, and it is not a reviewed exception",
    ).toEqual([])
    expect(lies.sort(), "the reviewed exception set drifted").toEqual(
      Object.keys(PLAN_MODE_SAFE_DESPITE_WRITE).sort(),
    )
  })
})
