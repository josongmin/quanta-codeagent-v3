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
import { extname, join, relative } from "node:path"

const SRC = join(__dirname, "..", "..", "src")

/** Strict-equal baselines, captured 2026-06-10 (jun-10 reliability audit). */
const BARE_CATCH_BASELINE = 1018
const NULLISH_PROMISE_SWALLOW_BASELINE = 105

// Same canonical form as silent-catch-24h-ratchet: no binding, swallowed.
// A bound `} catch (e) {` deliberately does NOT match.
const BARE_CATCH_RE = /\}\s*catch\s*\{/g

// Rejection collapsed to a nullish literal with no error binding.
const NULLISH_SWALLOW_RE = /\.catch\(\s*\(\)\s*=>\s*(?:null|undefined)\s*\)/g

const walk = (dir: string, out: string[]): string[] => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (extname(p) === ".ts" && !p.endsWith(".d.ts")) out.push(p)
  }
  return out
}

const countAll = (re: RegExp): { total: number; perFile: Map<string, number> } => {
  const perFile = new Map<string, number>()
  let total = 0
  for (const file of walk(SRC, [])) {
    const n = [...readFileSync(file, "utf8").matchAll(re)].length
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
  test(`bare \`} catch {\` count === ${BARE_CATCH_BASELINE}`, () => {
    const { total, perFile } = countAll(BARE_CATCH_RE)
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

  test(`\`.catch(() => null|undefined)\` count === ${NULLISH_PROMISE_SWALLOW_BASELINE}`, () => {
    const { total, perFile } = countAll(NULLISH_SWALLOW_RE)
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
})
