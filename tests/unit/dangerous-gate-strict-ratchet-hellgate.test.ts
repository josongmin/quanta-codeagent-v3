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
    kind: "on",
    aliases: ["STALE_READ_GUARD_ENV"],
    why: "fs-safety: arms the stale-read guard (blocks edits to files mutated since last read)",
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

const ALL_SRC = readAllSrc()

/** Escape a string for use as a literal inside a RegExp. */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Build the union of arg spellings for a gate: the quoted literal OR any const
 *  alias. e.g. (?:"QUANTA_CODE_MODE"|QUANTA_CODE_MODE_ENV) */
const argAlternation = (g: DangerousGate): string => {
  const parts = [`"${esc(g.literal)}"`, ...g.aliases.map(esc)]
  return `(?:${parts.join("|")})`
}

/** `<accessor>(<anything-no-comma>, <arg>)` — matches the call by accessor name
 *  and arg (literal or const), tolerant of whitespace. The first arg is the env
 *  source (any non-paren, non-comma run), the second is the gate name. */
const callRe = (accessor: string, g: DangerousGate): RegExp =>
  new RegExp(`\\b${accessor}\\s*\\(\\s*[^,()]+,\\s*${argAlternation(g)}\\s*\\)`)

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
