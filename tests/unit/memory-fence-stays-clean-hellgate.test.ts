/**
 * ★ HELLGATE — Slice S6-Memory layering invariant.
 *
 * The S6 telemetry port is precisely the inverted-dependency seam that lets
 * `@/memory` emit telemetry WITHOUT importing `@/observability`. If anyone
 * adds `import … from "@/observability"` to a memory-slice file (including
 * adapters or telemetry helpers under `src/memory/`), this static scan trips
 * and the slice fence is broken.
 *
 * Companion to:
 *   - memory-fence-no-llm-import-hellgate.test.ts (sister fence: no @/llm)
 *   - src/memory/consolidate/constants.ts:53-64 (the prose for this fence)
 */

import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

const MEMORY_ROOT = join(process.cwd(), "src", "memory")

async function* walkTs(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      yield* walkTs(p)
    } else if (e.isFile() && p.endsWith(".ts")) {
      yield p
    }
  }
}

describe("memory-fence-stays-clean-hellgate — static scan", () => {
  test("no .ts file under src/memory/ imports from @/observability", async () => {
    const offenders: { path: string; line: number; text: string }[] = []
    for await (const file of walkTs(MEMORY_ROOT)) {
      const content = await readFile(file, "utf8")
      const lines = content.split("\n")
      lines.forEach((line, i) => {
        if (/\bfrom\s+["']@\/observability(\/[^"']*)?["']/.test(line)) {
          offenders.push({ path: file, line: i + 1, text: line.trim() })
        }
      })
    }
    expect(offenders).toEqual([])
  })

  test("no .ts file under src/memory/ imports from @observability bare alias", async () => {
    const offenders: string[] = []
    for await (const file of walkTs(MEMORY_ROOT)) {
      const content = await readFile(file, "utf8")
      if (/\bfrom\s+["']@observability["']/.test(content)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test("no .ts file under src/memory/ imports from @/llm (sister fence regression guard)", async () => {
    const offenders: string[] = []
    for await (const file of walkTs(MEMORY_ROOT)) {
      const content = await readFile(file, "utf8")
      if (/\bfrom\s+["']@\/llm(\/[^"']*)?["']/.test(content)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test("telemetry-port.ts exports the port and the no-op", async () => {
    const file = join(MEMORY_ROOT, "telemetry-port.ts")
    const content = await readFile(file, "utf8")
    expect(content).toContain("export interface MemoryTelemetryPort")
    expect(content).toContain("export const noopMemoryTelemetry")
    // Anti-leak invariant is encoded structurally as allow-list constants.
    expect(content).toContain("PHASE1_EVENT_ALLOWED_KEYS")
    expect(content).toContain("PHASE2_EVENT_ALLOWED_KEYS")
    expect(content).toContain("RECALL_EVENT_ALLOWED_KEYS")
    expect(content).toContain("FORBIDDEN_TELEMETRY_KEYS")
  })

  test("telemetry-port.ts itself has no @/observability import (the seam IS the slice)", async () => {
    const file = join(MEMORY_ROOT, "telemetry-port.ts")
    const content = await readFile(file, "utf8")
    expect(content).not.toMatch(/from\s+["']@\/observability/)
  })
})
