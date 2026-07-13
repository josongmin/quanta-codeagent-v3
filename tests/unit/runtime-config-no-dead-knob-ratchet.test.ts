/**
 * RUNTIME-CONFIG NO-DEAD-KNOB RATCHET (jul-14 — the session's #1 bug class).
 *
 * THREAT MODEL. A `RuntimeConfig` gate field (`readonly <name>: T` in
 * `runtime-config/types.ts` + `types-extra.ts`) is PARSED from env in a
 * `runtime-config.ts` loadFromEnv slice, is documented, is knob-registered … and
 * has ZERO live consumer. The parsed value flows nowhere: no `runtimeConfig().X`
 * read, no populator that hands it to the live subsystem. The knob LOOKS wired
 * (env→config) but is inert (config→∅). This is exactly how `maxConsecutiveFailures`
 * (a budget dial, out of scope here) and the jun-6/jun-7 exfil/TLS-MITM rail
 * fields shipped: parsed, gated, byte-identical-default … and never consumed.
 *
 * WHY A NARROW HIGH-SIGNAL RATCHET (not a loose name-grep). grep-for-consumer is
 * inherently heuristic:
 *   - a LOOSE `\b<field>\b` grep gives FALSE-NEGATIVES on HOMONYMS: `secretEgress`
 *     is ALSO a field on `NetworkProxyConfig` and `writeBudget` is ALSO a field on
 *     `AgentConfig`/`ToolContext` — so `this.config.secretEgress` / `ctx.writeBudget`
 *     hits make a DEAD RuntimeConfig field look alive.
 *   - a STRICT `runtimeConfig().<field>` grep gives ~70 FALSE-POSITIVES: many live
 *     fields are read once and threaded as `cfg.field` / destructured, never via
 *     the `runtimeConfig().field` member expression.
 * So the ratchet judges ONLY DISTINCTIVE fields and is SELF-DETECTING about which
 * fields it can't judge:
 *
 * DISTINCTIVENESS HEURISTIC (no hardcoded English-word list). A field name is
 * DISTINCTIVE iff it is NOT also DECLARED as a field on some OTHER type anywhere
 * in `src/` (no `readonly <name>` / `<name>?:` / `<name>:` line outside the
 * runtime-config sources). For a distinctive name, `\b<field>\b` uniquely
 * identifies the RuntimeConfig field's usages, so ZERO non-parse/non-type/non-test
 * matches ⇒ genuinely dead. A NON-distinctive (homonym) name goes in
 * SKIP_NON_DISTINCTIVE — the ratchet HONESTLY declines to judge it rather than
 * emit a brittle assertion. (Measured on the current tree: 121 of 175 fields are
 * distinctive; the 54 skipped are homonyms with other types' fields.)
 *
 * TWO INVARIANTS:
 *   (A) FORWARD ratchet — every DISTINCTIVE field with 0 consumers FAILS unless it
 *       is in FORWARD_SEAM_ALLOWLIST (carrying WHY it is still dead + the wiring
 *       target). A NEW distinctive dead knob trips this.
 *   (B) REVERSE-DRIFT guard — every FORWARD_SEAM_ALLOWLIST entry is asserted STILL
 *       dead. If a consumer appeared, FAIL with "now wired, remove from allowlist".
 *       This closes the `mcpSampling`-JSDoc-stale class (a "no consumers" note that
 *       rots into a lie after the field gets wired).
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../..")
const SRC = join(REPO_ROOT, "src")
const TYPES_FILES = [
  join(SRC, "shared/runtime-config/types.ts"),
  join(SRC, "shared/runtime-config/types-extra.ts"),
]

/** A source file is a RUNTIME-CONFIG source (parse site / type decls / knob
 *  registry) — matches on it are NOT "consumers" and NOT "foreign declarations". */
const isRuntimeConfigSource = (path: string): boolean =>
  path.endsWith("src/shared/runtime-config.ts") ||
  path.includes("/shared/runtime-config/") ||
  path.includes("/shared/runtime-config-knobs/") ||
  path.endsWith("src/shared/runtime-config-knobs.ts")

const isTestFile = (path: string): boolean => path.endsWith(".test.ts")

/** All production .ts under src/ that are neither test nor a runtime-config source. */
function collectProductionFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      const s = statSync(p)
      if (s.isDirectory()) {
        if (entry === "__tests__" || entry === "node_modules") continue
        walk(p)
      } else if (
        entry.endsWith(".ts") &&
        !entry.endsWith(".d.ts") &&
        !isTestFile(p) &&
        !isRuntimeConfigSource(p)
      ) {
        out.push(p)
      }
    }
  }
  walk(SRC)
  return out
}

// Read every non-runtime-config production file ONCE; keep raw text for member
// grep and a per-file set of "declared field names" for the homonym test.
const PROD_FILES = collectProductionFiles()
const PROD_SOURCES: { path: string; text: string }[] = PROD_FILES.map((path) => ({
  path,
  text: readFileSync(path, "utf8"),
}))

/** Extract `readonly <name>` field names from the two runtime-config type files. */
function extractFields(): string[] {
  const names = new Set<string>()
  for (const file of TYPES_FILES) {
    const text = readFileSync(file, "utf8")
    for (const m of text.matchAll(/^\s*readonly\s+([a-zA-Z][a-zA-Z0-9]*)\s*[?:]/gm)) {
      names.add(m[1])
    }
  }
  return [...names].sort()
}

/** A field declared as a field on SOME OTHER type in production sources
 *  (`readonly name` / `name?:` / `name:` at start-of-property). Used as the
 *  homonym signal: such a name cannot be judged by a bare `\b<name>\b` grep. */
function isHomonym(field: string): boolean {
  const decl = new RegExp(`(?:readonly\\s+${field}\\b|^\\s*${field}\\??\\s*:\\s)`, "m")
  return PROD_SOURCES.some((s) => decl.test(s.text))
}

/** Count production files that reference `\b<field>\b` (any usage). For a
 *  DISTINCTIVE field this is the true live-consumer count. */
function consumerFiles(field: string): string[] {
  const re = new RegExp(`\\b${field}\\b`)
  return PROD_SOURCES.filter((s) => re.test(s.text)).map((s) => s.path)
}

const ALL_FIELDS = extractFields()

// ── FORWARD_SEAM_ALLOWLIST ────────────────────────────────────────────────────
// Distinctive fields that ARE parsed-but-dead ON PURPOSE (forward seam): the env
// →config half shipped, the config→subsystem half is a named follow-up. Each entry
// is asserted STILL dead by the reverse-drift guard below.
//
// category:
//   "genuinely-dead"        — the populator that hands the parsed value to the
//                             live subsystem is ABSENT; the whole feature is inert.
//   "redundant-parallel-read" — the FEATURE is live, but via a DIRECT
//                             `gateOn(env, "QUANTA_X")` read elsewhere; the
//                             RuntimeConfig FIELD is dead-weight and should be
//                             DELETED (a `/config set` can't reach the direct read
//                             anyway). Kept here (not deleted) because these are
//                             security/host-assembly configs owned by other workers.
type SeamEntry = {
  category: "genuinely-dead" | "redundant-parallel-read"
  reason: string
  target: string
}

const FORWARD_SEAM_ALLOWLIST: Record<string, SeamEntry> = {
  // ── jun-6/jun-7 exfil + TLS-MITM rail: parsed, gated, byte-identical-default,
  //    but the parsed RuntimeConfig value never flows to the live NetworkProxy —
  //    no populator maps runtimeConfig().<field> onto NetworkProxyConfig.  ───────
  secretEgressMaxBody: {
    category: "genuinely-dead",
    reason:
      "jun-6 exfil-rail (B) buffered-body byte cap: parsed from QUANTA_SECRET_EGRESS_MAX_BODY " +
      "but no populator hands it to NetworkProxyConfig.secretEgress — the live proxy reads its " +
      "own SecretEgressConfig, never runtimeConfig().secretEgressMaxBody. Populator not wired.",
    target: "RFC jun-6 exfil-rail — wire runtimeConfig()→NetworkProxyConfig.secretEgress populator",
  },
  exfilScoutingK: {
    category: "genuinely-dead",
    reason:
      "jun-6 exfil-rail (c) configurable threshold K: parsed from QUANTA_EXFIL_SCOUTING_K but " +
      "no consumer reads runtimeConfig().exfilScoutingK — the detector (gated by the sibling " +
      "`exfilScouting`, which IS consumed in admissibility-gate/gates.ts) has no K feed, so it " +
      "stays inert even when armed. Threshold-consumer not wired.",
    target: "RFC jun-6 exfil-rail — feed K into the exfil-scouting detector",
  },
  tlsMitm: {
    category: "genuinely-dead",
    reason:
      "jun-7 TLS-MITM master switch: parsed via tlsMitmAuthorized(env) but no consumer reads " +
      "runtimeConfig().tlsMitm — the live CONNECT path (mitm-gate.ts / loopback-proxy) is not " +
      "driven off this field, so it stays a raw tunnel regardless. Populator absent.",
    target: "RFC jun-7 TLS-MITM — wire runtimeConfig().tlsMitm into the CONNECT interceptor",
  },
  tlsMitmOnFailure: {
    category: "genuinely-dead",
    reason:
      "jun-7 TLS-MITM fail-closed policy: parsed from QUANTA_TLS_MITM_ON_FAILURE but never read " +
      "(runtimeConfig().tlsMitmOnFailure has 0 consumers); rides along dead with the tlsMitm " +
      "master switch above. Populator absent.",
    target: "RFC jun-7 TLS-MITM — consume alongside tlsMitm in the CONNECT interceptor",
  },

  // ── redundant-parallel-read: FEATURE live via direct env read; FIELD dead. ────
  capabilityLayer: {
    category: "redundant-parallel-read",
    reason:
      "Capability layer IS live, gated by a DIRECT gateOnStrict(env,'QUANTA_CAPABILITY_LAYER') " +
      "read in @/capability/resolve + bootstrap-session; runtimeConfig().capabilityLayer has 0 " +
      "consumers. The FIELD is dead-weight (a /config set can't reach the direct read). DELETE " +
      "the field (security/bootstrap config owned by another worker).",
    target:
      "delete-ticket: drop RuntimeConfig.capabilityLayer (direct QUANTA_CAPABILITY_LAYER read is SSOT)",
  },
  sideAgent: {
    category: "redundant-parallel-read",
    reason:
      "Side-agent daemons ARE live, gated by a DIRECT gateOn(env,'QUANTA_SIDE_AGENT') read in " +
      "host/runtime/agent-config-assembler; runtimeConfig().sideAgent has 0 consumers (the " +
      "distinct field `sideAgentProcess` IS consumed — different field). FIELD is dead-weight.",
    target: "delete-ticket: drop RuntimeConfig.sideAgent (direct QUANTA_SIDE_AGENT read is SSOT)",
  },
  subagentResume: {
    category: "redundant-parallel-read",
    reason:
      "ADR-0159 work-resume IS live, gated by a DIRECT gateOn(args.envSource,'QUANTA_SUBAGENT_RESUME') " +
      "read in runner/session-execution-plane; runtimeConfig().subagentResume has 0 consumers — " +
      "the types.ts JSDoc itself says the wiring reads the env 'directly (not via this)'. Dead-weight.",
    target:
      "delete-ticket: drop RuntimeConfig.subagentResume (direct QUANTA_SUBAGENT_RESUME read is SSOT)",
  },
}

// ── SKIP_NON_DISTINCTIVE ──────────────────────────────────────────────────────
// Honest self-limit: fields whose names are HOMONYMS with fields on OTHER types,
// so a `\b<name>\b` grep cannot tell a RuntimeConfig-field usage from the other
// type's usage. The ratchet DECLINES to judge these (a false "alive" here would
// silently mask a dead knob). This set is DISCOVERED dynamically (isHomonym), not
// hardcoded; the two entries below are documented because they are DEAD-but-masked
// RuntimeConfig fields the grep would wrongly call alive.
const SKIP_NON_DISTINCTIVE_NOTES: Record<string, string> = {
  secretEgress:
    "HOMONYM with NetworkProxyConfig.secretEgress + mitm.ts. runtimeConfig().secretEgress has 0 " +
    "consumers (genuinely dead, same jun-6 rail as secretEgressMaxBody) but `\\bsecretEgress\\b` " +
    "matches this.config.secretEgress in loopback-proxy — grep can't judge it. Track with the rail.",
  writeBudget:
    "HOMONYM with AgentConfig/ToolContext.writeBudget. runtimeConfig().writeBudget has 0 consumers " +
    "(redundant-parallel-read: feature live via direct gateOn(env,'QUANTA_WRITE_BUDGET') in the " +
    "assembler) but `\\bwriteBudget\\b` matches ctx.writeBudget everywhere — grep can't judge it.",
}

// Partition once.
const DISTINCTIVE: string[] = []
const HOMONYMS: string[] = []
for (const f of ALL_FIELDS) {
  if (isHomonym(f)) HOMONYMS.push(f)
  else DISTINCTIVE.push(f)
}

describe("runtime-config no-dead-knob ratchet", () => {
  // ── NON-VACUITY floor: the extractor + partition actually found the tree. ─────
  test("anti-vacuum: extractor found ≥150 fields and a non-empty distinctive set", () => {
    expect(ALL_FIELDS.length).toBeGreaterThanOrEqual(150)
    expect(DISTINCTIVE.length).toBeGreaterThanOrEqual(50)
    expect(PROD_SOURCES.length).toBeGreaterThan(500) // production tree is actually loaded
    // the two known homonyms MUST land in the homonym partition (heuristic sanity)
    expect(HOMONYMS).toContain("secretEgress")
    expect(HOMONYMS).toContain("writeBudget")
  })

  // ── RED-ON-INJECTION self-test: a synthetic definitely-dead distinctive name
  //    must be flagged dead by the same consumer check the ratchet uses. ─────────
  test("red-on-injection: a synthetic distinctive field with no consumer is flagged dead", () => {
    const SYNTHETIC = "quantaXyzzyDefinitelyDeadKnob4242"
    expect(isHomonym(SYNTHETIC)).toBe(false) // distinctive by construction
    expect(consumerFiles(SYNTHETIC).length).toBe(0) // the checker DOES flag it dead
    // and a name that unambiguously IS consumed (a real distinctive live field)
    // must NOT be flagged — control against a vacuous "everything is dead" checker.
    const liveControl = DISTINCTIVE.find(
      (f) => !(f in FORWARD_SEAM_ALLOWLIST) && consumerFiles(f).length > 0,
    )
    expect(liveControl).toBeDefined()
    expect(consumerFiles(liveControl as string).length).toBeGreaterThan(0)
  })

  // ── (A) FORWARD ratchet: no NEW distinctive dead knob. ────────────────────────
  test("no distinctive RuntimeConfig field is parsed-but-dead (unless allowlisted)", () => {
    const offenders: string[] = []
    for (const field of DISTINCTIVE) {
      if (consumerFiles(field).length === 0 && !(field in FORWARD_SEAM_ALLOWLIST)) {
        offenders.push(field)
      }
    }
    expect(
      offenders,
      `Distinctive RuntimeConfig field(s) parsed in runtime-config.ts but with ZERO live consumer ` +
        `(no \\b<field>\\b reference in any non-test, non-parse, non-type production .ts). Either ` +
        `wire a consumer, delete the field, or add it to FORWARD_SEAM_ALLOWLIST with an honest ` +
        `reason + wiring target: ${offenders.join(", ")}`,
    ).toEqual([])
  })

  // ── (B) REVERSE-DRIFT guard: every allowlisted field is STILL dead. ───────────
  test("reverse-drift: every FORWARD_SEAM_ALLOWLIST field is still dead (0 consumers)", () => {
    const nowWired: string[] = []
    for (const field of Object.keys(FORWARD_SEAM_ALLOWLIST)) {
      // the allowlist may only hold DISTINCTIVE fields — a homonym here would be
      // unjudgeable and mask drift.
      expect(DISTINCTIVE, `allowlist entry '${field}' must be distinctive`).toContain(field)
      if (consumerFiles(field).length > 0) nowWired.push(field)
    }
    expect(
      nowWired,
      `Field(s) in FORWARD_SEAM_ALLOWLIST now HAVE a live consumer — the forward seam closed. ` +
        `Remove them from the allowlist (the reason/target is now stale, the mcpSampling-JSDoc-rot ` +
        `class): ${nowWired.join(", ")}`,
    ).toEqual([])
  })

  // ── allowlist hygiene: every entry carries a real reason + target. ────────────
  test("every allowlist entry carries an honest reason + wiring target", () => {
    for (const [field, e] of Object.entries(FORWARD_SEAM_ALLOWLIST)) {
      expect(e.reason.length, `${field}.reason too thin`).toBeGreaterThan(40)
      expect(e.target.length, `${field}.target too thin`).toBeGreaterThan(10)
      expect(["genuinely-dead", "redundant-parallel-read"]).toContain(e.category)
    }
    // documented skip notes must be for actual homonyms.
    for (const field of Object.keys(SKIP_NON_DISTINCTIVE_NOTES)) {
      expect(HOMONYMS, `documented skip '${field}' must be a homonym`).toContain(field)
    }
  })
})
