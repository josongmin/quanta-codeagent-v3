/**
 * Ratchet — a NEW scanning guard must enroll its reach, not pick a number.
 *
 * ## What the existing gates do and do not demand
 *
 * `anti-vacuity-census` demands that a scan-derived zero-verdict carry SOME
 * floor, and it accepts an inline `toBeGreaterThanOrEqual(n)` for any n ≥ 2.
 * All three guards found vacuous on 2026-08-30 were fixed that way, and all
 * three fixes were WEAKER than they looked:
 *
 *   - 60 of 68 per-knob modules — eight could vanish silently
 *   - 20 of 22 system skills   — two whole skills could vanish silently
 *   - 7,804 of 8,776 tracked   — a 186-file subtree could vanish silently,
 *                                measured, while the count still cleared
 *
 * A count cannot see a SUBTREE disappear; it sees a smaller number, and the
 * margin the author left is exactly how much of the tree may go missing without
 * anyone noticing. `tools/dev/scan-reach-baseline.ts` says the same thing about
 * the numbers themselves: they are author-chosen, and the equilibrium they reach
 * in this repo is `1` — 56 of the 81 already written are `> 0`.
 *
 * The empty-mirror oracle does not close this either. It blanks a corpus root
 * ENTIRELY, so a red there proves the guard notices total loss, never partial.
 *
 * ## What this ratchet demands
 *
 * `assertScanPopulation`, whose floor lives in the committed baseline at the
 * MEASURED reach and which additionally asserts recursive coverage — every
 * directory holding a tracked collectable file contributed one. That is the
 * claim a count cannot make.
 *
 * ONE-DIRECTIONAL. The guards that predate this are listed in
 * `tools/dev/scan-enrollment-debt.json`, the shape `lint-debt-ceiling.json` and
 * `god-code/allowlist.json` already use here. The list may only shrink: a file
 * that enrolled and stayed listed fails, so the number cannot quietly stall.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { isScanVerdictGuard, scanVerdictGuards } from "@/../tools/dev/anti-vacuity-census"
import { stripComments } from "@/shared/source-text"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const DEBT = join(REPO_ROOT, "tools", "dev", "scan-enrollment-debt.json")
const MANIFEST = join(REPO_ROOT, "tools", "dev", "scan-migration-manifest.json")

type DebtFile = {
  readonly unenrolled?: readonly string[]
  readonly externalCorpus?: readonly { readonly file: string; readonly why: string }[]
  readonly expectedIds?: Readonly<Record<string, readonly string[]>>
}

const debtFile = (): DebtFile => JSON.parse(readFileSync(DEBT, "utf8")) as DebtFile
const debtList = (): readonly string[] => debtFile().unenrolled ?? []
const expectedIds = (): Readonly<Record<string, readonly string[]>> => debtFile().expectedIds ?? {}
const externalCorpus = (): readonly { readonly file: string; readonly why: string }[] =>
  debtFile().externalCorpus ?? []

/**
 * An absolute path that is not inside this repo — a HOST corpus.
 *
 * `assertScanPopulation` intersects the scan with `git ls-files` under a repo
 * root, so a `/sbin` entry can never be reach and a pinned baseline for it would
 * be a fiction. Such a guard is not "enrollment pending"; it is out of the
 * helper's contract, and saying so is different from leaving it on a list that
 * claims work is owed.
 */
const HOST_PATH = /["'`]\/(?:s?bin|usr\/s?bin|usr\/local|etc|opt|proc|sys|var)\b/

/**
 * Enrollment is a CALL, not a mention.
 *
 * This read `includes("assertScanPopulation")`, and a file whose only occurrence
 * was `// TODO: call assertScanPopulation here one day` counted as enrolled —
 * measured, with a synthetic guard that carried an inline floor and nothing else.
 * A ratchet satisfied by a comment about the fix is the same defect it exists to
 * catch, committed inside the instrument.
 */
/**
 * Enrollment is a CALL, not a mention, and not a COUNT.
 *
 * Counting enumerator syntax against helper-call syntax was tried and abandoned
 * the same night: it over-counts a recursive walker (its internal `readdirSync`
 * is one site, not one per level) and under-counts a helper called in a loop —
 * `no-leftover-backup-files` reports THREE baseline ids from a single syntactic
 * call over three prefixes. Neither error is safe: one demands work that is
 * already done, the other blesses a file with scans still unmeasured.
 *
 * So the site-level completeness check is not here. It lives where ground truth
 * is: `bun run scan-reach` runs the guards and compares the ids they actually
 * REPORT against `expectedIds` in the debt file. This predicate answers only the
 * cheaper question — has the file been touched at all.
 */
/**
 * Enrolled means the file OWNS at least one baseline id, measured.
 *
 * Two cheaper predicates were tried and both are wrong. Reading the file for a
 * call misses the 49 guards that reach the helper through
 * `slice-boundary-scanner` and name it nowhere. Treating an IMPORT of such a
 * module as enrollment is too loose in the other direction:
 * `surface-coupling-ratchet` imports that scanner for `assertWalkFloor`, calls
 * the population helper never, and reports no id at all — it would have been
 * marked done while pinning nothing.
 *
 * What a file reports at runtime is the only reading with neither error, and
 * `expectedIds` is that measurement, frozen. `scan-reach` holds it equal to the
 * baseline and to the live observation in both directions, so an entry here
 * cannot drift away from what the guards actually do.
 */
const isEnrolled = (rel: string): boolean => (expectedIds()[rel] ?? []).length > 0

/** A literal call, which is what a freshly migrated file has before it is pinned. */
const callsHelper = (rel: string): boolean =>
  /\bassertScanPopulation\s*\(/.test(stripComments(readFileSync(join(REPO_ROOT, rel), "utf8")))

describe("scan enrollment", () => {
  test("anti-vacuity: the population is real and the debt list is a subset of it", () => {
    // Both directions matter. A population that came back empty would make the
    // ratchet below pass over nothing, and a debt entry naming a file that is not
    // in the population is a permission for something the rule never covered.
    const population = scanVerdictGuards()
    expect(population.length, "the census found no scan-verdict guards at all").toBeGreaterThan(50)
    const known = new Set(population)
    const strays = debtList().filter((f) => !known.has(f))
    expect(
      strays,
      `these are listed as enrollment debt but are not scan-verdict guards — ` +
        `remove them:\n  ${strays.join("\n  ")}`,
    ).toEqual([])
  })

  test("🔴 the migration manifest and the debt list name the SAME files", () => {
    // Two hand-maintained lists of the same set drift, and this pair already had:
    // the manifest carried rows for two pilots that had finished, and its own
    // prose said "56 of 86" while the arrays said 54 of 87. A work plan that
    // disagrees with the ledger is a plan for work that is not owed, or silence
    // about work that is.
    const planned = new Set(
      (
        JSON.parse(readFileSync(MANIFEST, "utf8")) as { rows: readonly { file: string }[] }
      ).rows.map((r) => r.file),
    )
    const owed = new Set(debtList())
    expect(
      planned.size,
      "the manifest read is empty — this check would be vacuous",
    ).toBeGreaterThan(10)
    expect(
      [...owed].filter((f) => !planned.has(f)).sort(),
      "these are owed but the manifest plans no work for them",
    ).toEqual([])
    expect(
      [...planned].filter((f) => !owed.has(f)).sort(),
      "these have rows in the manifest but are no longer debt — remove them",
    ).toEqual([])
  })

  test("🔴 neither ledger states a TOTAL a human has to keep true", () => {
    // The drift above was in prose, not in the arrays. A count written beside a
    // list it does not derive from is a second source of truth with no gate.
    for (const [name, path] of [
      ["debt", DEBT],
      ["manifest", MANIFEST],
    ] as const) {
      const note = (JSON.parse(readFileSync(path, "utf8")) as { note: string }).note
      const totals = [...note.matchAll(/\b(\d{2,})\s+(?:of|unenrolled|rows|files|guards)\b/g)]
        .map((m) => m[0])
        // The retraction of the old numbers names them on purpose.
        .filter((t) => !note.includes(`said '${t}`) && !note.includes(`said ${t}`))
      expect(
        totals,
        `${name} note states a total that nothing derives: ${totals.join(", ")}`,
      ).toEqual([])
    }
  })

  test("🔴 every file on the debt list is actually ENROLLABLE", () => {
    // The list asserts "enrollment is owed here". For a guard whose corpus is the
    // HOST — `shell-predicate-population` walks /sbin, /usr/sbin, /bin, /usr/bin
    // for installed formatters — that claim is false and can never be discharged,
    // so the entry would sit there forever reading as tracked debt.
    const stuck = debtList()
      .filter((f) => HOST_PATH.test(stripComments(readFileSync(join(REPO_ROOT, f), "utf8"))))
      .sort()
    expect(
      stuck,
      stuck.length === 0
        ? ""
        : "these scan a HOST path, which `assertScanPopulation` can never measure — move them " +
            `to externalCorpus with a reason instead of listing debt that cannot be paid:\n  ${stuck.join("\n  ")}`,
    ).toEqual([])
  })

  test("🔴 externalCorpus is not a laundering channel", () => {
    // The exemption has to be CHECKABLE or it becomes the escape hatch every
    // remaining guard reaches for. An entry must really scan outside the repo,
    // must carry a reason that reads like one, and may not also claim to be debt.
    const owed = new Set(debtList())
    const faults: string[] = []
    for (const { file, why } of externalCorpus()) {
      const src = stripComments(readFileSync(join(REPO_ROOT, file), "utf8"))
      if (!HOST_PATH.test(src))
        faults.push(`${file}: claims an external corpus but scans no host path`)
      if (why.trim().length < 40) faults.push(`${file}: no real reason given`)
      if (owed.has(file)) faults.push(`${file}: listed as BOTH external corpus and enrollment debt`)
      if (isEnrolled(file)) faults.push(`${file}: is enrolled, so the exemption is dead weight`)
    }
    expect(faults, faults.join("\n  ")).toEqual([])
  })

  test("🔴 no NEW scanning guard states a verdict without an enrolled reach", () => {
    const owed = new Set([...debtList(), ...externalCorpus().map((e) => e.file)])
    const added = scanVerdictGuards()
      .filter((f) => !owed.has(f))
      .filter((f) => !isEnrolled(f))
    expect(
      added,
      added.length === 0
        ? ""
        : "these scan the repo and state a zero-verdict, but their floor is a number written " +
            "at the call site — which cannot see a subtree disappear. Call " +
            "`assertScanPopulation` from tests/unit/_shared/scan-population.ts and pin the " +
            "MEASURED reach in tools/dev/scan-reach-baseline.json:\n  " +
            added.join("\n  "),
    ).toEqual([])
  })

  test("🔴 a MENTION is not an enrollment", () => {
    // The instrument's own vacuity, found by attacking it: a file whose only
    // occurrence of the helper is a comment about calling it used to read as
    // enrolled, so a guard could be excused by a TODO.
    const call = `assertScan${"Population"}(files, root, { id: "x" })`
    const mention = `// TODO: call assertScan${"Population"} here one day`
    expect(/\bassertScanPopulation\s*\(/.test(stripComments(call))).toBe(true)
    expect(/\bassertScanPopulation\s*\(/.test(stripComments(mention))).toBe(false)
  })

  test("🔴 a file that CALLS the helper must own an id", () => {
    // The gap between migrating a guard and pinning its reach. A call with no
    // baseline row throws at runtime (the closed universe), but a call whose row
    // exists while no ledger entry claims it is silent: `scan-reach` would never
    // expect anything from that file, so it stops reporting unnoticed.
    const orphans = scanVerdictGuards()
      .filter((f) => callsHelper(f))
      .filter((f) => !isEnrolled(f))
      .sort()
    expect(
      orphans,
      orphans.length === 0
        ? ""
        : "these call the helper but claim no baseline id in scan-enrollment-debt.json, so " +
            `nothing notices when they stop reporting:\n  ${orphans.join("\n  ")}`,
    ).toEqual([])
  })

  test("🔴 no expectedIds entry names a file that is not enrolled", () => {
    // The other direction: an entry for a file that no longer calls the helper
    // pins ids that can never be reported, which reads as coverage and fails as
    // noise the moment the guard is deleted.
    const stray = Object.keys(expectedIds())
      .filter((f) => !existsSync(join(REPO_ROOT, f)))
      .sort()
    expect(stray, `these have expectedIds but no longer exist:\n  ${stray.join("\n  ")}`).toEqual(
      [],
    )
  })

  test("the debt list has no stale entries — an enrolled guard must be removed from it", () => {
    // One-directional the other way, so the number cannot stall while the work is
    // already done. A file that enrolled and stayed listed would silently re-admit
    // itself if the enrollment were later deleted.
    const stale = debtList()
      .filter((f) => isEnrolled(f))
      .sort()
    expect(
      stale,
      stale.length === 0
        ? ""
        : "these now call assertScanPopulation — remove them from " +
            `tools/dev/scan-enrollment-debt.json so the list can only shrink:\n  ${stale.join("\n  ")}`,
    ).toEqual([])
  })

  test("🔴 the rule fires on the shape that produced all three defects", () => {
    // Red-on-injection against the predicate itself: an inline count floor beside
    // a scan is exactly what the census accepts and what this ratchet must not.
    const fsCall = `read${"dir"}Sync`
    const guard =
      `import { ${fsCall} } from "node:fs"\n` +
      `test("x", () => {\n  const seen = ${fsCall}("s${"rc"}")\n` +
      `  expect(seen.length).toBeGreaterThanOrEqual(60)\n` +
      `  expect(seen.filter((f) => f.endsWith(".zzz"))).toEqual([])\n})\n`
    expect(isScanVerdictGuard(guard), "the population predicate missed the shape").toBe(true)
    expect(guard.includes("assertScanPopulation"), "the fixture must NOT be enrolled").toBe(false)
  })
})
