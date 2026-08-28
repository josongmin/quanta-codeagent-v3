/**
 * RFC-06 F4 — discovery-owner ratchet.
 *
 * The web surface must NOT run its own skill discovery: it reads the ONE shared
 * `SkillRuntimeAuthority` (whose registry is the single discovery owner). Before
 * F4, `runtime-factory.ts` ran an independent `discoverSkills`/`discoverSystemSkills`
 * merge for its `/skills` readout — a second discovery path that diverged from
 * the live runtime view. This ratchet pins that removal: NO file under
 * `src/apps/web-daemon/**` may reference the discovery primitives (import OR call).
 *
 * The config-migration discovery is DISTINCT and PRESERVED: it is NOT a live
 * active-skill surface (it reads bundled system-skill NAMES once, at startup, to
 * decide whether to offer a `~/.claude` → `~/.quanta` import). This test asserts
 * it still exists so a future sweep cannot silently delete it under the banner of
 * "kill web discovery".
 *
 * Comment-agnostic: the source is comment-stripped before matching, so a docblock
 * that merely NAMES the primitive does not trip (and cannot be used to hide a
 * real call).
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { assertScanPopulation } from "../../_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const WEB_DAEMON_DIR = join(REPO_ROOT, "src", "apps", "web-daemon")

/** Recursively list every `.ts` file under a dir. */
const listTsFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTsFiles(abs))
    else if (entry.name.endsWith(".ts")) out.push(abs)
  }
  return out
}

/** Strip `//` line comments and `/* *\/` block comments so a docblock naming the
 *  primitive is not a false positive (and cannot hide a real reference). */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")

const DISCOVERY_RE = /\bdiscover(?:System)?Skills\b/

describe("RFC-06 F4 — discovery-owner ratchet", () => {
  test("ANTI-VACUITY: the web-daemon walk reaches a real, populated tree", () => {
    // `expect(offenders).toEqual([])` is satisfied by a walk that read nothing.
    assertScanPopulation(listTsFiles(WEB_DAEMON_DIR), WEB_DAEMON_DIR, {
      min: 10,
      collectable: (n) => n.endsWith(".ts"),
    })
  })

  test("no file under src/apps/web-daemon/ references discoverSkills / discoverSystemSkills", () => {
    const offenders = listTsFiles(WEB_DAEMON_DIR)
      .filter((f) => DISCOVERY_RE.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => f.slice(REPO_ROOT.length + 1))
    expect(offenders).toEqual([])
  })

  test("config-migration discovery is PRESERVED (distinct from the live active-skill surface)", () => {
    const migrationNotice = join(REPO_ROOT, "src", "apps", "cli", "config-migration-notice.ts")
    // Sanity: the file exists.
    expect(statSync(migrationNotice).isFile()).toBe(true)
    // It STILL performs the startup config-migration system-skill-name read — this
    // is a NON-live surface (import decision), deliberately untouched by F4.
    expect(DISCOVERY_RE.test(stripComments(readFileSync(migrationNotice, "utf8")))).toBe(true)
  })
})
