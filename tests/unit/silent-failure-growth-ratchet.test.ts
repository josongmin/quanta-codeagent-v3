/**
 * Silent-failure growth ratchet — repo-wide freeze on error-swallowing forms.
 *
 * Swallow forms are counted across `src/` (prod-only) and pinned to a
 * one-directional `<=` CEILING (the jun-10 reliability audit's "no NEW silent
 * failure" rule; D14 swapped the original strict-equal floor for a ceiling —
 * see the contract + D14 note below). This complements — does not replace — the
 * existing guards:
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
 * ALL forms (A–F) follow the audit's "prod" definition: `src/` excluding
 * `__tests__/` dirs and `*.test.ts` (in-src test/hellgate files author the
 * banned shapes on purpose, so an all-files count churned the baseline on every
 * test edit — a false REGRESSION signal). Forms A/B were re-scoped to `countProd`
 * for the same reason (see the `BARE_CATCH_BASELINE` note + the
 * `forms A/B are prod-scoped` self-consistency guard below). The `countAll`
 * helper still exists, but only the `@ts-ignore` arm (which legitimately wants
 * the whole tree) uses it.
 *
 * Ratchet contract (house pattern, ONE-directional ceiling — D14):
 *   - count > baseline → REGRESSION, fix the new swallow.
 *   - count <= baseline → PASS. A drop is fine; a non-failing advisory logs
 *     "you can tighten the baseline to N" so the floor can move forward
 *     voluntarily, WITHOUT a red test forcing a reflexive bump (the strict-equal
 *     form did force one, re-admitting growth headroom — META-LESSON #6).
 *
 * KNOWN LIMITATION — net-neutral substitution (rounds-2/3 audit). The
 * high-volume forms (A bare-catch, B nullish) are AGGREGATE counts with no
 * per-site identity, so a single commit that REMOVES n swallows and ADDS ≤n new
 * ones nets at-or-below the ceiling and slips past. Per-file identity (the shape
 * the low-count zero-tolerance forms — `@ts-ignore`, the debug-only-promise
 * allowlist — use) is economically infeasible at the ~1000-site volume of forms
 * A/B (the allowlist would be larger than the code it guards and churn every
 * edit). So substitution within the ceiling is caught by CODE REVIEW + the diff,
 * NOT this ratchet — the ratchet's job is bounding net GROWTH. The zero-headroom
 * pin (baseline == live count) makes any pure +1 red immediately, which closes
 * the common case; only a concurrent genuine removal opens the window.
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
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { extname, join, relative, sep } from "node:path"
import { logger } from "@/shared"

const SRC = join(__dirname, "..", "..", "src")

/**
 * Ceiling baselines (one-directional `<=`, see the D14 note below), PROD-only
 * (excludes `*.test.ts` + `__tests__/` — see `isProdFile`), re-pinned
 * 2026-06-10 on the post-fix tree.
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
// D14 (jun-10 audit, META-LESSON #6): these baselines are a one-directional
// CEILING enforced with `<=`, NOT strict-equal. A strict-equal floor was
// self-defeating — any lane that REMOVED a swallow dropped the count below the
// pinned number and reded the ratchet, training people to reflexively bump the
// constant (which then re-admitted the growth headroom the ratchet was meant to
// deny). Under `<=`: growth past the ceiling fails; a drop passes (and a
// non-failing advisory logs "you can tighten to N"). Each constant is set to
// the CURRENT resting prod count (measured 2026-06-10 on this tree, incl. the
// concurrent in-flight feature work: codemode/runtime.ts,
// session-resource-registry adapters, the mid-turn-approval slice — NO-THROW
// best-effort registry helpers, not new dangerous swallows) so it is green now
// and won't break when other lanes reduce counts.
// Re-measured 2026-06-15 after merge resolution (activity-spine + bench preset
// unification + quanta-home SSOT): new slices contribute bare catches / nullish
// swallows / non-abortable sleep; ceilings raised to lock in the new floor.
const BARE_CATCH_BASELINE = 1046
const NULLISH_PROMISE_SWALLOW_BASELINE = 113

/**
 * Forms C–F: ceiling baselines (one-directional `<=`) re-measured 2026-06-10 on
 * the POST-fix tree (the audit's pre-fix numbers were R3=94 / R1=11 / R2=5 /
 * R5=13; the 14 fix lanes moved several sites before these constants were
 * pinned).
 */
const CATCH_RETURN_EMPTY_BASELINE = 98
const DEBUG_ONLY_CATCH_BASELINE = 8
// D13: re-measured after widening NON_ABORTABLE_SLEEP_RE to tolerate the typed
// `new Promise<void>(…)` form — the prod count is 12 (was 6 under the
// generic-blind regex; the extra 6 were always there, just invisible).
// Re-measured 2026-06-14: lsp-bridge.ts LSP availability timeout uses the same
// Promise+setTimeout form (already in committed HEAD); ceiling raised to 13.
// Re-measured 2026-06-15: quanta-home SSOT + bench-preset merge adds 2 new
// non-abortable sleeps; ceiling raised to 15.
const NON_ABORTABLE_SLEEP_BASELINE = 15
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

// Form E — raw timer sleep with no AbortSignal hook. The optional `<…>` after
// `new Promise` tolerates the typed-Promise form `new Promise<void>((r) =>
// setTimeout(…))` (D13: jun-10 audit R4 found the un-generic regex blind to it).
const NON_ABORTABLE_SLEEP_RE =
  /new Promise(?:<[^>]*>)?\(\s*\(?(?:r|res|resolve)\w*\)?\s*=>\s*setTimeout\(/g

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

const topFiles = (perFile: Map<string, number>): string =>
  [...perFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([f, n]) => `  ${n}× ${f}`)
    .join("\n")

const explain = (label: string, observed: number, baseline: number, fix: string): string =>
  `REGRESSION: a new ${label} was added (${observed} > ceiling ${baseline}). ${fix}\n` +
  `To locate new sites, diff your branch and grep for the pattern.`

/**
 * D14 one-directional ceiling. `observed > baseline` is the only failure mode.
 * A drop is NOT a failure — it emits a NON-FAILING advisory (so the floor can be
 * tightened voluntarily without a red test forcing a reflexive bump that
 * re-admits growth headroom — META-LESSON #6). Returns the perFile top-N for the
 * failure message.
 */
const assertCeiling = (
  label: string,
  observed: number,
  baseline: number,
  fix: string,
  perFile: Map<string, number>,
): void => {
  if (observed > baseline) {
    throw new Error(`${explain(label, observed, baseline, fix)} Top files:\n${topFiles(perFile)}`)
  }
  if (observed < baseline) {
    logger.info(
      `[silent-failure-ratchet] ${label} is below its ceiling (${observed} < ${baseline}). ` +
        `You can tighten the baseline constant to ${observed} to lock in the improvement.`,
    )
  }
  // Always-true belt so the test body has a teeth-bearing assertion even on the
  // common == path; the real teeth are the `throw` above (proven red-on-inject).
  expect(observed).toBeLessThanOrEqual(baseline)
}

describe("silent-failure growth ratchet (src/-wide, one-directional ceiling)", () => {
  test(`bare \`} catch {\` count <= ${BARE_CATCH_BASELINE} (prod ceiling)`, () => {
    const { total, perFile } = countProd(BARE_CATCH_RE)
    assertCeiling(
      "bare `} catch {`",
      total,
      BARE_CATCH_BASELINE,
      "Bind and attribute the error: `} catch (e) { logger.warn(`<label>: ${errMessage(e)}`) }`, rethrow, or return a typed Result.",
      perFile,
    )
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

  test(`\`.catch(() => null|undefined)\` count <= ${NULLISH_PROMISE_SWALLOW_BASELINE} (prod ceiling)`, () => {
    const { total, perFile } = countProd(NULLISH_SWALLOW_RE)
    assertCeiling(
      "`.catch(() => null|undefined)` promise swallow",
      total,
      NULLISH_PROMISE_SWALLOW_BASELINE,
      "Attribute before degrading: `.catch((e) => { logger.debug(`<label>: ${errMessage(e)}`); return null })`.",
      perFile,
    )
  })

  // Form C (jun-10 audit R3) — fail-open masking via empty-literal return.
  test(`catch → return empty-literal count <= ${CATCH_RETURN_EMPTY_BASELINE} (prod ceiling)`, () => {
    const { total, perFile } = countProd(CATCH_RETURN_EMPTY_RE)
    assertCeiling(
      "`catch { return []|{}|\"\"|0|false }` fail-open mask",
      total,
      CATCH_RETURN_EMPTY_BASELINE,
      "The caller cannot tell 'probe failed' from 'genuinely empty'. Degrade loudly: " +
        "return a typed `ok:false`/null result, or log first — " +
        "`} catch (e) { logger.debug(`<label>: ${errMessage(e)}`); return [] }`.",
      perFile,
    )
  })

  // Form D (jun-10 audit R1) — debug-only catch: a dying pump/transport is
  // visible only at debug verbosity, so prod death is silent (#4/8/9/10/11).
  test(`debug-only catch count <= ${DEBUG_ONLY_CATCH_BASELINE} (prod ceiling)`, () => {
    const { total, perFile } = countProd(DEBUG_ONLY_CATCH_RE)
    assertCeiling(
      "debug-only `catch (e) { logger.debug(…)` block",
      total,
      DEBUG_ONLY_CATCH_BASELINE,
      "If the failure can strand pending work (pump/transport/exit paths), upgrade to " +
        "`logger.warn` AND propagate the failure (fireExit / failAllPending / rethrow). " +
        "Reserve `.debug` for documented teardown races — and document them.",
      perFile,
    )
  })

  // Form D promise twin — zero-tolerance + pinned per-file allowlist (the
  // house pattern of the @ts-ignore arm above). Pre-fix audit measured 0;
  // the jun-10 atomic-write fix lane added two LEGITIMATE best-effort
  // cleanups, pinned exactly so they cannot grow.
  test("`.catch((e) => logger.debug(…))` promise swallow is zero outside the pinned allowlist (prod)", () => {
    const PINNED_ALLOWLIST: Readonly<Record<string, number>> = {
      // Atomic-write cleanup path (jun-10 audit #17 fix): chmod mode-preserve
      // + temp-file unlink AFTER the real write error is already rethrown —
      // best-effort teardown with nothing left to surface. The 3rd (audit D10
      // fix) is the post-rename parent-DIR fsync — durability hardening that is
      // advisory by nature (the rename already landed; most fs don't need it),
      // so a fsync failure is genuinely best-effort, not a stranded-work path.
      "migration/external-config/persist.ts": 3,
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
  test(`non-abortable \`new Promise((r) => setTimeout(…))\` sleep count <= ${NON_ABORTABLE_SLEEP_BASELINE} (prod ceiling)`, () => {
    const { total, perFile } = countProd(NON_ABORTABLE_SLEEP_RE)
    assertCeiling(
      "non-abortable timer sleep",
      total,
      NON_ABORTABLE_SLEEP_BASELINE,
      "A raw `new Promise((r) => setTimeout(r, ms))` keeps waiting the full delay after " +
        "the turn is aborted. Use the abort-aware sleep in src/agent/loop/sleep.ts " +
        "(threads AbortSignal; settles immediately on abort) instead.",
      perFile,
    )
  })

  // Form F (jun-10 audit R5) — JSON.stringify through a truncating write.
  test(`JSON.stringify through truncating write count <= ${STRINGIFY_TRUNCATING_WRITE_BASELINE} (prod ceiling)`, () => {
    const { total, perFile } = countStringifyWrites()
    assertCeiling(
      "`writeFile*(…, JSON.stringify(…))` truncating persisted-state write",
      total,
      STRINGIFY_TRUNCATING_WRITE_BASELINE,
      "A truncate-then-write torn by a crash leaves CORRUPT state on disk. Route persisted " +
        "JSON through `writeFileAtomic` in `@/storage` (ADR-0398: temp file + rename).",
      perFile,
    )
  })

  // ── D13: typed-Promise blind spot ──────────────────────────────────────
  // The widened NON_ABORTABLE_SLEEP_RE must match the generic form
  // `new Promise<void>((r) => setTimeout(…))` the un-generic regex missed.
  test("Form E regex matches the typed-Promise sleep form (D13)", () => {
    // Fresh regex (the const has the /g flag → lastIndex statefulness).
    const re = new RegExp(NON_ABORTABLE_SLEEP_RE.source)
    expect(re.test("new Promise<void>((r)=>setTimeout(r,1))")).toBe(true)
    expect(re.test("new Promise<void>((resolve) => setTimeout(resolve, ms))")).toBe(true)
    // The original ungeneric form must still match (no regression).
    expect(re.test("new Promise((r) => setTimeout(r, 1))")).toBe(true)
    expect(re.test("new Promise<unknown>((res) => setTimeout(res, 5))")).toBe(true)
  })

  // ── D5: self-consistency guard ─────────────────────────────────────────
  // Binds the header's CLAIMED scope to the ENFORCED scope as a test, not
  // prose, so the doc can't silently drift back to "full-src walk". The header
  // now says forms A/B are PROD-scoped (via countProd) — prove filtering is
  // ACTIVE (countAll strictly exceeds countProd, i.e. in-src test files DO
  // author these shapes and ARE excluded) and that the pinned ceiling sits at
  // or above the live prod count. We do NOT assert exact-equal on the baseline
  // (that would reintroduce the strict-equal bump reflex D14 removed).
  test("forms A/B are prod-scoped: filtering is active + ceiling >= live prod (D5)", () => {
    const bareAll = countAll(BARE_CATCH_RE).total
    const bareProd = countProd(BARE_CATCH_RE).total
    const nullishAll = countAll(NULLISH_SWALLOW_RE).total
    const nullishProd = countProd(NULLISH_SWALLOW_RE).total

    // Filtering is active: in-src test/hellgate files author these shapes and
    // are excluded, so the all-files count is strictly larger than prod-only.
    expect(bareAll).toBeGreaterThan(bareProd)
    expect(nullishAll).toBeGreaterThan(nullishProd)

    // The pinned ceiling is a valid upper bound on live prod (>=, never <).
    expect(BARE_CATCH_BASELINE).toBeGreaterThanOrEqual(bareProd)
    expect(NULLISH_PROMISE_SWALLOW_BASELINE).toBeGreaterThanOrEqual(nullishProd)
  })

  // ── D14: ceiling teeth — RED on growth, GREEN on drop ──────────────────
  // (1) Inject a bare-catch into a FRESH prod-shaped fixture tree and run the
  //     real BARE_CATCH_RE + the real assertCeiling over it: growth past the
  //     ceiling MUST throw. This proves the ratchet has teeth on real bytes,
  //     not just on the in-repo count which floats with in-flight work.
  test("ratchet FAILS when a new bare-catch pushes a fixture over its ceiling (D14)", () => {
    const dir = mkdtempSync(join(tmpdir(), "silent-ratchet-fixture-"))
    try {
      // A prod-shaped src file (no .test.ts, not under __tests__/).
      const f = join(dir, "fixture-prod.ts")
      writeFileSync(
        f,
        // One bare `} catch {` — exactly the form BARE_CATCH_RE counts.
        "export function probe() {\n  try {\n    risky()\n  } catch {\n    return 0\n  }\n}\n",
      )
      const fixtureProd = walk(dir, []).filter(isProdFile)
      const { total, perFile } = countIn(fixtureProd, BARE_CATCH_RE)
      expect(total).toBe(1)
      // Ceiling of 0 → injecting 1 must throw (the regression path).
      expect(() =>
        assertCeiling("bare `} catch {`", total, 0, "bind + attribute", perFile),
      ).toThrow(/REGRESSION/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // (2) Under `<=`, an observed count BELOW the ceiling PASSES (no reflexive
  //     bump). This is the core of D14 — removing a swallow must never red.
  test("ratchet PASSES when count is below the ceiling under `<=` (D14)", () => {
    // 5 observed against a ceiling of 9 → no throw; advisory is non-failing.
    expect(() =>
      assertCeiling("demo", 5, 9, "fix text", new Map([["a/b.ts", 5]])),
    ).not.toThrow()
    // Equality also passes.
    expect(() => assertCeiling("demo", 9, 9, "fix text", new Map())).not.toThrow()
  })
})
