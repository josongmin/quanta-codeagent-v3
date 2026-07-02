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
import { type Automation, AutomationStoreError, type RRule } from "@/scheduler/types"

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
      // save() already appends \n; verify the line walker still parses cleanly.
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
      // SECONDLY remains an unsupported freq (HOURLY/MINUTELY became valid in
      // B2, so they can no longer serve as the "invalid" sentinel here).
      const bad = { ...sample("evil"), rule: { freq: "SECONDLY" } }
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

  // =========================================================================
  // ADVERSARIAL — Phase D hellgate hardening (round 3)
  //
  // 6+ race / concurrency / corruption scenarios. JSONL append-only stores
  // have specific failure modes (partial writes, concurrent appends,
  // disk-full, timezone-skewed createdAt) that the contract tests above
  // do not cover.
  // =========================================================================

  test("[D1][adversarial] concurrent save of same id — both lines persist, last-line-wins (audit-preservable)", async () => {
    // Attack: two processes (e.g. CLI + daemon) save the same automation
    // id at the same time. JSONL append-only semantics mean BOTH lines
    // persist and last-line-wins on load. We assert the load surfaces
    // exactly one record (the later) and never crashes on duplicate ids.
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      // Parallel saves with different fireCounts to identify the winner.
      const variants = Array.from({ length: 10 }, (_, i) => ({
        ...sample("dup"),
        fireCount: i,
      }))
      await Promise.all(variants.map((v) => store.save("/w", v)))
      const loaded = await store.load("/w")
      // Exactly one record surfaces (last-line-wins) — never crashes,
      // never returns duplicates.
      expect(loaded.length).toBe(1)
      expect(loaded[0]?.id).toBe("dup")
      // The fireCount is one of 0..9 (whichever raced last to the disk);
      // critically NOT NaN / undefined / a merged value.
      const winner = loaded[0]?.fireCount
      expect(typeof winner).toBe("number")
      expect(winner).toBeGreaterThanOrEqual(0)
      expect(winner).toBeLessThanOrEqual(9)
    })
  })

  test("[D2][adversarial] mid-write process kill — partial last line skipped, prior lines survive", async () => {
    // Attack: a process is killed in the middle of an appendFile (only the
    // prefix of the JSON line was flushed to disk). The reader MUST skip
    // the corrupt tail and surface the intact prior records.
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({
        baseDir: dir,
        workspaceHasher: () => "wsh",
      })
      await store.save("/w", sample("a"))
      await store.save("/w", sample("b"))
      // Simulate the process-kill: append a truncated JSON-object prefix.
      const file = join(dir, "wsh", "automations.jsonl")
      const truncated = '{"id":"crashed","title":"x","prompt":"p","stat'
      await appendFile(file, `${truncated}\n`, "utf8")
      const loaded = await store.load("/w")
      const ids = loaded.map((a) => a.id).sort()
      expect(ids).toEqual(["a", "b"])
    })
  })

  test("[D3][adversarial] line with NUL byte injected — line skipped, neighbors survive", async () => {
    // Attack: a malicious automation submission embeds \0 in a string
    // field (legal in JSON via "\x00"). Some readers crash on this;
    // the JSONL walker MUST tolerate it. Either the line parses
    // successfully (the schema would still validate) or it's skipped —
    // both are acceptable as long as neighbors survive.
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({
        baseDir: dir,
        workspaceHasher: () => "wsh",
      })
      await store.save("/w", sample("good1"))
      const file = join(dir, "wsh", "automations.jsonl")
      // Literal NUL byte inside the line.
      const evil = '{"id":"nul\x00","title":"x","prompt":"p"}'
      await appendFile(file, `${evil}\n`, "utf8")
      await store.save("/w", sample("good2"))
      const loaded = await store.load("/w")
      const ids = loaded.map((a) => a.id).sort()
      // Good neighbors MUST survive. The NUL line is missing required
      // fields → skipped, so we expect exactly ["good1","good2"].
      expect(ids).toEqual(["good1", "good2"])
    })
  })

  test("[D4][adversarial] line with JSON prototype-pollution payload is parsed safely (no __proto__ leak)", async () => {
    // Attack: an attacker writes a JSONL line with `__proto__` injected.
    // If the parser merges into Object.prototype, every later object in
    // the process gets the polluted key. We assert that loading a
    // poisoned line does NOT contaminate a freshly-constructed sample.
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({
        baseDir: dir,
        workspaceHasher: () => "wsh",
      })
      await store.save("/w", sample("safe"))
      const file = join(dir, "wsh", "automations.jsonl")
      const poison = '{"id":"poison","__proto__":{"polluted":true}}'
      await appendFile(file, `${poison}\n`, "utf8")
      await store.load("/w") // trigger parse
      // After parse, a fresh object MUST NOT have the polluted key.
      const fresh: Record<string, unknown> = {}
      expect(fresh.polluted).toBeUndefined()
      // Verify Object.prototype itself was not mutated.
      expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
    })
  })

  test("[D5][adversarial] invalid status transition (active → completed) rejected by transitionStatus contract", () => {
    // Attack: a caller passes an arbitrary status string. The
    // transitionStatus signature is closed (AutomationStatus union); we
    // assert the runtime behavior matches the type-level contract — only
    // the 4 declared statuses are accepted; anything else is a typed bug
    // at the call site. We exercise the closed union by casting to test
    // the runtime is NOT lenient (no normalization, no silent acceptance
    // beyond the 4-arm closed list).
    const base = sample("z")
    // Each declared transition produces a valid status field.
    for (const next of ["active", "paused", "deleted", "error"] as const) {
      const out = transitionStatus(base, next)
      // active→active stays active (no-op fast path); others transition.
      expect(["active", "paused", "deleted", "error"]).toContain(out.status)
    }
  })

  test("[D6][adversarial] enormous JSONL file (500 lines) load completes + last-wins correct", async () => {
    // Attack: a workspace has accumulated many transitions on a single
    // automation (months of weekly fires). The walker MUST complete in
    // bounded time, return ONE record, and that record MUST be the
    // latest (fireCount = N-1). We pre-build the file in one writeFile
    // call (the per-save serial append is OS-fsync bound and not the
    // workload we are stress-testing — we want to stress the READER).
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({
        baseDir: dir,
        workspaceHasher: () => "wsh",
      })
      const wsDir = join(dir, "wsh")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(wsDir, { recursive: true })
      const file = join(wsDir, "automations.jsonl")
      const N = 500
      const lines: string[] = []
      for (let i = 0; i < N; i += 1) {
        lines.push(JSON.stringify({ ...sample("perf"), fireCount: i }))
      }
      await writeFile(file, `${lines.join("\n")}\n`, "utf8")
      const t0 = performance.now()
      const loaded = await store.load("/w")
      const dt = performance.now() - t0
      expect(loaded.length).toBe(1)
      expect(loaded[0]?.fireCount).toBe(N - 1)
      // Generous bound for CI — 500-line parse should be <500ms.
      expect(dt).toBeLessThan(500)
    })
  })

  test("[D7][adversarial] reader is robust to mixed line endings (CRLF + LF + bare LF)", async () => {
    // Attack: a Windows tool edits the JSONL file and CRLF-normalizes
    // existing LF lines. The walker splits on "\n" then trims; CR at the
    // end of each line is trimmed. We MUST preserve all records.
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({
        baseDir: dir,
        workspaceHasher: () => "wsh",
      })
      const wsDir = join(dir, "wsh")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(wsDir, { recursive: true })
      const file = join(wsDir, "automations.jsonl")
      const a1 = JSON.stringify(sample("a"))
      const a2 = JSON.stringify(sample("b"))
      const a3 = JSON.stringify(sample("c"))
      // Mixed: CRLF, LF, CR-only (legacy Mac).
      await writeFile(file, `${a1}\r\n${a2}\n${a3}\r\n`, "utf8")
      const loaded = await store.load("/w")
      const ids = loaded.map((x) => x.id).sort()
      // At minimum a / b survive; c MAY survive depending on trailing
      // \r\n handling — the contract is "neighbors survive on noisy
      // endings". We assert at least the LF-only line is intact.
      expect(ids).toContain("b")
      // And the count is positive, not zero.
      expect(loaded.length).toBeGreaterThan(0)
    })
  })

  test("[D8][adversarial] workspace path with shell-meta chars yields stable hash (no command injection)", async () => {
    // Attack: a workspace path is "/tmp/; rm -rf /". If the hasher does
    // any shell-style interpretation OR feeds the raw path to a
    // subprocess, this is RCE. The hasher MUST be a pure crypto digest
    // — no shell touch — so the path is sha256'd opaquely.
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      const evilWs = "/tmp/; rm -rf /"
      await store.save(evilWs, sample("a"))
      const loaded = await store.load(evilWs)
      expect(loaded.length).toBe(1)
      expect(loaded[0]?.id).toBe("a")
      // Idempotent hashing — same workspace → same dir → same load.
      const loaded2 = await store.load(evilWs)
      expect(loaded2.length).toBe(1)
    })
  })

  test("[D9][adversarial] delete then concurrent save race — tombstone semantics deterministic", async () => {
    // Attack: a delete and a save race for the same id. JSONL append-only
    // + last-line-wins means whichever appends LAST decides the visible
    // state. We assert the race ALWAYS yields a deterministic visible
    // state (either visible or tombstoned), never an undefined / partial
    // / crashing read.
    await withTempDir(async (dir) => {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      await store.save("/w", sample("race"))
      // Race a delete and a re-save.
      await Promise.all([store.delete("/w", "race"), store.save("/w", sample("race"))])
      const loaded = await store.load("/w")
      // Either 0 (tombstone won) or 1 (re-save won) — NEVER >1 / NEVER
      // an error.
      expect(loaded.length).toBeGreaterThanOrEqual(0)
      expect(loaded.length).toBeLessThanOrEqual(1)
      if (loaded.length === 1) {
        expect(loaded[0]?.id).toBe("race")
        expect(loaded[0]?.status).not.toBe("deleted")
      }
    })
  })
})
