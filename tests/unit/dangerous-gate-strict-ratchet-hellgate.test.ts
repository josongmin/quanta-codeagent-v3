/**
 * Ratchet — security/capability-dangerous gates MUST use the STRICT env primitive
 * (`gateOnStrict` / `gateDisabledStrict` — exact literal `1`, fail-closed) and
 * never the lenient `gateOn` / `gateDisabled` (which also accept `on`/`true`/
 * `yes`). Loosening such a gate broadens activation of a dangerous capability on
 * a typo or loose spelling.
 *
 * This guard exists because exactly that regressed once: `QUANTA_LLM_CREDENTIAL_
 * TRUSTED` — the sole channel authorizing the credential-helper SHELL (arbitrary
 * command execution) — was silently migrated from strict `=== "1"` to loose
 * `gateOn`, while every other dangerous gate in the same commit kept the strict
 * primitive. Source-scan red-on-injection: flipping any pinned gate back to the
 * lenient primitive fails this test.
 *
 * To intentionally change a gate's strictness you must edit BOTH the wiring and
 * this list — a deliberate, reviewed security decision, never an incidental
 * migration.
 *
 * ── SRC-WIDE hardening (jun-07) ───────────────────────────────────────────────
 * The original ratchet only read `src/shared/runtime-config.ts` and asserted the
 * strict-vocab there. But the REAL enforcement read for the two most dangerous
 * gates lives in OTHER files, behind a named `*_ENV` CONST alias rather than the
 * string literal:
 *   - `QUANTA_CODE_MODE`  (arbitrary in-VM code execution — wires the code-cell
 *     dispatch factory) is read at src/agent/optional-ports.ts as
 *     `gateOnStrict(env, QUANTA_CODE_MODE_ENV)`.
 *   - `QUANTA_TLS_MITM`   (mints a CA the agent's HTTP client trusts) is read at
 *     src/runtime/network-proxy/mitm-gate.ts as `gateOnStrict(env, TLS_MITM_ENV)`.
 * Loosening EITHER of those enforcement reads (`gateOnStrict` → `gateOn`) evaded
 * BOTH the old single-file ratchet (wrong file) AND the gate-vocabulary burn-down
 * ratchet (the loosened call is a `gateOn(...)`, not a raw `=== "1"`). That is a
 * genuine false-confidence hole in a security guard.
 *
 * The src-wide invariant below walks ALL of src (recursively) once and, for each
 * dangerous gate, asserts (a) the STRICT form is present somewhere (gate not
 * silently deleted) and (b) NO LOOSE form exists anywhere — matching BOTH the
 * string-literal arg form (`gateOn(env, "QUANTA_CODE_MODE")`) AND the const-alias
 * arg form (`gateOn(env, QUANTA_CODE_MODE_ENV)`).
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./_shared/strip-comments"

const SRC_ROOT = join(import.meta.dir, "../../src")
const SRC = readFileSync(join(SRC_ROOT, "shared/runtime-config.ts"), "utf8")

/** Gates whose ON form must be `gateOnStrict(env, "NAME")`. `why` documents the
 *  dangerous capability the gate activates (the reason loose spellings are unsafe). */
const STRICT_ON_GATES: ReadonlyArray<readonly [name: string, why: string]> = [
  ["QUANTA_LLM_CREDENTIAL_TRUSTED", "arbitrary command execution via the credential-helper shell"],
  ["QUANTA_CODE_MODE", "arbitrary in-VM code execution surface"],
  ["QUANTA_CODE_MODE_ONLY", "code-mode-only tool surface"],
  ["QUANTA_UNTRUSTED_ENVELOPE", "untrusted-content security envelope"],
  ["QUANTA_EXFIL_SCOUTING", "egress exfil-scouting security gate"],
  ["QUANTA_GLOB_WRITE_GUARD", "filesystem write guard"],
  ["QUANTA_EDIT_REPAIR_LOOP", "autonomous edit-repair loop"],
  ["QUANTA_SKILL_MCP_DEPS", "skill-declared MCP dependency activation"],
  ["QUANTA_BG_COMPACTION", "background compaction"],
]

/** Gates whose DISABLE form must be `gateDisabledStrict(env, "NAME")` — turning
 *  OFF a safety mechanism is at least as dangerous as turning ON a capability. */
const STRICT_DISABLE_GATES: ReadonlyArray<readonly [name: string, why: string]> = [
  ["QUANTA_FS_JAIL", "disabling the filesystem jail"],
  ["QUANTA_LOG_RATE_LIMIT", "disabling log rate limiting"],
]

const wiring = (fn: string, name: string): RegExp =>
  new RegExp(`${fn}\\(\\s*env,\\s*"${name}"\\s*\\)`)

describe("dangerous gates use the STRICT env primitive (ratchet)", () => {
  for (const [name, why] of STRICT_ON_GATES) {
    test(`${name} (${why}) wired with gateOnStrict, NOT loose gateOn`, () => {
      // strict wiring present
      expect(SRC).toMatch(wiring("gateOnStrict", name))
      // and the LOOSE form is absent (gateOnStrict\( does not match gateOn\( —
      // the char after "gateOn" is "S", not "(")
      expect(SRC).not.toMatch(wiring("gateOn", name))
    })
  }

  for (const [name, why] of STRICT_DISABLE_GATES) {
    test(`${name} (${why}) wired with gateDisabledStrict, NOT loose gateDisabled`, () => {
      expect(SRC).toMatch(wiring("gateDisabledStrict", name))
      expect(SRC).not.toMatch(wiring("gateDisabled", name))
    })
  }

  test("the strict-gate inventory is non-empty (guard is live, not vacuous)", () => {
    expect(STRICT_ON_GATES.length + STRICT_DISABLE_GATES.length).toBeGreaterThanOrEqual(11)
  })
})

// ─── SRC-WIDE, const-alias-aware invariant ────────────────────────────────────
//
// The single-file assertions above are necessary but NOT sufficient: the actual
// security ENFORCEMENT read for several dangerous gates lives in its own slice
// file, behind a named `*_ENV` const alias (not the string literal). A loosening
// there is invisible to the runtime-config scan. This block reads ALL src files
// once and checks every dangerous gate by BOTH its literal AND its const alias.

/** A dangerous gate, the strict accessor it must use, its env string literal, and
 *  every CONST alias that names that literal (`const X = "QUANTA_..."`). `mint`
 *  records WHY the gate is dangerous. */
interface DangerousGate {
  readonly literal: string
  /** "on" ⇒ must use gateOnStrict; "disable" ⇒ must use gateDisabledStrict. */
  readonly kind: "on" | "disable"
  /** const aliases that resolve to `literal` (e.g. `QUANTA_CODE_MODE_ENV`). */
  readonly aliases: ReadonlyArray<string>
  readonly why: string
}

const DANGEROUS_GATES: ReadonlyArray<DangerousGate> = [
  {
    literal: "QUANTA_CODE_MODE",
    kind: "on",
    aliases: ["QUANTA_CODE_MODE_ENV"],
    why: "arbitrary-exec: wires the code-cell dispatch factory (model-authored code in a WASM isolate)",
  },
  {
    literal: "QUANTA_CODE_MODE_ONLY",
    kind: "on",
    aliases: [],
    why: "arbitrary-exec-steering: steers the model toward code cells",
  },
  {
    literal: "QUANTA_TLS_MITM",
    kind: "on",
    aliases: ["TLS_MITM_ENV"],
    why: "CA-mint: mints a CA the agent's HTTP client trusts (intercepts/forges TLS)",
  },
  {
    literal: "QUANTA_LLM_CREDENTIAL_TRUSTED",
    kind: "on",
    aliases: [],
    why: "arbitrary-exec: sole authorization for the credential-helper shell (command execution)",
  },
  {
    literal: "QUANTA_UNTRUSTED_ENVELOPE",
    kind: "on",
    aliases: ["UNTRUSTED_ENVELOPE_ENV"],
    why: "security-envelope: governs how untrusted content is fenced before the model sees it",
  },
  {
    literal: "QUANTA_EXFIL_SCOUTING",
    kind: "on",
    aliases: ["EXFIL_SCOUTING_ENV"],
    why: "egress-security: arms the exfil-scouting detector on the network egress path",
  },
  {
    literal: "QUANTA_GLOB_WRITE_GUARD",
    kind: "on",
    aliases: ["GLOB_WRITE_GUARD_ENV"],
    why: "fs-write-guard: governs the filesystem write/edit path guard",
  },
  {
    literal: "QUANTA_EDIT_REPAIR_LOOP",
    kind: "on",
    aliases: ["EDIT_REPAIR_LOOP_ENV"],
    why: "autonomy: arms the autonomous edit-repair loop",
  },
  {
    literal: "QUANTA_SKILL_MCP_DEPS",
    kind: "on",
    aliases: ["SKILL_MCP_DEPS_FLAG"],
    why: "capability-activation: activates skill-declared MCP dependencies",
  },
  {
    literal: "QUANTA_BG_COMPACTION",
    kind: "on",
    aliases: ["BG_COMPACTION_ENV"],
    why: "background-task: arms background compaction",
  },
  {
    literal: "QUANTA_STALE_READ_GUARD",
    kind: "disable",
    aliases: ["STALE_READ_GUARD_ENV"],
    why: "fs-safety-disable: the stale-read guard is now DEFAULT-ON (Claude-parity SOTA++ upgrade); only the deliberate `=off` kill-switch (gateDisabledStrict, like the fs-jail) tears down its TOCTOU clobber protection",
  },
  {
    literal: "QUANTA_FS_JAIL",
    kind: "disable",
    aliases: [],
    why: "sandbox-disable: turning OFF the filesystem jail (cross-directory access)",
  },
  {
    literal: "QUANTA_LOG_RATE_LIMIT",
    kind: "disable",
    aliases: [],
    why: "safety-disable: turning OFF log rate limiting (log-flood DoS)",
  },
]

/** Recursively read every `.ts` file under `src/`, returning [absPath, text]. */
const readAllSrc = (): ReadonlyArray<readonly [path: string, text: string]> => {
  const out: Array<readonly [string, string]> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue
        walk(full)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue
      out.push([full, readFileSync(full, "utf8")])
    }
  }
  walk(SRC_ROOT)
  return out
}

/**
 * F2 FIX — strip comments before scanning. The scan is raw-text, so a COMMENT or
 * MIGRATION NOTE that merely *mentions* a loose call (e.g.
 * `// replaced gateOn(env,"QUANTA_CODE_MODE") with gateOnStrict`) used to FALSELY
 * trip the ratchet and break CI on a benign edit. We remove line- and block-
 * comments first so only EXECUTABLE code is scanned.
 *
 * Conservative, not a full lexer: we walk the text char-by-char tracking whether
 * we are inside a string/template literal, and only strip `//…` / `/* … *​/` when
 * NOT inside a string. This avoids the classic `https://` false-strip (the `//`
 * is inside a quoted string) and avoids blanking the gate-name argument of a real
 * call (which lives in code, never a comment). Stripped comment bytes are replaced
 * with spaces of equal length so line/column geometry (and our regexes) are
 * unaffected by anything but the now-absent comment text.
 */
/** Replace a matched comment with equal-length whitespace (newlines preserved) so
 *  line/column geometry is unchanged but the comment TEXT is gone. */
/**
 * The shared scanner, positions preserved so every `file:line` this suite
 * reports stays true.
 *
 * The local tokenizer it replaces was quoting-aware and REGEX-BLIND: `/[/*]/`
 * and `/[*​/]/` are valid JS character classes, and the alternation read the
 * first as a comment opener and blanked everything to the second. MEASURED —
 * two such lines around `env.QUANTA_TLS_MITM === "true"` in
 * `src/agent/dispatch.ts` left this fence green.
 */
const stripSrc = (src: string): string => stripComments(src, { preservePositions: true })

/** Comment-stripped view of every src file — what every src-wide assertion scans. */
const ALL_SRC = readAllSrc().map(([p, text]) => [p, stripSrc(text)] as const)

/** Escape a string for use as a literal inside a RegExp. */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Build the union of arg spellings for a gate: the quoted literal OR any const
 *  alias. e.g. (?:"QUANTA_CODE_MODE"|QUANTA_CODE_MODE_ENV) */
const argAlternation = (g: DangerousGate): string => {
  const parts = [`"${esc(g.literal)}"`, ...g.aliases.map(esc)]
  return `(?:${parts.join("|")})`
}

/**
 * `<accessor>(<env-source>, <gate-name>)` — matches the call by accessor name and
 * gate-name arg (literal or const), tolerant of whitespace.
 *
 * F1 FIX — the env-source arg may itself be a CALL (`getEnv()`, `process.env`,
 * `this.env()`). The old matcher used `[^,()]+`, which FORBIDS parens and so let
 * `gateOn(getEnv(), "QUANTA_CODE_MODE")` slip the ratchet. We now allow parens in
 * the source arg via a NON-GREEDY `[^,]+?` (still no comma — that would cross into
 * a third argument / a separate call), so the env source can be an arbitrary
 * (paren-bearing) accessor expression and the loosening is still caught. The
 * non-greedy quantifier plus the anchored `, <gate-name>)` tail prevents
 * over-matching across two adjacent calls. */
const callRe = (accessor: string, g: DangerousGate): RegExp =>
  new RegExp(`\\b${accessor}\\s*\\(\\s*[^,]+?,\\s*${argAlternation(g)}\\s*\\)`)

/**
 * F3 FIX — police the READERS, not just the one `gateOn`/`gateDisabled` accessor
 * pair. A dangerous gate re-read through a LOOSER primitive bypasses the strict
 * guard entirely. The two security-relevant evasion shapes:
 *
 *   (a) `parseEnvFlag(env.QUANTA_CODE_MODE, …)` — the exported helper accepts
 *       on/true/yes AND an EMPTY string as truthy (looser than gateOnStrict's
 *       exact `=== "1"`). Reading a dangerous gate through it broadens activation.
 *   (b) raw `env.QUANTA_CODE_MODE === "on"|"true"|"yes"|"1"` (or the
 *       `env["QUANTA_CODE_MODE"]` bracket form) — an inline comparison that
 *       sidesteps the centralized strict primitive. Even the `=== "1"` strict
 *       spelling is banned inline: dangerous gates must funnel through
 *       `gateOnStrict`/`gateDisabledStrict`, never an ad-hoc compare.
 *
 * Each returns a regex that, run over comment-stripped src, flags the evasion. */
const parseEnvFlagRe = (g: DangerousGate): RegExp =>
  // parseEnvFlag( … <gate-name> … )  — gate name referenced as the env value
  // arg, as a literal or alias, in dotted (`env.NAME`) or bracket (`env["NAME"]`)
  // form, or the bare alias const. We require the name to appear before the next
  // `)` so we don't match across an unrelated later call.
  new RegExp(`\\bparseEnvFlag\\s*\\(\\s*[^)]*?${nameRef(g)}[^)]*\\)`)

const rawCompareRe = (g: DangerousGate): RegExp =>
  // <gate-name-ref>(]?) (!|=)== "on"|"true"|"yes"|"1"  — inline strict/loose
  // compare. The optional `]` lets the bracket read `env["QUANTA_X"] === …` match
  // (the quoted literal is closed by `]` before the operator).
  new RegExp(`${nameRef(g)}\\s*\\]?\\s*(?:!|=)==\\s*"(?:on|true|yes|1)"`)

/** Reference to a dangerous gate's name as a value-read: the quoted literal (so
 *  `env["QUANTA_X"]` matches), `env.QUANTA_X` dotted form, OR any const alias. */
const nameRef = (g: DangerousGate): string => {
  const parts = [
    `"${esc(g.literal)}"`,
    `\\.${esc(g.literal)}\\b`,
    `\\b${esc(g.literal)}\\b`,
    ...g.aliases.map((a) => `\\b${esc(a)}\\b`),
  ]
  return `(?:${parts.join("|")})`
}

describe("dangerous gates use the STRICT primitive SRC-WIDE (const-alias-aware ratchet)", () => {
  for (const g of DANGEROUS_GATES) {
    const strict = g.kind === "on" ? "gateOnStrict" : "gateDisabledStrict"
    const loose = g.kind === "on" ? "gateOn" : "gateDisabled"
    const strictRe = callRe(strict, g)
    const looseRe = callRe(loose, g)

    test(`${g.literal} [${g.why}] — NO loose ${loose}(...) anywhere in src (literal or alias)`, () => {
      const offenders = ALL_SRC.filter(([, text]) => looseRe.test(text)).map(([p]) =>
        p.slice(SRC_ROOT.length + 1),
      )
      // A loose enforcement read evades BOTH the runtime-config ratchet (wrong
      // file) AND the gate-vocab burn-down ratchet (not a raw === "1"). Any hit
      // here is a real security regression — report the file(s).
      expect(offenders).toEqual([])
    })

    test(`${g.literal} — strict ${strict}(...) PRESENT somewhere in src (gate not silently deleted)`, () => {
      const present = ALL_SRC.some(([, text]) => strictRe.test(text))
      expect(present).toBe(true)
    })

    // F3 — NO looser READER of this dangerous gate anywhere in src: no
    // parseEnvFlag(env.GATE, …) (accepts on/true/yes/empty) and no inline
    // raw `=== "on"|"true"|"yes"|"1"` compare (sidesteps the strict primitive).
    const pefRe = parseEnvFlagRe(g)
    const rawRe = rawCompareRe(g)
    test(`${g.literal} — NO looser reader (parseEnvFlag / raw === compare) anywhere in src`, () => {
      const pefOffenders = ALL_SRC.filter(([, text]) => pefRe.test(text)).map(([p]) =>
        p.slice(SRC_ROOT.length + 1),
      )
      const rawOffenders = ALL_SRC.filter(([, text]) => rawRe.test(text)).map(([p]) =>
        p.slice(SRC_ROOT.length + 1),
      )
      // A looser reader is the SHARPEST bypass: it evades the gateOn/gateDisabled
      // accessor check above entirely while still broadening activation of the
      // dangerous capability. Any hit is a real security regression.
      expect({ parseEnvFlag: pefOffenders, rawCompare: rawOffenders }).toEqual({
        parseEnvFlag: [],
        rawCompare: [],
      })
    })
  }

  test("the src-wide dangerous-gate inventory is non-empty (guard is live, not vacuous)", () => {
    expect(DANGEROUS_GATES.length).toBeGreaterThanOrEqual(13)
  })

  test("the src walk actually read a substantial number of files (walk not broken)", () => {
    // Defends against a silently-empty readdir (e.g. wrong root) making every
    // 'present' assertion vacuously... fail, and every 'no-loose' vacuously pass.
    expect(ALL_SRC.length).toBeGreaterThan(100)
  })
})

// ─── F1/F2/F3 SELF-TESTS: red-on-injection + green-on-benign ─────────────────
//
// The src-wide assertions above are only as trustworthy as the detectors they
// run. These tests pin the DETECTOR behaviour against synthetic strings so a
// future refactor that silently re-narrows a regex (re-opening an evasion) goes
// RED here even when the live tree happens to be clean.

const CODE_MODE: DangerousGate = {
  literal: "QUANTA_CODE_MODE",
  kind: "on",
  aliases: ["QUANTA_CODE_MODE_ENV"],
  why: "self-test fixture",
}

describe("detector self-tests — red on each evasion form, green on benign comment", () => {
  // F1: env source is itself a CALL (parens) — old `[^,()]+` matcher missed this.
  test("F1 red-on-injection: loose matcher catches a paren-bearing env source", () => {
    const looseRe = callRe("gateOn", CODE_MODE)
    expect(`  if (gateOn(getEnv(), "QUANTA_CODE_MODE")) {`).toMatch(looseRe)
    // alias form with a call source is caught too
    expect(`gateOn(this.env(), QUANTA_CODE_MODE_ENV)`).toMatch(looseRe)
    // and it must NOT over-match across two adjacent unrelated calls / a comma
    // that would belong to a 3-arg call (no gate-name tail ⇒ no match)
    expect(`gateOn(getEnv(), "QUANTA_OTHER")`).not.toMatch(looseRe)
  })

  // F2: a comment/migration note mentioning a loose call must NOT trip the scan.
  test("F2 green-on-benign: a loose call appearing ONLY in a comment is stripped", () => {
    const looseRe = callRe("gateOn", CODE_MODE)
    const benign = stripComments(
      [
        '// jun-07: replaced gateOn(env, "QUANTA_CODE_MODE") with gateOnStrict',
        "/* migration: gateOn(getEnv(), QUANTA_CODE_MODE_ENV) is GONE */",
        'export const enabled = gateOnStrict(env, "QUANTA_CODE_MODE")',
      ].join("\n"),
    )
    // the comment mentions are gone; only the real strict call survives
    expect(benign).not.toMatch(looseRe)
    expect(benign).toMatch(callRe("gateOnStrict", CODE_MODE))
  })

  // F2 corollary: stripping must NOT eat a `//` that lives inside a string (URL).
  test("F2 green: comment-strip preserves `//` inside a string literal (URL)", () => {
    const kept = stripComments('const u = "https://example.com/QUANTA_CODE_MODE"')
    expect(kept).toContain("https://example.com/QUANTA_CODE_MODE")
  })

  // F2 corollary: stripping must NOT blank the gate-name arg of a REAL loose call
  // (the arg is code, not a comment) — a genuine regression still goes red.
  test("F2 red preserved: a REAL loose call (not in a comment) is still caught", () => {
    const looseRe = callRe("gateOn", CODE_MODE)
    const real = stripComments(
      '// note: code-mode\nconst on = gateOn(env, "QUANTA_CODE_MODE") // loosened!',
    )
    expect(real).toMatch(looseRe)
  })

  // F3: looser readers — parseEnvFlag + raw === compare — are detected.
  test("F3 red-on-injection: parseEnvFlag reader of a dangerous gate is caught", () => {
    const pefRe = parseEnvFlagRe(CODE_MODE)
    expect(`const on = parseEnvFlag(env.QUANTA_CODE_MODE, false)`).toMatch(pefRe)
    expect(`parseEnvFlag(env["QUANTA_CODE_MODE"], true)`).toMatch(pefRe)
    expect(`parseEnvFlag(process.env[QUANTA_CODE_MODE_ENV], false)`).toMatch(pefRe)
    // an unrelated gate must NOT trip this gate's detector
    expect(`parseEnvFlag(env.QUANTA_SOMETHING_ELSE, false)`).not.toMatch(pefRe)
  })

  test('F3 red-on-injection: raw `=== "on"|"true"|"yes"|"1"` compare is caught', () => {
    const rawRe = rawCompareRe(CODE_MODE)
    expect(`if (env.QUANTA_CODE_MODE === "on") {`).toMatch(rawRe)
    expect(`env["QUANTA_CODE_MODE"] === "true"`).toMatch(rawRe)
    expect(`QUANTA_CODE_MODE_ENV === "yes"`).toMatch(rawRe)
    expect(`raw === "1"` /* must reference the gate to count */).not.toMatch(rawRe)
    expect(`env.QUANTA_CODE_MODE === "1"`).toMatch(rawRe)
  })

  // F3 green: a raw compare that lives ONLY in a comment (the live tree has
  // exactly this at src/host/runtime/agent-arg-builder.ts) must NOT trip after
  // comment-stripping — proving the F2 strip protects the F3 reader scan too.
  test("F3 green-on-benign: a raw compare mentioned only in a comment is stripped", () => {
    const rawRe = rawCompareRe(CODE_MODE)
    const benign = stripComments('// tool menu byte-identical unless QUANTA_CODE_MODE === "1".')
    expect(benign).not.toMatch(rawRe)
  })
})
