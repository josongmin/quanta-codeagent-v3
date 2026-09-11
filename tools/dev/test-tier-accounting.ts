/**
 * `tools/dev/test-tier-accounting` — print, for every tier, the selection AND
 * its complement, with a reason per excluded file.
 *
 * # Why this exists as its own command
 *
 * `run-test-shards.ts --discover-only` emits a `selected` population whose
 * `excluded` array is hard-coded `[]`. So "PR runs 3,920 of 3,943" and "PR runs
 * 3,920 and that is the whole corpus" print identically, and the failure this
 * whole tier split risks — a file that falls out of EVERY tier — is invisible
 * from the discovery output that is supposed to describe the split.
 *
 * This computes the complement from the same policy resolution the runner uses,
 * checks that `selected + excluded` reconstructs the universe exactly, and
 * fails with a specific message when it does not. `handoff-tvh03.md` carries the
 * exact diff that makes `emitDiscovery` carry the same fields; until that lands,
 * this is the authority that can be run.
 *
 *   bun tools/dev/test-tier-accounting.ts              # table for all tiers
 *   bun tools/dev/test-tier-accounting.ts --json       # machine-readable
 *   bun tools/dev/test-tier-accounting.ts --tier=pr --show-excluded=20
 */

import { join } from "node:path"
import {
  assertTierAccounting,
  canaryPolicyIds,
  loadPolicyOverrides,
  resolveTestPopulation,
  selectTierMembership,
  type TestPolicy,
  type TierMembership,
} from "./test-policy"
import { discoverInventory } from "./test-shard-discovery"
import type { VerificationTier } from "./verification-result"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const TIERS: readonly VerificationTier[] = ["prepush", "pr", "full", "nightly"]

const digest = (ids: readonly string[]): string =>
  new Bun.CryptoHasher("sha256").update(ids.join("\0")).digest("hex")

export interface TierAccountingRow {
  readonly tier: VerificationTier
  readonly selected: number
  readonly excluded: number
  readonly universe: number
  readonly digestSha256: string
  /** Excluded counts grouped by reason class, so the table stays readable. */
  readonly excludedByClass: Readonly<Record<string, number>>
}

const classOf = (reason: string): string => {
  if (reason.startsWith("nightly-exhaustive")) return "nightly-exhaustive"
  if (reason.startsWith("capability group")) return "capability"
  if (reason.startsWith("not in the always-run canary")) return "not-canary"
  if (reason.startsWith("unenrolled")) return "unenrolled"
  return "other"
}

export const accountTier = (
  policies: readonly TestPolicy[],
  universe: readonly string[],
  tier: VerificationTier,
): { readonly row: TierAccountingRow; readonly membership: TierMembership } => {
  const membership = selectTierMembership(policies, tier)
  // Throws on a short sum, a double count, a lost file, or a blank reason —
  // this command must not be able to print a balanced-looking table over an
  // unbalanced selection.
  assertTierAccounting(membership, universe)
  const excludedByClass: Record<string, number> = {}
  for (const row of membership.excluded) {
    const key = classOf(row.reason)
    excludedByClass[key] = (excludedByClass[key] ?? 0) + 1
  }
  return {
    membership,
    row: {
      tier,
      selected: membership.selected.length,
      excluded: membership.excluded.length,
      universe: universe.length,
      digestSha256: digest(membership.selected),
      excludedByClass,
    },
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const flag = (name: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
  const wantJson = argv.includes("--json")
  const only = flag("--tier")
  const showExcluded = Number.parseInt(flag("--show-excluded") ?? "0", 10)

  const overrides = loadPolicyOverrides(
    join(REPO_ROOT, "tools/dev/test-policy-overrides.json"),
  ).overrides
  const universe = discoverInventory(REPO_ROOT).suites.full.files
  const policies = resolveTestPopulation(universe, overrides)
  const tiers = only === undefined ? TIERS : TIERS.filter((tier) => tier === only)
  if (tiers.length === 0) {
    process.stderr.write(`unknown tier: ${String(only)}\n`)
    process.exit(2)
  }

  const results = tiers.map((tier) => accountTier(policies, universe, tier))
  if (wantJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schema: "quanta.test-tier-accounting.v1",
          universe: universe.length,
          canary: canaryPolicyIds(policies),
          tiers: results.map(({ row }) => row),
        },
        null,
        2,
      )}\n`,
    )
  } else {
    process.stdout.write(
      `universe=${universe.length} (suite=full discovery)\n\n` +
        "tier      selected  excluded  sum   digest(16)        excluded-by-class\n",
    )
    for (const { row } of results) {
      const byClass = Object.entries(row.excludedByClass)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, count]) => `${key}=${count}`)
        .join(" ")
      process.stdout.write(
        `${row.tier.padEnd(9)}${String(row.selected).padStart(8)}${String(row.excluded).padStart(10)}` +
          `${String(row.selected + row.excluded).padStart(7)}  ${row.digestSha256.slice(0, 16)}  ${byClass}\n`,
      )
    }
    if (showExcluded > 0) {
      for (const { row, membership } of results) {
        process.stdout.write(`\n--- ${row.tier}: first ${showExcluded} exclusions ---\n`)
        for (const entry of membership.excluded.slice(0, showExcluded)) {
          process.stdout.write(`  ${entry.path}\n      ${entry.reason}\n`)
        }
      }
    }
  }
}
