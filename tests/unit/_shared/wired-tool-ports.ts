/**
 * The broadly-wired `buildDefaultTools` fixture, with an EXHAUSTIVE port plan.
 *
 * # Why the plan is a `Record<keyof DefaultToolPorts, …>` and not an object bag
 *
 * `tests/unit/wired-tools-dispatch-permission-r3-hellgate.test.ts` wired NINE of
 * the thirty ports by hand. An adversarial round used that gap: a write-capable,
 * HITL-exempt tool gated on `notebookEdit` — a port outside the bag — landed with
 * two source files edited, zero test or manifest edits, and
 *
 *   4 gate files                       90 pass / 0 fail
 *   125 HITL/permission/tool files     2419 pass, 1 skip, 0 fail
 *   bun run precommit                  ok — 9 of 9
 *
 * The same probe gated on `structuredPatch` — a port that WAS in the bag — went
 * red. The resistance was a coincidence of which ports someone had remembered.
 *
 * A `satisfies` would not have caught the omission either: it checks the values
 * present, not that every key is present. `Record<keyof DefaultToolPorts, …>` is
 * the shape that makes a NEW port a compile error here until someone decides
 * what this fixture should do with it.
 */
import { expect } from "bun:test"
import { buildDefaultTools, type DefaultToolPorts, type Tool } from "@/tool"

/** What the fixture does with one port. */
export type PortPlan =
  /** A boolean port: pass `true`. */
  | { readonly kind: "on" }
  /** A concrete non-boolean value (an enum member). */
  | { readonly kind: "value"; readonly value: unknown }
  /** A structural stub. Registration only reads the port's PRESENCE; the methods
   *  are reached at execute time, which this fixture never does. */
  | { readonly kind: "stub" }
  /** Deliberately not wired, with the reason. */
  | { readonly kind: "unwired"; readonly why: string }

/**
 * Every port, decided.
 *
 * The three `unwired` entries register NO tool — they change the behaviour of a
 * tool that is already in `BASE_TOOL_NAMES` — so wiring them would add nothing
 * to a census of registered tools. Everything that can add a tool to
 * `buildDefaultTools` is wired. (`containerExec` and `containerWriteFile` feed
 * `buildTerminalTools` instead; the assembled universe in `assembled-tool-universe.ts`
 * builds that too. An earlier version of this line claimed full coverage without it.)
 */
export const PORT_PLAN: Record<keyof DefaultToolPorts, PortPlan> = {
  fs: {
    kind: "unwired",
    why: "swaps the FileSystemPort under read/write/edit, all already in BASE; registers no tool",
  },
  readOutlineParser: {
    kind: "unwired",
    why: "enables read({outline:true}) on the existing read tool; registers no tool",
  },
  diagnostics: {
    kind: "unwired",
    why: "feeds the diagnostics tool, which is already in BASE; registers no tool",
  },
  automationEngine: { kind: "stub" },
  sandboxProfile: { kind: "value", value: "workspace-write" },
  structuredPatch: { kind: "on" },
  coverageCheck: { kind: "on" },
  imageGen: { kind: "stub" },
  officeAuthoring: { kind: "on" },
  notebookEdit: { kind: "on" },
  debugTools: { kind: "on" },
  nodeRepl: { kind: "stub" },
  testRunner: { kind: "on" },
  evidence: { kind: "stub" },
  artifactRegistry: { kind: "stub" },
  askUser: { kind: "stub" },
  reflect: { kind: "stub" },
  fetchRules: { kind: "stub" },
  imageDownsample: { kind: "stub" },
  fileHistory: { kind: "stub" },
  permissionPatternPropose: { kind: "stub" },
  mcpConnectors: { kind: "stub" },
  mcpResources: { kind: "stub" },
  progressUpdate: { kind: "on" },
  ptySession: { kind: "stub" },
  containerExec: { kind: "stub" },
  containerWriteFile: { kind: "stub" },
  codeMode: { kind: "on" },
  appshot: { kind: "stub" },
  projectsKb: { kind: "stub" },
}

/** How many ports this fixture deliberately leaves out. Pinned so a NEW port
 *  cannot be quietly added as `unwired`: adding one moves this number. */
export const UNWIRED_PORT_COUNT = 3

const STUB = {} as never

/** Compose the real port bag from the plan. */
export const portsFromPlan = (plan: Record<keyof DefaultToolPorts, PortPlan>): DefaultToolPorts => {
  const out: Record<string, unknown> = {}
  for (const [key, p] of Object.entries(plan)) {
    if (p.kind === "on") out[key] = true
    else if (p.kind === "value") out[key] = p.value
    else if (p.kind === "stub") out[key] = STUB
  }
  return out as DefaultToolPorts
}

/** `buildDefaultTools` with every port the plan wires. */
export const buildBroadlyWiredTools = (): readonly Tool[] =>
  buildDefaultTools(portsFromPlan(PORT_PLAN))

/**
 * The floor. MEASURED at the commit that introduced this fixture: 66 tools with
 * the full plan, against 26 with no ports at all (an earlier version of this
 * comment said 43; measured, it is 26). A fixture that silently
 * degraded to the base set would still satisfy every "for each tool" assertion.
 */
export const BROADLY_WIRED_FLOOR = 60

/** Assert the fixture is intact — call it from any suite that loops the set. */
export const assertBroadlyWiredFixture = (tools: readonly Tool[]): void => {
  expect(Object.keys(PORT_PLAN).length, "the port plan lost entries").toBeGreaterThanOrEqual(30)
  expect(
    Object.values(PORT_PLAN).filter((p) => p.kind === "unwired").length,
    "an unwired port was added or removed — decide what this fixture does with it",
  ).toBe(UNWIRED_PORT_COUNT)
  for (const [key, p] of Object.entries(PORT_PLAN)) {
    if (p.kind !== "unwired") continue
    expect(
      p.why.split(" ").length,
      `the reason for leaving ${key} unwired is not a reason`,
    ).toBeGreaterThan(4)
  }
  expect(
    tools.length,
    `the fixture assembled ${tools.length} tools — it has degraded toward the base set`,
  ).toBeGreaterThan(BROADLY_WIRED_FLOOR)
  expect(
    tools.length,
    "buildDefaultTools with no ports is 26 — the plan wired nothing",
  ).toBeGreaterThan(buildDefaultTools().length)
}
