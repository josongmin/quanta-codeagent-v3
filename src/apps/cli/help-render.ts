/** `/help` unified menu — slash inventory + keybinds + ENV knobs.
 *
 *  Design contract:
 *   - **Slash inventory is DYNAMIC**: iterates the live `BUILTINS` array so a
 *     newly-appended command shows up here without editing this file. Virtual
 *     `/exit`+`/quit` (short-circuited by `composePromptPipeline` BEFORE slash
 *     dispatch) and `/image` (intercepted by `dispatchReplSlash` because the
 *     queue is REPL-scoped surface state) are appended as a fixed tail.
 *   - **Slash inventory is GROUPED**: `SlashCommand.category` literal union
 *     drives section headers. Absent ⇒ "other" bucket. Within each group
 *     entries are sorted alphabetically so a freshly-appended BUILTINS row
 *     lands in a stable spot.
 *   - **Keybinds are DERIVED from `keybind-truth.ts`** (WS-E jul-10,
 *     UUX-2-02/1-09): one row per KEYBIND_TRUTH entry — the SSOT the welcome
 *     banner footer also renders from. The hand-written table this replaced
 *     shipped Ctrl+C/Esc-Esc INVERTED and covered 5 of 21+ real bindings;
 *     `help-keybind-truth.hellgate` pins render ⟷ SSOT parity.
 *   - **ENV knobs are DERIVED from `runtimeConfig()` SSOT ∪ CLI-seeded
 *     gates**: one row per field in `RuntimeConfig` so adding an env var
 *     auto-shows here. The env-name string lives in
 *     `runtime-config.ts#loadFromEnv` (the parser) — we mirror it 1:1 in
 *     `ENV_TABLE` below and the test pins the coverage (≥ 5 SSOT-routed
 *     knobs surfaced). Capped to the SSOT vocabulary (~30); the long tail of
 *     surface-level `QUANTA_*` toggles lives in `docs/`. PLUS (WS-E jul-10,
 *     UUX-1-09/6-26) one derived row per `CLI_FEATURE_GATES` seed the CLI
 *     turns default-ON — `help-env-seeded-gates-parity.hellgate` pins every
 *     seeded gate surfaces exactly once (rows for gates already curated in
 *     `ENV_TABLE` are NOT duplicated).
 *   - **Color policy via `wrap` helpers in `@/ui/ui-helpers`**: `setColorPolicy
 *     ("off")` ⇒ plain ASCII byte-identical to a non-TTY render. Tests rely on
 *     this for the OFF-vs-ON pair.
 *   - **Slice discipline**: lives in `src/apps/cli`. Imports `@/ui/ui-helpers`
 *     (allowed) and `./slash-commands` (sibling). No agent / LLM imports.
 *
 *  Why a separate file (vs inline in slash-commands.ts):
 *   - slash-commands.ts is already 475 LOC; the unified menu is a self-
 *     contained renderer that benefits from isolated unit tests against a
 *     pure `renderHelp(BUILTINS)` entry point without spinning up the full
 *     slash dispatch.
 *   - `runHelpRender` (the SlashCommand callback) is a 4-line shim that
 *     delegates to `renderHelp`, keeping the registry entry trivial.
 */

import { byteCompare } from "@/shared/byte-compare"
import { bold, cyan, dim, renderBox } from "@/ui/ui-helpers"
import { CLI_SEEDED_GATES } from "./cli-seeded-gates"
import { KEYBIND_TRUTH, type KeybindTruth } from "./keybind-truth"
import type { UnifiedKnob } from "./knob-catalog-wire"
import type { SlashCommand, SlashContext } from "./slash-commands"
import { slashRef } from "./slash-ref"

/** Virtual REPL commands (short-circuited by `composePromptPipeline` BEFORE the
 *  BUILTINS dispatch — not `SlashCommand` entries, but a user pressing
 *  `/help` expects them in the listing). Kept in sync by hand with
 *  slash-commands.ts (single source of truth would be cross-slice churn).
 *  `/image` is also virtual — it lives in `dispatchReplSlash` because its
 *  queue is REPL-scoped (the surface-agnostic BUILTINS table has no session
 *  context); see `repl.ts#dispatchReplSlash` for the interception site. */
const VIRTUAL_COMMANDS: readonly { readonly name: string; readonly describe: string }[] = [
  { name: "/exit, /quit", describe: "Leave REPL" },
  {
    name: "/image",
    describe: "Manage image queue: /image add <path> | /image list | /image clear (virtual)",
  },
] as const

/** Keybind rows derive from the `keybind-truth.ts` SSOT (WS-E jul-10) — a
 *  chord renders here iff it has an installed handler (FSM chord or reader
 *  `onKey` branch). `during-turn` entries carry an explicit scope suffix so
 *  the operator knows Esc-Esc/Ctrl+B are live while a turn streams, not at
 *  the prompt. */
const keybindRow = (kb: KeybindTruth): { readonly key: string; readonly describe: string } => ({
  key: kb.chord,
  describe: kb.scope === "during-turn" ? `${kb.describe} (during turn)` : kb.describe,
})

const KEYBINDS: readonly { readonly key: string; readonly describe: string }[] =
  KEYBIND_TRUTH.map(keybindRow)

/** SSOT-routed env-var table: one row per field in `RuntimeConfig`. The
 *  `defaultLabel` column reflects the parsed default (what `runtimeConfig()`
 *  returns when the var is absent) — NOT a duplicate of the env value. Any
 *  new field in `runtime-config.ts#RuntimeConfig` should append a row here;
 *  the unit test verifies a floor of ≥ 5 entries surface so the section
 *  cannot silently empty out. Surface-level vars not routed through the SSOT
 *  (e.g. `QUANTA_PROVIDER`, `QUANTA_MODEL`, `QUANTA_PLAN`, ~120 others) live
 *  in `docs/` and are intentionally not enumerated here. */
export interface EnvRow {
  readonly key: string
  readonly defaultLabel: string
  readonly describe: string
}

/** The curated `--help` env rows. Exported so the drift-guard hellgate
 *  (`help-env-catalog-drift-hellgate.test.ts`) can assert every row still
 *  maps to a live knob in `buildKnobCatalog()`. */
export const ENV_TABLE: readonly EnvRow[] = [
  {
    key: "QUANTA_GOAL",
    defaultLabel: "on",
    describe: "Durable multi-turn goal preset ('0' to disable /goal and pursuit)",
  },
  { key: "QUANTA_LOG_LEVEL", defaultLabel: "info", describe: "debug|info|warn|error" },
  {
    key: "QUANTA_COMPACT_TOKENS",
    defaultLabel: "(auto)",
    describe: "Compaction threshold (tokens)",
  },
  { key: "QUANTA_FS_JAIL", defaultLabel: "on", describe: "Filesystem jail (set 'off' to disable)" },
  { key: "QUANTA_CAP_ENFORCE", defaultLabel: "off", describe: "Cap-as-instruction dispatch guard" },
  { key: "QUANTA_GIT_SHA", defaultLabel: "(unset)", describe: "Trajectory producer git sha stamp" },
  {
    key: "QUANTA_PRICING_VERSION",
    defaultLabel: "(auto)",
    describe: "Trajectory pricing version pin",
  },
  {
    key: "QUANTA_SESSIONS_DIR",
    defaultLabel: "~/.quanta/sessions",
    describe: "Sessions root override",
  },
  {
    key: "QUANTA_HITL_OVERRIDES",
    defaultLabel: "~/.quanta/hitl-overrides.json",
    describe: "HITL overrides JSON path",
  },
  { key: "QUANTA_TOOL_OUTPUT_MAX", defaultLabel: "(auto)", describe: "Tool output cap (chars)" },
  {
    key: "QUANTA_TOOL_OUTPUT_SPILL_KEEP",
    defaultLabel: "(auto)",
    describe: "Spilled-output retention",
  },
  {
    key: "QUANTA_LLM_STREAM_FIRST_CHUNK_MS",
    defaultLabel: "60000",
    describe: "LLM first-chunk timeout",
  },
  {
    key: "QUANTA_LLM_STREAM_IDLE_MS",
    defaultLabel: "120000",
    describe: "LLM inter-chunk idle timeout",
  },
  { key: "QUANTA_HOME", defaultLabel: "~/.quanta", describe: "Quanta home override" },
  {
    key: "QUANTA_EFFORT",
    defaultLabel: "default",
    describe: "Session reasoning effort (default|low|medium|high|max) — switch with /effort",
  },
  {
    key: "QUANTA_BRIEF",
    defaultLabel: "off",
    describe:
      "Brief mode — condensed final prose (correctness reporting kept) — toggle with /brief",
  },
  { key: "QUANTA_BENCH_HOME", defaultLabel: "(auto)", describe: "Bench artifacts root" },
  {
    key: "QUANTA_BENCH_CACHE_PATHSPECS_EXTRA",
    defaultLabel: "(empty)",
    describe: "Extra cache dir names (CSV)",
  },
  {
    key: "QUANTA_DEDUP_ENV_PREFIXES_EXTRA",
    defaultLabel: "(empty)",
    describe: "Extra env regimes (CSV)",
  },
  {
    key: "QUANTA_PERMISSION_STATE",
    defaultLabel: "(auto)",
    describe: "Permission state-file override",
  },
  {
    key: "QUANTA_SWEBENCH_CACHE_LEVEL",
    defaultLabel: "env",
    describe: "none|base|env|instance",
  },
  { key: "QUANTA_SWEBENCH_CLEAN", defaultLabel: "off", describe: "SWE-bench --clean flag" },
  {
    key: "QUANTA_SWEBENCH_MAX_WORKERS",
    defaultLabel: "(auto)",
    describe: "SWE-bench grading parallelism",
  },
  {
    key: "QUANTA_SWEBENCH_NAMESPACE",
    defaultLabel: "(auto)",
    describe: "SWE-bench image namespace",
  },
  {
    key: "QUANTA_SWEBENCH_FORCE_REBUILD",
    defaultLabel: "off",
    describe: "SWE-bench --force_rebuild",
  },
  {
    key: "QUANTA_SWEBENCH_PYTHON_BIN",
    defaultLabel: "(probe)",
    describe: "Explicit python for SWE-bench",
  },
  { key: "QUANTA_BENCH_TIMEOUT_MS", defaultLabel: "120000", describe: "Per-instance wall-clock" },
  { key: "QUANTA_MAX_TURNS", defaultLabel: "(preset)", describe: "Max turns per instance" },
  {
    key: "QUANTA_SWEBENCH_PREPARE_FORCE",
    defaultLabel: "off",
    describe: "Force arm64 prepare-images",
  },
  { key: "QUANTA_RUN_ID", defaultLabel: "(minted)", describe: "Pinned bench run id" },
  { key: "QUANTA_PREFS_HOME", defaultLabel: "(home)", describe: "Preferences home override" },
  { key: "QUANTA_LAST_TOKENS", defaultLabel: "(unset)", describe: "Last-reported token count" },
  {
    key: "QUANTA_SESSION_LIST_FORMAT",
    defaultLabel: "(tty:rich)",
    describe: "rich|plain",
  },
  {
    key: "QUANTA_SESSION_LIST_MAX",
    defaultLabel: "10",
    describe: "Rich session-list cap",
  },
  // ADR-0470..0476 R3 default-OFF gates routed through `RuntimeConfig` (strict
  // `=== "1"` opt-in). Default false ⇒ byte-identical; surfaced here per the
  // file's "one row per RuntimeConfig field" contract.
  {
    key: "QUANTA_SKILL_MCP_DEPS",
    defaultLabel: "off",
    describe: "ADR-0476 skill→MCP auto-attach gate ('1' to enable)",
  },
  {
    key: "QUANTA_BG_COMPACTION",
    defaultLabel: "off",
    describe: "ADR-0473 background (speculative) compaction gate ('1' to enable)",
  },
  {
    key: "QUANTA_EDIT_REPAIR_LOOP",
    defaultLabel: "off",
    describe: "ADR-0472 edit-repair lint-delta gate ('1' to enable)",
  },
  {
    key: "QUANTA_UNTRUSTED_ENVELOPE",
    defaultLabel: "off",
    describe: "ADR-0471 untrusted-source envelope gate ('1' to enable; CLI seeds it ON)",
  },
] as const

/** WS-E jul-10 (UUX-1-09/6-26) — derived env rows for the CLI-seeded
 *  default-ON feature and tool gates (`cli-seeded-gates.ts`). Gates that already have
 *  a curated `ENV_TABLE` row (they are ALSO RuntimeConfig fields, e.g.
 *  QUANTA_UNTRUSTED_ENVELOPE) are skipped so every gate renders exactly once
 *  — pinned by `help-env-seeded-gates-parity.hellgate`. `defaultLabel` is
 *  "on (CLI)": the slice default stays OFF; the CLI host seeds "1" when the
 *  var is unset (an explicit `=0` still wins). */
export const seededGateEnvRows = (): readonly EnvRow[] => {
  const curated = new Set(ENV_TABLE.map((r) => r.key))
  return CLI_SEEDED_GATES.filter((g) => !curated.has(g.gate)).map((g) => ({
    key: g.gate,
    defaultLabel: "on (CLI)",
    describe: g.describe,
  }))
}

/** A single drift finding from {@link auditEnvTableDrift}.
 *   - `missing`       — an `ENV_TABLE` key no longer exists in the catalog
 *                       (stale/renamed/removed knob still documented in `--help`).
 *   - `default-drift` — a *safe-to-check* row's curated `defaultLabel` disagrees
 *                       with the catalog default (silent default skew). */
export interface EnvDriftFinding {
  readonly kind: "missing" | "default-drift"
  readonly key: string
  readonly detail: string
}

/** Sentinel `defaultLabel`s that describe surface behaviour rather than a
 *  literal catalog default (`(auto)`/`(minted)`/`(unset)`/`(empty)`/…). These
 *  are intentionally NOT default-checked — the catalog has no equivalent. */
const isSentinelLabel = (label: string): boolean =>
  /^\(.*\)$/.test(label) || // (auto) (minted) (unset) (empty) (home) (probe) (preset) (tty:rich)
  label.startsWith("~") || // path defaults: ~/.quanta, ~/.quanta/sessions
  label.includes("|") // enum hint string: "rich|plain"

/** Whether a row is SAFE to default-check against the catalog. We only assert
 *  equality where the catalog carries a concrete default AND the curated label
 *  is a plain literal. We deliberately skip:
 *   - sentinel labels (no catalog equivalent),
 *   - inverted bool flags whose var name describes the feature but whose
 *     catalog field is a `*Disabled` flag (label `"on"`, default `false`):
 *     e.g. `QUANTA_FS_JAIL` ("on") ↔ `fsJailDisabled` (false). Comparing these
 *     would false-positive. */
const isDefaultCheckable = (row: EnvRow, knob: UnifiedKnob): boolean => {
  if (knob.default === undefined) return false
  if (isSentinelLabel(row.defaultLabel)) return false
  if (knob.kind === "bool" && row.defaultLabel === "on") return false
  return true
}

/** Normalize a catalog default to the string form the curated `defaultLabel`
 *  uses (bool ⇒ on/off; number ⇒ decimal; string/enum ⇒ as-is). */
const catalogDefaultLabel = (knob: UnifiedKnob): string => {
  const d = knob.default
  if (typeof d === "boolean") return d ? "on" : "off"
  return String(d)
}

/** PURE drift audit: `--help` curated env rows vs the unified-catalog SSOT.
 *  Returns one finding per problem (empty ⇒ no drift). Membership is the
 *  primary guard; default consistency is a conservative secondary check over
 *  the {@link isDefaultCheckable} subset only. Exported for the hellgate. */
export const auditEnvTableDrift = (
  rows: readonly EnvRow[],
  catalog: ReadonlyMap<string, UnifiedKnob>,
): readonly EnvDriftFinding[] => {
  const findings: EnvDriftFinding[] = []
  for (const row of rows) {
    const knob = catalog.get(row.key)
    if (knob === undefined) {
      findings.push({
        kind: "missing",
        key: row.key,
        detail: "key absent from buildKnobCatalog() (stale/renamed/removed knob)",
      })
      continue
    }
    if (!isDefaultCheckable(row, knob)) continue
    const expected = catalogDefaultLabel(knob)
    if (expected !== row.defaultLabel) {
      findings.push({
        kind: "default-drift",
        key: row.key,
        detail: `--help label "${row.defaultLabel}" != catalog default "${expected}"`,
      })
    }
  }
  return findings
}

/** Column width for the slash-name column. Wide enough for `/reload-skills`
 *  plus 2 chars of breathing room — keeps describe columns aligned without
 *  measuring per call. */
const NAME_W = 18
const KEY_W = 22
const ENV_NAME_W = 34
const ENV_DEFAULT_W = 12

/** Category render order (ASCII section headers, no emoji per repo
 *  convention). Categories not in this list (or `undefined` on the command)
 *  fall into "other" at the tail. */
const CATEGORY_ORDER: readonly NonNullable<SlashCommand["category"]>[] = [
  "help",
  "session",
  "history",
  "config",
  "auth",
  "skills",
  "loop",
  "alias",
  "other",
] as const

const CATEGORY_LABEL: Readonly<Record<NonNullable<SlashCommand["category"]>, string>> = {
  help: "help",
  session: "session",
  history: "history",
  config: "config",
  auth: "auth",
  skills: "skills",
  loop: "loop",
  alias: "alias",
  other: "other",
}

const padVisible = (s: string, width: number): string => {
  // Names/keys we pass in here contain NO ANSI codes pre-color (we color
  // AFTER pad). Use plain `.length` — keeps this a pure string op.
  const pad = " ".repeat(Math.max(0, width - s.length))
  return s + pad
}

/** Render a single command/keybind/env row: `cyan-bold {name}  {describe}`.
 *  Color is applied via `wrap` helpers — `setColorPolicy("off")` makes this
 *  a no-op so the box content is plain ASCII. */
const renderRow = (name: string, describe: string, width: number): string => {
  const padded = padVisible(name, width)
  return `${bold(cyan(padded))}  ${describe}`
}

/** Render an env row with three columns: name | default | describe. */
const renderEnvRow = (row: EnvRow): string => {
  const name = padVisible(row.key, ENV_NAME_W)
  const def = padVisible(row.defaultLabel, ENV_DEFAULT_W)
  return `${bold(cyan(name))}  ${def}  ${row.describe}`
}

/** Bucket BUILTINS by category and emit grouped section rows. Each group is
 *  sorted alphabetically by command name. Empty groups are skipped. */
const renderGroupedBuiltins = (builtins: readonly SlashCommand[]): string[] => {
  const buckets = new Map<NonNullable<SlashCommand["category"]>, SlashCommand[]>()
  for (const c of builtins) {
    const cat = c.category ?? "other"
    let bucket = buckets.get(cat)
    if (bucket === undefined) {
      bucket = []
      buckets.set(cat, bucket)
    }
    bucket.push(c)
  }
  const lines: string[] = []
  for (const cat of CATEGORY_ORDER) {
    const bucket = buckets.get(cat)
    if (bucket === undefined || bucket.length === 0) continue
    bucket.sort((a, b) => byteCompare(a.name, b.name))
    lines.push(dim(`── ${CATEGORY_LABEL[cat]} ──`))
    for (const c of bucket) lines.push(renderRow(c.name, c.describe, NAME_W))
    lines.push("")
  }
  return lines
}

/** Pure render function — takes the BUILTINS table + virtual tail and emits
 *  the formatted box. Exported separately so tests can drive it without
 *  reaching through `runHelpRender`. */
export const renderHelp = (builtins: readonly SlashCommand[]): string => {
  const lines: string[] = []
  lines.push(...renderGroupedBuiltins(builtins))
  lines.push(dim("── virtual (REPL-scoped) ──"))
  for (const v of VIRTUAL_COMMANDS) {
    lines.push(renderRow(v.name, v.describe, NAME_W))
  }
  lines.push("")
  lines.push(dim("── keybinds ──"))
  for (const k of KEYBINDS) {
    lines.push(renderRow(k.key, k.describe, KEY_W))
  }
  lines.push("")
  lines.push(dim("── Environment variables (SSOT-routed) ──"))
  for (const e of ENV_TABLE) {
    lines.push(renderEnvRow(e))
  }
  lines.push("")
  lines.push(dim("── CLI feature gates (seeded default-ON when unset; set =0 to disable) ──"))
  for (const e of seededGateEnvRows()) {
    lines.push(renderEnvRow(e))
  }
  lines.push("")
  lines.push(
    dim(
      `(${slashRef("knobs")} all → full 240+ knob catalog, grouped · ${slashRef("knobs")} find <q> → search.)`,
    ),
  )
  return renderBox(lines, {
    title: "quanta — slash commands",
    titleStyle: bold,
    footer: "Docs: docs/runner/SURFACE_INTEGRATION.md",
  })
}

/** Render detail for a single slash command (`/help <name>`). The leading
 *  `/` is optional in the arg — `help skills` and `help /skills` both work.
 *  Unknown name ⇒ caller prints an error line. */
export const renderHelpDetail = (
  builtins: readonly SlashCommand[],
  rawArg: string,
): string | undefined => {
  const arg = rawArg.startsWith("/") ? rawArg : `/${rawArg}`
  const cmd = builtins.find((c) => c.name === arg)
  if (cmd === undefined) return undefined
  const lines: string[] = []
  lines.push(renderRow(cmd.name, "", NAME_W).trimEnd())
  lines.push("")
  lines.push(`${dim("describe:")} ${cmd.describe}`)
  if (cmd.category !== undefined) {
    lines.push(`${dim("category:")} ${cmd.category}`)
  }
  return renderBox(lines, { title: `help — ${cmd.name}`, titleStyle: bold })
}

/** SlashCommand callback. With ZERO args: render the unified menu. With ONE
 *  arg: render the per-command detail (or print "unknown" on miss). Extra
 *  args ⇒ error (consistent with the rest of BUILTINS — `/color foo bar`
 *  errors). */
export const runHelpRender = (
  builtins: readonly SlashCommand[],
  args: readonly string[],
  ctx: SlashContext,
): Promise<number> => {
  if (args.length === 0) {
    ctx.out(`${renderHelp(builtins)}\n`)
    return Promise.resolve(0)
  }
  if (args.length > 1) {
    ctx.err(`/help: expected at most one argument; got ${args.length}\n`)
    return Promise.resolve(1)
  }
  const arg = args[0] as string
  const detail = renderHelpDetail(builtins, arg)
  if (detail === undefined) {
    ctx.err(`/help: unknown command: ${arg}\n`)
    return Promise.resolve(1)
  }
  ctx.out(`${detail}\n`)
  return Promise.resolve(0)
}
