/**
 * ★ HELLGATE — the web FRONTEND's readout slug list cannot drift from the
 * DAEMON's (aug-27).
 *
 * `src/apps/web-daemon/readout.ts` owns three lists that together define every
 * readout the daemon answers: `SOURCE_BACKED_READOUTS` (served live from an
 * injected accessor), the snapshot-served pair (`/state`, `/capabilities`), and
 * `SKIPPED_READOUT_COPY` (recognized, deliberately not served here, with honest
 * copy). The browser client keeps its OWN hand-written copy of that vocabulary in
 * `apps/web-frontend/src/components/slash-readout.ts` (`READOUT_COMMANDS`), which
 * is what the slash palette offers.
 *
 * Two hand-maintained copies of one vocabulary is the classic parallel-list
 * defect: this very campaign added a `model` readout to the daemon and left the
 * frontend list untouched, so a real, wired, working readout was UNREACHABLE from
 * the only UI that consumes it — invisible to every server-side test, because the
 * daemon side was complete.
 *
 * This guard closes that: the frontend PALETTE must cover EXACTLY the daemon's
 * vocabulary. "Palette", not "`READOUT_COMMANDS`" — a readout may legitimately be
 * owned by a richer command (`/model` is owned by the llm-config builder, which
 * lists via the readout AND can switch via a control frame), and the palette
 * de-dups slugs, so requiring the readout builder to own every name would force a
 * duplicate. Extra palette slugs the daemon does not recognize are just as bad
 * (the palette would offer an entry the route answers `unknown readout`), so both
 * directions are asserted.
 *
 * WHY parse the sources instead of importing: the frontend is a separate Vite app
 * (its own tsconfig + vitest runner) and the biome slice fence forbids
 * `@/apps/web-daemon` from importing it — so the only place the two can be
 * compared is a repo-level test that reads both files. The parse is anchored on
 * the exported list literals; if either is renamed or restructured the parse
 * yields an empty set and the test FAILS LOUD rather than passing vacuously
 * (asserted below).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  SKIPPED_READOUTS,
  SNAPSHOT_SERVED_READOUTS,
  SOURCE_BACKED_READOUTS,
} from "@/apps/web-daemon/readout"

const ROOT = resolve(import.meta.dir, "../../../..")
const READOUT_FILE = "apps/web-frontend/src/components/slash-readout.ts"
/** The llm-config builder owns richer entries whose slug may ALSO be a readout
 *  name (`/model` lists via the readout and switches via a control frame). */
const LLM_CONFIG_FILE = "apps/web-frontend/src/components/slash-llm-config.ts"

const slugsIn = (file: string, listName?: string): readonly string[] => {
  const source = readFileSync(join(ROOT, file), "utf8")
  const scope =
    listName === undefined
      ? source
      : (new RegExp(`${listName}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\]`).exec(source)?.[1] ?? "")
  return [...scope.matchAll(/slug:\s*"([a-z-]+)"/g)].map((m) => m[1] as string)
}

/** Every slug the browser palette offers for a DAEMON readout, from both builders. */
const frontendSlugs = (): readonly string[] => [
  ...slugsIn(READOUT_FILE, "READOUT_COMMANDS"),
  ...slugsIn(LLM_CONFIG_FILE),
]

describe("web readout vocabulary — daemon and frontend cannot drift", () => {
  test("the parse is non-degenerate (a rename/restructure fails loud, never vacuously)", () => {
    const slugs = frontendSlugs()
    // A structural change to the frontend list would yield [] here; the parity
    // assertions below would then trivially "pass" only if the daemon list were
    // ALSO empty — which this pins as impossible.
    expect(slugs.length).toBeGreaterThan(5)
    expect(SOURCE_BACKED_READOUTS.length).toBeGreaterThan(5)
    expect(slugs).toContain("state") // a snapshot-served one (readout builder)
    expect(slugs).toContain("agents") // a source-backed one (readout builder)
    expect(slugs).toContain("model") // owned by the llm-config builder
  })

  test("every readout the DAEMON answers is offered by the frontend palette", () => {
    const offered = new Set(frontendSlugs())
    const daemon = [
      ...SOURCE_BACKED_READOUTS,
      ...SNAPSHOT_SERVED_READOUTS,
      ...SKIPPED_READOUTS,
    ].sort()
    const missing = daemon.filter((name) => !offered.has(name))
    expect(missing).toEqual([])
  })

  test("no READOUT-kind palette entry names a readout the daemon does not recognize", () => {
    // Only the readout-builder list is checked in this direction: the llm-config
    // builder legitimately owns non-readout slugs (`/effort`, `/fast`,
    // `/retry-with`, `/login`…), which the daemon answers on other routes.
    const daemon = new Set<string>([
      ...SOURCE_BACKED_READOUTS,
      ...SNAPSHOT_SERVED_READOUTS,
      ...SKIPPED_READOUTS,
    ])
    const extra = slugsIn(READOUT_FILE, "READOUT_COMMANDS").filter((slug) => !daemon.has(slug))
    expect(extra).toEqual([])
  })
})
