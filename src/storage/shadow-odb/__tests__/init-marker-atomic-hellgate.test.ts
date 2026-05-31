/**
 * T11 — Shadow ODB init-marker ATOMIC-WRITE hellgate.
 *
 * Audit L9 H9: "Shadow ODB storage correctness."
 *
 * The init flow drops a `.quanta-shadow-init` marker AFTER `git init` +
 * `applyShadowConfig`. A subsequent `init` short-circuits on the marker's
 * PRESENCE. If the marker were written non-atomically, a crash mid-write
 * could leave a 0-byte / partial marker whose mere presence makes the next
 * `init` skip configuration — a half-initialized store that looks "ready".
 *
 * Owning-seam invariant (T11): the marker is persisted through the slice's
 * ONE atomic write helper, so it is either ABSENT or COMPLETE (a valid ISO
 * timestamp line) — never a partial that masquerades as a finished init.
 *
 * 3 cases (real git, tmp dirs):
 *   1. init writes a COMPLETE marker (parses as an ISO-8601 timestamp line)
 *   2. init is idempotent — second init does not rewrite the marker
 *   3. registerHead after a fresh init produces a real 40-hex SHA
 *      (proves config was applied — no half-init)
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultShadowOdb } from "@/storage/shadow-odb/default"

const tmps: string[] = []
const mk = (label: string): string => {
  const d = mkdtempSync(join(tmpdir(), `t11-marker-${label}-`))
  tmps.push(d)
  return d
}

const MARKER = ".quanta-shadow-init"

describe("shadow-init-marker-atomic-hellgate", () => {
  test("HELL-1: init writes a COMPLETE marker (valid ISO timestamp line)", async () => {
    const base = mk("base")
    const ws = mk("ws")
    const odb = defaultShadowOdb({ baseDir: base })
    const { shadowDir } = await odb.init(ws)
    const marker = readFileSync(join(shadowDir, MARKER), "utf-8")
    expect(marker.endsWith("\n")).toBe(true)
    const line = marker.trim()
    // Must be a complete, parseable ISO-8601 timestamp — not a partial.
    expect(Number.isNaN(Date.parse(line))).toBe(false)
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test("HELL-2: init is idempotent — second init keeps the same marker", async () => {
    const base = mk("base2")
    const ws = mk("ws2")
    const odb = defaultShadowOdb({ baseDir: base })
    const { shadowDir } = await odb.init(ws)
    const first = readFileSync(join(shadowDir, MARKER), "utf-8")
    await odb.init(ws)
    const second = readFileSync(join(shadowDir, MARKER), "utf-8")
    expect(second).toBe(first)
  })

  test("HELL-3: registerHead after init yields a real 40-hex SHA (config applied)", async () => {
    const base = mk("base3")
    const ws = mk("ws3")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.init(ws)
    const sha = await odb.registerHead(ws)
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })
})

// Best-effort cleanup of tmp dirs.
process.on("exit", () => {
  for (const d of tmps) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})
