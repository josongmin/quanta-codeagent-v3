/**
 * Silent-failure growth ratchet — repo-wide freeze on error-swallowing forms.
 *
 * Two swallow classes are counted across ALL of `src/` and pinned to a
 * strict-equal baseline (the jun-10 reliability audit's "no NEW silent
 * failure" rule). This complements — does not replace — the existing guards:
 *
 *   - `src-no-sketchy-code.test.ts` bans EMPTY `catch {}` bodies outright
 *     (curated allowlist). It does NOT see a bare catch with a non-empty
 *     body that still never looks at the error.
 *   - `silent-catch-24h-ratchet.test.ts` pins bare-catch counts in 5
 *     specific audited files. The other ~hundreds of src files had NO
 *     growth bound until this ratchet.
 *   - `terminal-defaults-ratchet.test.ts` already bans `process.exit` /
 *     stdio ownership outside app composition roots.
 *
 * Counted forms:
 *
 *   A. Bare `} catch {` — the error is never BOUND, so it cannot be logged,
 *      attributed, or rethrown. New code must bind and attribute:
 *      `} catch (e) { logger.warn(`<label>: ${errMessage(e)}`) }` (or rethrow
 *      / return a typed Result). Deliberate best-effort degrades are fine —
 *      they just have to say so through the logger with a stable label.
 *
 *   B. `.catch(() => null)` / `.catch(() => undefined)` — a promise
 *      rejection collapsed to a nullish value with zero attribution. New
 *      code should `.catch((e) => { logger.debug(`<label>: ${errMessage(e)}`); return null })`
 *      so the swallow is visible in telemetry.
 *
 *   C. `catch { return [] | {} | "" | 0 | false }` — fail-open masking: the
 *      caller cannot distinguish "probe failed" from "genuinely empty"
 *      (jun-10 silent-failure audit R3, finding #12).
 *
 *   D. Debug-only catch — `catch (e) {` whose FIRST non-comment statement is
 *      `logger.debug(` (jun-10 audit R1, findings #4/8/9/10/11: silent pump
 *      death surfaced only at debug verbosity). The promise twin
 *      (`.catch((e) => logger.debug(...))`) is zero-tolerance + pinned
 *      allowlist. By construction the form misses debug-then-rethrow blocks
 *      (those are fine) and catches where debug isn't first — acceptable
 *      narrowness, matches house norm.
 *
 *   E. Non-abortable sleep — `new Promise((r) => setTimeout(r, ms))` strands
 *      cancellation: an aborted turn keeps waiting the full delay (jun-10
 *      audit R2, findings #6/#22). New code must use the abort-aware sleep
 *      in src/agent/loop/sleep.ts.
 *
 *   F. `JSON.stringify` through a truncating write — `writeFileSync(p,
 *      JSON.stringify(v))` (and writeFile/Bun.write) torn by a crash leaves
 *      corrupt persisted state (jun-10 audit R5, findings #1/2/3/17/19).
 *      Route through `writeFileAtomic` in `@/storage` (ADR-0398). HONEST
 *      LIMITATION: this line-level form only sees an INLINE stringify — a
 *      `writeFileSync(p, json)` with the payload in a variable is invisible
 *      here and needs the per-site fixes + hellgates.
 *
 * Forms C–F follow the audit's "prod" definition: `src/` excluding
 * `__tests__/` dirs and `*.test.ts` (in-src test files exercise the banned
 * shapes on purpose). Forms A/B keep the original full-src walk their
 * baselines were pinned on — do not retro-filter them.
 *
 * Ratchet contract (house pattern, both-direction strict):
 *   - count > baseline → REGRESSION, fix the new swallow.
 *   - count < baseline → IMPROVEMENT, tighten the baseline constant in the
 *     same change so the next regression hits the new floor.
 *
 * NOTE on biome: `nursery/noFloatingPromises` / `noMisusedPromises` would
 * cover the unawaited-promise corner of this class, but both rules crash
 * biome 2.4.15's type-inference worker (stack overflow) on this repo —
 * re-evaluate on the next biome upgrade. Until then this ratchet + the
 * sketchy-code scanner are the enforcement surface.
 *
 * Pure regex over file contents; src/ only (tests exercise violations on
 * purpose). Read-only, deterministic across platforms.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative, sep } from "node:path"

const SRC = join(__dirname, "..", "..", "src")

/**
 * Strict-equal baselines, PROD-only (excludes `*.test.ts` + `__tests__/` — see
 * `isProdFile`), re-pinned 2026-06-10 on the post-fix tree.
 *
 * Why prod-only (changed from the original all-files scan): in-src hellgate
 * tests legitimately author `} catch {` / `.catch(() => null)` to exercise the
 * very failures these forms guard against, so an all-files count churned this
 * baseline on every test edit — a false REGRESSION signal that trains people to
 * bump the number reflexively (defeating the ratchet). Scoping to prod matches
 * forms C–F below and the audit's actual target: PROD silent failures. The
 * jun-10 fix sprint's net prod delta here is the gc.ts atomic/lock rewrite's
 * documented NO-THROW best-effort read helpers (`readFileSafe`/`fileSizeSafe`/…
 * — return a safe default for a missing/unreadable file, never mask a core
 * write); the core `writeAtomicTruncateSafe` surfaces failure as a `false`
 * return, not a swallow.
 */
const BARE_CATCH_BASELINE = 1003
const NULLISH_PROMISE_SWALLOW_BASELINE = 106

/**
 * Forms C–F: strict-equal baselines re-measured 2026-06-10 on the POST-fix
 * tree (the audit's pre-fix numbers were R3=94 / R1=11 / R2=5 / R5=13; the
 * 14 fix lanes moved several sites before these constants were pinned).
 */
const CATCH_RETURN_EMPTY_BASELINE = 97
const DEBUG_ONLY_CATCH_BASELINE = 7
const NON_ABORTABLE_SLEEP_BASELINE = 5
const STRINGIFY_TRUNCATING_WRITE_BASELINE = 9

// Same canonical form as silent-catch-24h-ratchet: no binding, swallowed.
// A bound `} catch (e) {` deliberately does NOT match.
const BARE_CATCH_RE = /\}\s*catch\s*\{/g

// Rejection collapsed to a nullish literal with no error binding.
const NULLISH_SWALLOW_RE = /\.catch\(\s*\(\)\s*=>\s*(?:null|undefined)\s*\)/g

// Form C — catch (bare) whose body is exactly `return <empty literal>`.
const CATCH_RETURN_EMPTY_RE = /catch \{\n\s*return (?:\[\]|\{\}|""|0|false)\n\s*\}/g

// Form D — bound catch whose first non-comment statement is logger.debug(.
const DEBUG_ONLY_CATCH_RE = /catch \(\w+\) \{\n(?:\s*\/\/[^\n]*\n)*\s*logger\.debug\(/g

// Form D promise twin — rejection handler that goes straight to logger.debug(.
const DEBUG_ONLY_PROMISE_RE = /\.catch\(\s*\(?\w*\)?\s*=>\s*\{?\s*logger\.debug\(/g

// Form E — raw timer sleep with no AbortSignal hook.
const NON_ABORTABLE_SLEEP_RE = /new Promise\(\s*\(?(?:r|res|resolve)\w*\)?\s*=>\s*setTimeout\(/g

// Form F — line-level: a write call with an INLINE JSON.stringify payload…
const STRINGIFY_WRITE_LINE_RE = /(?:writeFileSync|writeFile|Bun\.write)\([^\n]*JSON\.stringify/
// …unless the line itself is already on the atomic/temp-file path.
const STRINGIFY_WRITE_EXCLUDE_RE = /atomic|tmp/

const walk = (dir: string, out: string[]): string[] => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (extname(p) === ".ts" && !p.endsWith(".d.ts")) out.push(p)
  }
  return out
}

const isProdFile = (p: string): boolean =>
  !p.endsWith(".test.ts") && !p.includes(`${sep}__tests__${sep}`)

const countIn = (
  files: readonly string[],
  re: RegExp,
): { total: number; perFile: Map<string, number> } => {
  const perFile = new Map<string, number>()
  let total = 0
  for (const file of files) {
    const n = [...readFileSync(file, "utf8").matchAll(re)].length
    if (n > 0) {
      perFile.set(relative(SRC, file), n)
      total += n
    }
  }
  return { total, perFile }
}

const countAll = (re: RegExp): { total: number; perFile: Map<string, number> } =>
  countIn(walk(SRC, []), re)

/** Forms C–F scan PROD files only (audit definition; header explains why). */
const countProd = (re: RegExp): { total: number; perFile: Map<string, number> } =>
  countIn(walk(SRC, []).filter(isProdFile), re)

/** Form F is line-level (match + same-line exclusion), not a content regex. */
const countStringifyWrites = (): { total: number; perFile: Map<string, number> } => {
  const perFile = new Map<string, number>()
  let total = 0
  for (const file of walk(SRC, []).filter(isProdFile)) {
    let n = 0
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (STRINGIFY_WRITE_LINE_RE.test(line) && !STRINGIFY_WRITE_EXCLUDE_RE.test(line)) n++
    }
    if (n > 0) {
      perFile.set(relative(SRC, file), n)
      total += n
    }
  }
  return { total, perFile }
}

const explain = (
  label: string,
  observed: number,
  baseline: number,
  fix: string,
  perFile: Map<string, number>,
): string => {
  const direction =
    observed > baseline
      ? `REGRESSION: a new ${label} was added (${observed} > baseline ${baseline}). ${fix}`
      : `IMPROVEMENT: ${label} count dropped (${observed} < baseline ${baseline}). ` +
        `Tighten the baseline constant to ${observed} in the same change — ` +
        `the ratchet must move forward.`
  const top = [...perFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([f, n]) => `  ${n}× ${f}`)
    .join("\n")
  return `${direction}\nTo locate new sites, diff your branch and grep for the pattern. Top files:\n${top}`
}

describe("silent-failure growth ratchet (src/-wide, strict-equal)", () => {
  test(`bare \`} catch {\` count === ${BARE_CATCH_BASELINE} (prod)`, () => {
    const { total, perFile } = countProd(BARE_CATCH_RE)
    if (total !== BARE_CATCH_BASELINE) {
      throw new Error(
        explain(
          "bare `} catch {`",
          total,
          BARE_CATCH_BASELINE,
          "Bind and attribute the error: `} catch (e) { logger.warn(`<label>: ${errMessage(e)}`) }`, rethrow, or return a typed Result.",
          perFile,
        ),
      )
    }
    expect(total).toBe(BARE_CATCH_BASELINE)
  })

  // `@ts-ignore` suppresses ALL type errors on the next line FOREVER and
  // silently survives the underlying fix — the canonical silent-failure
  // suppression. `@ts-expect-error <reason>` is the allowed form (it fails
  // the build when the error disappears). Zero-baseline: src/ has no real
  // uses today; the only matches are string LITERALS inside the
  // suppression-comment detector itself, which are pinned exactly.
  // (This cannot live in src-no-sketchy-code.test.ts — its scanner skips
  // comment lines, and @ts-ignore always sits in a comment.)
  test("`@ts-ignore` is banned in src/ (use `@ts-expect-error <reason>`)", () => {
    const TS_IGNORE_RE = /@ts-ignore\b/g
    const LITERAL_ALLOWLIST: Readonly<Record<string, number>> = {
      // The detector names the pattern in string literals (`l.includes("@ts-ignore")`).
      "tool/file-tree-summary/index.ts": 1,
    }
    const { perFile } = countAll(TS_IGNORE_RE)
    const offenders: string[] = []
    for (const [file, n] of perFile) {
      const allowed = LITERAL_ALLOWLIST[file] ?? 0
      if (n !== allowed) offenders.push(`  ${file}: ${n} (allowed ${allowed})`)
    }
    if (offenders.length > 0) {
      throw new Error(
        "`@ts-ignore` found in src/ — swap to `// @ts-expect-error <reason>` " +
          "so the suppression dies with the error it suppresses:\n" +
          offenders.join("\n"),
      )
    }
    expect(offenders.length).toBe(0)
  })

  test(`\`.catch(() => null|undefined)\` count === ${NULLISH_PROMISE_SWALLOW_BASELINE} (prod)`, () => {
    const { total, perFile } = countProd(NULLISH_SWALLOW_RE)
    if (total !== NULLISH_PROMISE_SWALLOW_BASELINE) {
      throw new Error(
        explain(
          "`.catch(() => null|undefined)` promise swallow",
          total,
          NULLISH_PROMISE_SWALLOW_BASELINE,
          "Attribute before degrading: `.catch((e) => { logger.debug(`<label>: ${errMessage(e)}`); return null })`.",
          perFile,
        ),
      )
    }
    expect(total).toBe(NULLISH_PROMISE_SWALLOW_BASELINE)
  })

  // Form C (jun-10 audit R3) — fail-open masking via empty-literal return.
  test(`catch → return empty-literal count === ${CATCH_RETURN_EMPTY_BASELINE} (prod)`, () => {
    const { total, perFile } = countProd(CATCH_RETURN_EMPTY_RE)
    if (total !== CATCH_RETURN_EMPTY_BASELINE) {
      throw new Error(
        explain(
          "`catch { return []|{}|\"\"|0|false }` fail-open mask",
          total,
          CATCH_RETURN_EMPTY_BASELINE,
          "The caller cannot tell 'probe failed' from 'genuinely empty'. Degrade loudly: " +
            "return a typed `ok:false`/null result, or log first — " +
            "`} catch (e) { logger.debug(`<label>: ${errMessage(e)}`); return [] }`.",
          perFile,
        ),
      )
    }
    expect(total).toBe(CATCH_RETURN_EMPTY_BASELINE)
  })

  // Form D (jun-10 audit R1) — debug-only catch: a dying pump/transport is
  // visible only at debug verbosity, so prod death is silent (#4/8/9/10/11).
  test(`debug-only catch count === ${DEBUG_ONLY_CATCH_BASELINE} (prod)`, () => {
    const { total, perFile } = countProd(DEBUG_ONLY_CATCH_RE)
    if (total !== DEBUG_ONLY_CATCH_BASELINE) {
      throw new Error(
        explain(
          "debug-only `catch (e) { logger.debug(…)` block",
          total,
          DEBUG_ONLY_CATCH_BASELINE,
          "If the failure can strand pending work (pump/transport/exit paths), upgrade to " +
            "`logger.warn` AND propagate the failure (fireExit / failAllPending / rethrow). " +
            "Reserve `.debug` for documented teardown races — and document them.",
          perFile,
        ),
      )
    }
    expect(total).toBe(DEBUG_ONLY_CATCH_BASELINE)
  })

  // Form D promise twin — zero-tolerance + pinned per-file allowlist (the
  // house pattern of the @ts-ignore arm above). Pre-fix audit measured 0;
  // the jun-10 atomic-write fix lane added two LEGITIMATE best-effort
  // cleanups, pinned exactly so they cannot grow.
  test("`.catch((e) => logger.debug(…))` promise swallow is zero outside the pinned allowlist (prod)", () => {
    const PINNED_ALLOWLIST: Readonly<Record<string, number>> = {
      // Atomic-write cleanup path (jun-10 audit #17 fix): chmod mode-preserve
      // + temp-file unlink AFTER the real write error is already rethrown —
      // best-effort teardown with nothing left to surface.
      "migration/external-config/persist.ts": 2,
    }
    const { perFile } = countProd(DEBUG_ONLY_PROMISE_RE)
    const offenders: string[] = []
    for (const [file, n] of perFile) {
      const allowed = PINNED_ALLOWLIST[file] ?? 0
      if (n !== allowed) offenders.push(`  ${file}: ${n} (allowed ${allowed})`)
    }
    if (offenders.length > 0) {
      throw new Error(
        "debug-only promise rejection handler found in src/ — a rejection routed straight " +
          "to `logger.debug` is invisible in prod. Upgrade to `logger.warn` + propagate, or " +
          "rethrow after logging:\n" +
          offenders.join("\n"),
      )
    }
    expect(offenders.length).toBe(0)
  })

  // Form E (jun-10 audit R2) — non-abortable sleep strands cancellation.
  test(`non-abortable \`new Promise((r) => setTimeout(…))\` sleep count === ${NON_ABORTABLE_SLEEP_BASELINE} (prod)`, () => {
    const { total, perFile } = countProd(NON_ABORTABLE_SLEEP_RE)
    if (total !== NON_ABORTABLE_SLEEP_BASELINE) {
      throw new Error(
        explain(
          "non-abortable timer sleep",
          total,
          NON_ABORTABLE_SLEEP_BASELINE,
          "A raw `new Promise((r) => setTimeout(r, ms))` keeps waiting the full delay after " +
            "the turn is aborted. Use the abort-aware sleep in src/agent/loop/sleep.ts " +
            "(threads AbortSignal; settles immediately on abort) instead.",
          perFile,
        ),
      )
    }
    expect(total).toBe(NON_ABORTABLE_SLEEP_BASELINE)
  })

  // Form F (jun-10 audit R5) — JSON.stringify through a truncating write.
  test(`JSON.stringify through truncating write count === ${STRINGIFY_TRUNCATING_WRITE_BASELINE} (prod)`, () => {
    const { total, perFile } = countStringifyWrites()
    if (total !== STRINGIFY_TRUNCATING_WRITE_BASELINE) {
      throw new Error(
        explain(
          "`writeFile*(…, JSON.stringify(…))` truncating persisted-state write",
          total,
          STRINGIFY_TRUNCATING_WRITE_BASELINE,
          "A truncate-then-write torn by a crash leaves CORRUPT state on disk. Route persisted " +
            "JSON through `writeFileAtomic` in `@/storage` (ADR-0398: temp file + rename).",
          perFile,
        ),
      )
    }
    expect(total).toBe(STRINGIFY_TRUNCATING_WRITE_BASELINE)
  })
})
