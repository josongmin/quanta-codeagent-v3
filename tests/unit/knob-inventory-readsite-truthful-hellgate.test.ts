/**
 * KNOB-INVENTORY readSite TRUTHFULNESS ratchet.
 *
 * The completeness ratchet only proves each envKey is read *somewhere*; nothing
 * verified the per-entry `readSite` STRING actually points at a file that reads
 * that key. So stale readSites accumulated silently (jun-15 audit found two:
 * QUANTA_MENTION_SYMBOL → assembler.ts that never reads it, and
 * QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL → driver.ts). `readSite` is the field
 * `/knobs` + discoverability point operators at, so a lie here mis-routes a
 * human debugging "why is this knob on".
 *
 * RULE (exact, count 0): for every KNOB_INVENTORY entry, the `readSite` file
 * MUST exist under src/ AND contain the envKey literal. NOT a burn-down — the
 * two known offenders were fixed in the same change, so the floor is 0.
 *
 * NOTE: `readSite` may carry a trailing parenthetical note
 * (e.g. "ci-bot.ts (buildCiBotWiring …)"); we resolve the leading path token.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { KNOB_INVENTORY } from "@/config/knob-inventory"

const SRC = join(import.meta.dir, "..", "..", "src")

interface StaleHit {
  readonly envKey: string
  readonly readSite: string
  readonly reason: "missing-file" | "key-not-present"
}

/** Pure detector — also reused by the red-on-injection self-test below. */
const findStaleReadSites = (
  entries: ReadonlyArray<{ envKey: string; readSite?: string }>,
  srcRoot: string,
): StaleHit[] => {
  const hits: StaleHit[] = []
  for (const e of entries) {
    if (e.readSite === undefined) continue
    const relPath = e.readSite.split(/[\s(]/)[0] // strip trailing "(note)"
    if (relPath === undefined || relPath.length === 0) continue
    const abs = join(srcRoot, relPath)
    if (!existsSync(abs)) {
      hits.push({ envKey: e.envKey, readSite: e.readSite, reason: "missing-file" })
      continue
    }
    if (!readFileSync(abs, "utf8").includes(e.envKey)) {
      hits.push({ envKey: e.envKey, readSite: e.readSite, reason: "key-not-present" })
    }
  }
  return hits
}

describe("knob-inventory readSite truthfulness", () => {
  test("every readSite file exists and contains its envKey (0 stale)", () => {
    const stale = findStaleReadSites(KNOB_INVENTORY, SRC)
    if (stale.length > 0) {
      const lines = stale.map((s) => `  ${s.envKey} → ${s.readSite} [${s.reason}]`).join("\n")
      throw new Error(
        `${stale.length} stale readSite(s) in knob-inventory.ts — point readSite at a file ` +
          `that ACTUALLY reads the key (or fix the typo):\n${lines}`,
      )
    }
    expect(stale.length).toBe(0)
  })

  test("DETECTOR has teeth (red-on-injection): a bogus readSite is flagged", () => {
    // missing file
    expect(
      findStaleReadSites([{ envKey: "QUANTA_X", readSite: "does/not/exist.ts" }], SRC),
    ).toHaveLength(1)
    // file exists but does NOT contain the key (knob-inventory.ts itself never
    // reads a fictional key)
    const bogus = findStaleReadSites(
      [{ envKey: "QUANTA_TOTALLY_FAKE_KEY_ZZZ", readSite: "config/knob-inventory.ts" }],
      SRC,
    )
    expect(bogus).toHaveLength(1)
    expect(bogus[0]?.reason).toBe("key-not-present")
  })

  test("DETECTOR accepts a real entry (control)", () => {
    // QUANTA_GITHUB_WEBHOOK is read in apps/cli/webhook-server-setup.ts
    expect(
      findStaleReadSites(
        [{ envKey: "QUANTA_GITHUB_WEBHOOK", readSite: "apps/cli/webhook-server-setup.ts" }],
        SRC,
      ),
    ).toHaveLength(0)
  })
})
