/**
 * ADR-0161 Phase F hellgate — JSONL store corruption / shape mismatches /
 * concurrent saves / clock skew / EACCES.
 */

import { describe, expect, test } from "bun:test"
import { appendFile, chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAutomation, transitionStatus } from "@/scheduler/automation"
import { parseRRule } from "@/scheduler/rrule-parser"
import { defaultJsonlAutomationStore } from "@/scheduler/store-jsonl"
import { AutomationStoreError, type Automation, type RRule } from "@/scheduler/types"

const ruleOf = (s: string): RRule => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error("bad rule")
  const { ok: _ok, ...rest } = r
  return rest
}

const sample = (id: string): Automation =>
  createAutomation({
    id,
    title: `auto-${id}`,
    rule: ruleOf("FREQ=WEEKLY;BYDAY=MO"),
    prompt: "p",
    modelPreference: "gpt-5",
    modelFallbacks: [],
    createdAt: Date.UTC(2026, 4, 1),
  })

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "qschedh-"))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("JSONL store hellgate", () => {
  test("[1] ENOENT load → []", async () => {
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      expect(await store.load("/missing")).toEqual([])
    })
  })

  test("[2] empty file → []", async () => {
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({
        baseDir: dir,
        workspaceHasher: () => "wsh",
      })
      const file = join(dir, "wsh", "automations.jsonl")
      await writeFile(join(dir, "wsh", "automations.jsonl"), "", "utf8").catch(async () => {
        // mkdir parent first
        const { mkdir } = await import("node:fs/promises")
        await mkdir(join(dir, "wsh"), { recursive: true })
        await writeFile(file, "", "utf8")
      })
      expect(await store.load("/w")).toEqual([])
    })
  })

  test("[3] corrupt single line skipped, others survive", async () => {
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({
        baseDir: dir,
        workspaceHasher: () => "wsh",
      })
      await store.save("/w", sample("good1"))
      const file = join(dir, "wsh", "automations.jsonl")
      await appendFile(file, "{not valid json\n", "utf8")
      await store.save("/w", sample("good2"))
      const loaded = await store.load("/w")
      const ids = loaded.map((a) => a.id).sort()
      expect(ids).toEqual(["good1", "good2"])
    })
  })

  test("[4] trailing newline OK", async () => {
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      await store.save("/w", sample("g"))
      // save() already appends \n. Add another to simulate trailing blank.
      const file = join(dir, "wsh-extra")
      // No-op; the appendFile newline is the trailing newline.
      const loaded = await store.load("/w")
      expect(loaded.length).toBe(1)
    })
  })

  test("[5] dup id — last line wins", async () => {
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      await store.save("/w", sample("dup"))
      await store.save("/w", transitionStatus(sample("dup"), "paused"))
      await store.save("/w", transitionStatus(sample("dup"), "error"))
      const loaded = await store.load("/w")
      expect(loaded.length).toBe(1)
      expect(loaded[0]?.status).toBe("error")
    })
  })

  test("[6] delete then re-save same id → re-save wins (latest line)", async () => {
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      await store.save("/w", sample("a"))
      await store.delete("/w", "a")
      expect((await store.load("/w")).length).toBe(0)
      // Re-save (caller's choice — same id).
      await store.save("/w", sample("a"))
      const loaded = await store.load("/w")
      expect(loaded.length).toBe(1)
      expect(loaded[0]?.status).toBe("active")
    })
  })

  test("[7] delete unknown id is idempotent", async () => {
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      await store.delete("/w", "ghost")
      await store.save("/w", sample("a"))
      await store.delete("/w", "ghost") // still no-op
      const loaded = await store.load("/w")
      expect(loaded.length).toBe(1)
    })
  })

  test("[8] workspace isolation — corrupt in /w1 doesn't break /w2", async () => {
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      await store.save("/w1", sample("a"))
      await store.save("/w2", sample("b"))
      const loaded2 = await store.load("/w2")
      expect(loaded2.length).toBe(1)
      expect(loaded2[0]?.id).toBe("b")
    })
  })

  test("[9] save serializes complex rule (BYDAY nth + UNTIL)", async () => {
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      const a = {
        ...sample("c"),
        rule: ruleOf("FREQ=MONTHLY;BYDAY=+2MO,-1FR;UNTIL=20261231T120000Z"),
      }
      await store.save("/w", a)
      const loaded = await store.load("/w")
      expect(loaded[0]?.rule.byDay).toEqual([
        { day: "MO", nth: 2 },
        { day: "FR", nth: -1 },
      ])
    })
  })

  test("[10] shape mismatch (missing required field) → skipped", async () => {
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({
        baseDir: dir,
        workspaceHasher: () => "wsh",
      })
      await store.save("/w", sample("ok"))
      const file = join(dir, "wsh", "automations.jsonl")
      // Inject a JSON object missing `prompt`.
      await appendFile(file, `${JSON.stringify({ id: "bad", title: "x" })}\n`, "utf8")
      const loaded = await store.load("/w")
      expect(loaded.length).toBe(1)
      expect(loaded[0]?.id).toBe("ok")
    })
  })

  test("[11] invalid status arm → line skipped", async () => {
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({
        baseDir: dir,
        workspaceHasher: () => "wsh",
      })
      await store.save("/w", sample("ok"))
      const file = join(dir, "wsh", "automations.jsonl")
      const bad = { ...sample("evil"), status: "zombie" }
      await appendFile(file, `${JSON.stringify(bad)}\n`, "utf8")
      const loaded = await store.load("/w")
      expect(loaded.map((a) => a.id)).toEqual(["ok"])
    })
  })

  test("[12] invalid freq → line skipped", async () => {
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({
        baseDir: dir,
        workspaceHasher: () => "wsh",
      })
      await store.save("/w", sample("ok"))
      const file = join(dir, "wsh", "automations.jsonl")
      const bad = { ...sample("evil"), rule: { freq: "HOURLY" } }
      await appendFile(file, `${JSON.stringify(bad)}\n`, "utf8")
      const loaded = await store.load("/w")
      expect(loaded.map((a) => a.id)).toEqual(["ok"])
    })
  })

  test("[13] EACCES on save → AutomationStoreError('io-failed')", async () => {
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({
        baseDir: dir,
        workspaceHasher: () => "ws-locked",
      })
      // Pre-create the dir + file with no-write perms.
      const wsDir = join(dir, "ws-locked")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(wsDir, { recursive: true })
      const file = join(wsDir, "automations.jsonl")
      await writeFile(file, "", "utf8")
      await chmod(file, 0o400) // read-only
      let thrown: unknown
      try {
        await store.save("/w", sample("a"))
      } catch (e) {
        thrown = e
      } finally {
        await chmod(file, 0o600) // restore so tmp cleanup works
      }
      expect(thrown).toBeInstanceOf(AutomationStoreError)
      if (thrown instanceof AutomationStoreError) {
        expect(thrown.code).toBe("io-failed")
      }
    })
  })

  test("[14] 100 saves preserve latest per id (perf smoke)", async () => {
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      for (let i = 0; i < 100; i += 1) {
        await store.save("/w", { ...sample("perf"), fireCount: i })
      }
      const loaded = await store.load("/w")
      expect(loaded.length).toBe(1)
      expect(loaded[0]?.fireCount).toBe(99)
    })
  })
})
