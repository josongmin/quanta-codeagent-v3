/**
 * Architecture ratchet (P0-A) — no hand-rolled `CapabilityManifest` literals in
 * tests; go through the SSOT fixture (`tests/support/session-fixtures.ts`).
 *
 * WHY
 * ---
 * `CapabilityManifest` (src/protocol/session/capabilities.ts) is a NINE-field
 * struct. Before P0-A, ~35 test files hand-rolled the full nine-field literal
 * inline, so adding ONE capability field meant editing every one of them in
 * lock-step (a real 46-file sync tax during W1-B). Production already had the
 * single source of truth — `normalizeCapabilityManifest` — and P0-A routed the
 * tests through it via `capabilitiesFor(overrides?)` / `makeSnapshotLite`.
 *
 * This ratchet keeps that consolidation from rotting: a NEW test that inlines a
 * full manifest literal (approvals + shellSnapshot + serverAutoContinues keys
 * in one object) fails here, pointing the author at `capabilitiesFor`.
 *
 * DETECTOR
 * --------
 * A hand-rolled manifest is identified by the co-occurrence of THREE object-
 * literal KEYS inside one `{ … }` block: `approvals:`, `shellSnapshot:`, and
 * `serverAutoContinues:`. The latter two are UNIQUE to the manifest, so this
 * never collides with unrelated objects (e.g. the `shellSnapshot: { port }`
 * runShell config option has neither `approvals:` nor `serverAutoContinues:`).
 * We match KEYS (`name:`), never property ACCESS (`.serverAutoContinues`), so a
 * test that merely READS `snapshot.capabilities.serverAutoContinues` is fine.
 *
 * EXEMPTIONS (closed list, each load-bearing)
 * -------------------------------------------
 *  · tests/support/session-fixtures.ts — the SSOT fixture itself (it does not
 *    inline a literal; listed for belt-and-suspenders if it ever grows one).
 *  · tests/unit/host/host-capability-derivation.test.ts — the WITNESS that the
 *    PRODUCTION `deriveCapabilityManifest` / host `describe()` emits the exact
 *    nine fields. Its literals are the *expected-output* of the derivation
 *    under test; routing them through `capabilitiesFor` would make the
 *    assertion circular (fixture == fixture) and delete the ground truth.
 *  · this ratchet file — its self-test embeds sample literals as string data.
 *
 * Scans the TRACKED set (`git ls-files`), so a dev's local scratch file is
 * never flagged. Read-only; deterministic across platforms.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { assertScanPopulation } from "../_shared/scan-population"

const REPO_ROOT = resolve(import.meta.dir, "../../..")

/** Files allowed to contain a full manifest literal — see EXEMPTIONS above. */
const EXEMPT_PATHS: ReadonlySet<string> = new Set([
  "tests/support/session-fixtures.ts",
  "tests/unit/host/host-capability-derivation.test.ts",
  "tests/unit/_arch/capability-literal-ratchet.test.ts",
])

/**
 * True iff `source` contains a hand-rolled `CapabilityManifest` object literal —
 * an object whose keys include `approvals:`, `shellSnapshot:` AND
 * `serverAutoContinues:`. Matched per `{ … }` block (no nested-brace crossing
 * needed: manifests are flat), on object-literal KEYS only (`key:`), so
 * property ACCESS (`.serverAutoContinues`) never trips it.
 */
export function hasManifestLiteral(source: string): boolean {
  // Split on braces to get candidate object bodies. A flat manifest literal's
  // three signature keys all live in the same `{ … }` segment.
  for (const block of splitBraceBlocks(source)) {
    if (
      hasObjectKey(block, "approvals") &&
      hasObjectKey(block, "shellSnapshot") &&
      hasObjectKey(block, "serverAutoContinues")
    ) {
      return true
    }
  }
  return false
}

/** Object-literal key `name:` — NOT preceded by `.` (that would be access) and
 *  NOT part of a longer identifier. */
function hasObjectKey(block: string, name: string): boolean {
  return new RegExp(String.raw`(^|[^.\w])${name}\s*:`).test(block)
}

/** The text between each pair of `{` and the next `}` (non-nesting). Manifest
 *  literals are flat, so a naive segmentation suffices and cannot merge two
 *  separate objects' keys across a `}` boundary. */
function splitBraceBlocks(source: string): string[] {
  const blocks: string[] = []
  let depth = 0
  let current = ""
  for (const ch of source) {
    if (ch === "{") {
      depth += 1
      current = ""
    } else if (ch === "}") {
      if (depth > 0) blocks.push(current)
      current = ""
      depth = Math.max(0, depth - 1)
    } else if (depth > 0) {
      current += ch
    }
  }
  return blocks
}

function listTrackedTestFiles(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "--", "tests/"], { cwd: REPO_ROOT })
  if (out.exitCode !== 0) {
    throw new Error(
      `git ls-files failed (exit ${out.exitCode}): ${new TextDecoder().decode(out.stderr)}`,
    )
  }
  const files = new TextDecoder()
    .decode(out.stdout)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".ts"))
  assertScanPopulation(
    files.map((file) => resolve(REPO_ROOT, file)),
    resolve(REPO_ROOT, "tests"),
    {
      collectable: (name) => name.endsWith(".ts"),
      id: "tests/unit/_arch/capability-literal-ratchet.test.ts#TESTS",
    },
  )
  // Anti-vacuity: `git ls-files` exits 0 with no output on no match, so the exit
  // check is not a floor. The five matcher controls below prove the DETECTOR
  // works while the corpus is empty — which is exactly how this file passed 6/0
  // against an empty mirror of the repo tree.
  if (files.length < 3244) {
    throw new Error(
      `git ls-files returned ${files.length} tracked test file(s) — far below the real tree; ` +
        `the literal ban would pass over nothing.`,
    )
  }
  return files
}

describe("arch: capability-manifest literals go through the SSOT fixture", () => {
  // BUDGET, not decoration. Measured on a full `bun test tests/unit tests/meta
  // tests/adversarial` run (39,118 arms, 3,034 files): this arm took 15,645ms
  // against bun's 5,000ms default and FAILED — reporting a guard violation
  // when the truth was that a repo-wide scan did not finish in time. Exactly
  // four arms in the whole suite exceed 2,500ms, and all four are repo-wide
  // source scans; unloaded this one passes in well under a second. A false
  // accusation is worse than a slow test: it trains the reader to discount the
  // gate, and it cost a real misattribution on 2026-08-28 before the four were
  // re-run serially and all passed. A genuine hang is still bounded by the
  // outer `timeout` on the suite command.
  test("no test file inlines a full CapabilityManifest literal (use capabilitiesFor)", () => {
    const offenders = listTrackedTestFiles()
      .filter((p) => !EXEMPT_PATHS.has(p))
      .filter((p) => hasManifestLiteral(readFileSync(resolve(REPO_ROOT, p), "utf8")))

    expect(
      offenders,
      offenders.length > 0
        ? "Hand-rolled CapabilityManifest literal(s) found — replace with " +
            "`capabilitiesFor({ ...overrides })` from tests/support/session-fixtures.ts " +
            `(exempt: host-capability-derivation witness):\n  ${offenders.join("\n  ")}`
        : "",
    ).toEqual([])
  }, 60_000)

  // ── red-on-injection: the detector must FIRE on a raw literal and stay
  // SILENT on a `capabilitiesFor(...)` call and on mere property access. ──
  test("detector FIRES on a hand-rolled 9-field manifest literal", () => {
    const injected = `
      const m = {
        approvals: "operator",
        tools: true,
        memory: false,
        artifacts: true,
        subagents: false,
        automation: false,
        shellSnapshot: false,
        serverAutoContinues: false,
        transport: "inproc",
      }
    `
    expect(hasManifestLiteral(injected)).toBe(true)
  })

  test("detector is SILENT on the SSOT fixture call form", () => {
    expect(
      hasManifestLiteral(`const m = capabilitiesFor({ approvals: "operator", tools: true })`),
    ).toBe(false)
    expect(
      hasManifestLiteral(`const s = makeSnapshotLite({ capabilities: { tools: true } })`),
    ).toBe(false)
  })

  test("detector is SILENT on property ACCESS of manifest fields (not a literal)", () => {
    expect(
      hasManifestLiteral(`
        expect(snap.capabilities.serverAutoContinues).toBe(true)
        expect(snap.capabilities.approvals).toBe("operator")
        if (snap.capabilities.shellSnapshot) doThing()
      `),
    ).toBe(false)
  })

  test("detector is SILENT on the unrelated shellSnapshot runShell config option", () => {
    // The bash-tool `shellSnapshot: { port }` option shares only ONE key name
    // with the manifest; without approvals+serverAutoContinues it must not trip.
    expect(hasManifestLiteral(`baseConfig({ shellSnapshot: { port, shell: "zsh" } })`)).toBe(false)
  })

  test("detector does not merge two separate objects across a brace boundary", () => {
    // `approvals:` in object A and `serverAutoContinues:`/`shellSnapshot:` in a
    // DISTINCT object B must not be conflated into a false positive.
    expect(
      hasManifestLiteral(`
        const a = { approvals: "none" }
        const b = { shellSnapshot: false, serverAutoContinues: false }
      `),
    ).toBe(false)
  })
})
