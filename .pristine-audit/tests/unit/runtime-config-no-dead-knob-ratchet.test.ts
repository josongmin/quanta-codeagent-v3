/**
 * RUNTIME-CONFIG NO-DEAD-KNOB RATCHET (jul-14 — the session's #1 bug class).
 *
 * THREAT MODEL. A `RuntimeConfig` gate field (`readonly <name>: T` in
 * `runtime-config/types.ts` + `types-extra.ts`) is PARSED from env in a
 * `runtime-config.ts` parser slice, is documented, is knob-registered … and
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
 * matches ⇒ genuinely dead. A NON-distinctive (homonym) name needs an exact
 * owner-seam assertion rather than a misleading bare-name match.
 *
 * INVARIANT: every DISTINCTIVE field needs a live production consumer. Known
 * homonyms are asserted at their concrete owner seams. There is no dead-field
 * allowlist: incomplete wiring must fail the gate rather than become a stale note.
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

// Index once: the old checker re-ran a full-tree regex scan for every config
// field, which made this guard intermittently exceed Bun's 5s per-test budget
// under concurrent CI. These indexes preserve the exact word/declaration
// predicates while making each field lookup O(1).
const DECLARED_FOREIGN_FIELDS = new Set<string>()
const WORD_CONSUMER_FILES = new Map<string, string[]>()
for (const source of PROD_SOURCES) {
  for (const match of source.text.matchAll(
    /(?:readonly\s+([a-zA-Z][a-zA-Z0-9]*)\b|^\s*([a-zA-Z][a-zA-Z0-9]*)\??\s*:\s)/gm,
  )) {
    DECLARED_FOREIGN_FIELDS.add(match[1] ?? match[2] ?? "")
  }
  const words = new Set<string>()
  for (const match of source.text.matchAll(/\b([a-zA-Z][a-zA-Z0-9]*)\b/g)) {
    words.add(match[1] as string)
  }
  for (const word of words) {
    const paths = WORD_CONSUMER_FILES.get(word)
    if (paths === undefined) WORD_CONSUMER_FILES.set(word, [source.path])
    else paths.push(source.path)
  }
}

/** Extract `readonly <name>` field names from the two runtime-config type files. */
function extractFields(): string[] {
  const names = new Set<string>()
  for (const file of TYPES_FILES) {
    const text = readFileSync(file, "utf8")
    for (const m of text.matchAll(/^\s*readonly\s+([a-zA-Z][a-zA-Z0-9]*)\s*[?:]/gm)) {
      names.add(m[1]!)
    }
  }
  return [...names].sort()
}

/** A field declared as a field on SOME OTHER type in production sources
 *  (`readonly name` / `name?:` / `name:` at start-of-property). Used as the
 *  homonym signal: such a name cannot be judged by a bare `\b<name>\b` grep. */
function isHomonym(field: string): boolean {
  return DECLARED_FOREIGN_FIELDS.has(field)
}

/** Count production files that reference `\b<field>\b` (any usage). For a
 *  DISTINCTIVE field this is the true live-consumer count. */
function consumerFiles(field: string): string[] {
  return WORD_CONSUMER_FILES.get(field) ?? []
}

const ALL_FIELDS = extractFields()

// ── SKIP_NON_DISTINCTIVE ──────────────────────────────────────────────────────
// Honest self-limit: fields whose names are HOMONYMS with fields on OTHER types,
// so a `\b<name>\b` grep cannot tell a RuntimeConfig-field usage from the other
// type's usage. The ratchet DECLINES to judge these (a false "alive" here would
// silently mask a dead knob). This set is DISCOVERED dynamically (isHomonym), not
// hardcoded. The two known RuntimeConfig homonyms get owner-specific assertions
// below; a bare identifier scan would otherwise confuse them with proxy/context
// fields and claim a consumer that is not actually reading RuntimeConfig.
const HOMONYM_OWNER_READS = {
  secretEgress: {
    path: join(SRC, "runner/knobs/knobs/network-proxy.ts"),
    pattern: /config\.secretEgress\b/,
  },
  writeBudget: {
    path: join(SRC, "host/runtime/security-rails-wire.ts"),
    pattern: /config\.writeBudget\b/,
  },
} as const

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
    const liveControl = DISTINCTIVE.find((f) => consumerFiles(f).length > 0)
    expect(liveControl).toBeDefined()
    expect(consumerFiles(liveControl as string).length).toBeGreaterThan(0)
  })

  // ── (A) FORWARD ratchet: no NEW distinctive dead knob. ────────────────────────
  test("no distinctive RuntimeConfig field is parsed-but-dead", () => {
    const offenders: string[] = []
    for (const field of DISTINCTIVE) {
      if (consumerFiles(field).length === 0) {
        offenders.push(field)
      }
    }
    expect(
      offenders,
      `Distinctive RuntimeConfig field(s) parsed in runtime-config.ts but with ZERO live consumer ` +
        `(no \\b<field>\\b reference in any non-test, non-parse, non-type production .ts). Either ` +
        `wire a consumer or delete the field: ${offenders.join(", ")}`,
    ).toEqual([])
  })

  test("known homonyms read RuntimeConfig at their owning seams", () => {
    for (const [field, owner] of Object.entries(HOMONYM_OWNER_READS)) {
      expect(HOMONYMS, `${field} must remain a genuine homonym`).toContain(field)
      expect(
        readFileSync(owner.path, "utf8"),
        `${field} must read its RuntimeConfig field`,
      ).toMatch(owner.pattern)
    }
  })
})
