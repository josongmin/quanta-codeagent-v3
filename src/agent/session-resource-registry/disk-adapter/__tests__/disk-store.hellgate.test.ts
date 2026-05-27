/**
 * ADR-0348 — Disk-store hellgate.
 *
 * Coverage:
 *   A. empty storageDir + getOrCreate ⇒ fresh resources           (1)
 *   B. existing disk ⇒ second getOrCreate restores prior events   (1)
 *   C. same sessionId 2× same process ⇒ reference equality        (1)
 *   D. distinct sessionIds ⇒ distinct refs                        (1)
 *   E. evict drops in-memory + best-effort disk cleanup           (1)
 *   F. clear drops all in-memory + disk                           (1)
 *   G. peek is read-only (no creation)                            (1)
 *   H. cross-process resurrection (rebuild from disk-only)        (1)
 *   I. filesystem write failure ⇒ graceful in-memory degrade      (1)
 *   J. id with path-traversal chars ⇒ sanitized                   (1)
 *   K. concurrent getOrCreate same id ⇒ single ref                (1)
 *   L. corrupt jsonl ⇒ fallback (skip bad lines, keep good)       (1)
 *   M. cache replay on rebuild (text byte-identical)              (1)
 *   N. size() reflects in-memory tracked entries                  (1)
 *
 *  Total = 14 cases.
 */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asCacheKey } from "@/llm/system-prompt-cache"
import { createDiskSessionResourceRegistry } from "../disk-store"

const tempStorage = async (): Promise<string> => mkdtemp(join(tmpdir(), "adr0348-"))

// A bounded helper that polls for a fs-mirror operation to land (writes
// are scheduled via fire-and-forget microtask). We pin a generous
// budget so flaky filesystems don't break CI.
const waitForFile = async (path: string, predicate: (body: string) => boolean): Promise<string> => {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    try {
      const body = await readFile(path, "utf8")
      if (predicate(body)) return body
    } catch {
      // file not yet present
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  // One final read attempt for the assertion's error message.
  try {
    return await readFile(path, "utf8")
  } catch {
    return ""
  }
}

describe("ADR-0348 §A — empty storageDir + getOrCreate", () => {
  test("returns fresh resources + writes meta", async () => {
    const dir = await tempStorage()
    const reg = createDiskSessionResourceRegistry({ storageDir: dir })
    const r = reg.getOrCreate("sess-A")
    expect(r.store).toBeDefined()
    expect(r.cache).toBeDefined()
    expect(reg.size()).toBe(1)
    // meta.json eventually lands
    const meta = await waitForFile(join(dir, "sess-A", "meta.json"), (b) => b.length > 0)
    expect(meta).toContain("sess-A")
  })
})

describe("ADR-0348 §B — existing disk restored on rebuild", () => {
  test("second registry instance rebuilds events from disk", async () => {
    const dir = await tempStorage()
    const reg1 = createDiskSessionResourceRegistry({ storageDir: dir })
    const r1 = reg1.getOrCreate("sess-B")
    r1.store.append({
      kind: "context_update",
      field: "cwd",
      prev: "/a",
      next: "/b",
      at: 1,
      turnId: "t1",
    })
    // Wait for the mirror to land.
    await waitForFile(join(dir, "sess-B", "events.jsonl"), (b) => b.includes("context_update"))

    // Fresh registry, simulating a process restart.
    const reg2 = createDiskSessionResourceRegistry({ storageDir: dir })
    const r2 = reg2.getOrCreate("sess-B")
    // Replay is async — poll the snapshot until the event is visible.
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if (r2.store.snapshot().length > 0) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(r2.store.snapshot().length).toBe(1)
    expect(r2.store.snapshot()[0]?.kind).toBe("context_update")
  })
})

describe("ADR-0348 §C — same id reuse (core invariant)", () => {
  test("two getOrCreate calls on same id ⇒ same instance ref", async () => {
    const dir = await tempStorage()
    const reg = createDiskSessionResourceRegistry({ storageDir: dir })
    const a = reg.getOrCreate("sess-C")
    const b = reg.getOrCreate("sess-C")
    expect(a).toBe(b)
    expect(a.store).toBe(b.store)
    expect(a.cache).toBe(b.cache)
  })
})

describe("ADR-0348 §D — distinct ids", () => {
  test("two different ids ⇒ different refs", async () => {
    const dir = await tempStorage()
    const reg = createDiskSessionResourceRegistry({ storageDir: dir })
    const a = reg.getOrCreate("alpha")
    const b = reg.getOrCreate("beta")
    expect(a).not.toBe(b)
    expect(a.store).not.toBe(b.store)
    expect(a.cache).not.toBe(b.cache)
    expect(reg.size()).toBe(2)
  })
})

describe("ADR-0348 §E — evict cleans in-memory + disk", () => {
  test("evict drops entry + removes disk dir", async () => {
    const dir = await tempStorage()
    const reg = createDiskSessionResourceRegistry({ storageDir: dir })
    reg.getOrCreate("sess-E")
    await waitForFile(join(dir, "sess-E", "meta.json"), (b) => b.length > 0)
    reg.evict("sess-E")
    expect(reg.peek("sess-E")).toBeNull()
    expect(reg.size()).toBe(0)
    // disk cleanup is fire-and-forget; poll for absence
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      try {
        await readFile(join(dir, "sess-E", "meta.json"), "utf8")
        await new Promise((r) => setTimeout(r, 10))
      } catch {
        // gone
        break
      }
    }
    // Best-effort assertion: by now the dir should be gone OR meta.json
    // unreadable. Either is OK.
    let gone = false
    try {
      await readFile(join(dir, "sess-E", "meta.json"), "utf8")
    } catch {
      gone = true
    }
    expect(gone).toBe(true)
  })
})

describe("ADR-0348 §F — clear drops every entry", () => {
  test("clear empties the registry", async () => {
    const dir = await tempStorage()
    const reg = createDiskSessionResourceRegistry({ storageDir: dir })
    reg.getOrCreate("s1")
    reg.getOrCreate("s2")
    expect(reg.size()).toBe(2)
    reg.clear()
    expect(reg.size()).toBe(0)
    expect(reg.peek("s1")).toBeNull()
    expect(reg.peek("s2")).toBeNull()
  })
})

describe("ADR-0348 §G — peek is read-only", () => {
  test("peek miss ⇒ null; peek hit returns same ref; size unchanged", async () => {
    const dir = await tempStorage()
    const reg = createDiskSessionResourceRegistry({ storageDir: dir })
    expect(reg.peek("sess-G")).toBeNull()
    expect(reg.size()).toBe(0)
    const r = reg.getOrCreate("sess-G")
    expect(reg.peek("sess-G")).toBe(r)
    expect(reg.size()).toBe(1)
  })
})

describe("ADR-0348 §H — cross-process resurrection", () => {
  test("two registry instances at same storageDir see each other's writes", async () => {
    const dir = await tempStorage()
    const reg1 = createDiskSessionResourceRegistry({ storageDir: dir })
    const r1 = reg1.getOrCreate("sess-H")
    r1.store.append({
      kind: "mode_change",
      prev: "a",
      next: "b",
      at: 100,
    })
    await waitForFile(join(dir, "sess-H", "events.jsonl"), (b) => b.includes("mode_change"))

    // Reg2 = "second process": peek BEFORE getOrCreate should miss
    // (in-memory is fresh) but getOrCreate triggers rebuild.
    const reg2 = createDiskSessionResourceRegistry({ storageDir: dir })
    expect(reg2.peek("sess-H")).toBeNull()
    const r2 = reg2.getOrCreate("sess-H")
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if (r2.store.snapshot().length > 0) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(r2.store.snapshot().length).toBe(1)
  })
})

describe("ADR-0348 §I — filesystem write failure ⇒ graceful degrade", () => {
  test("non-existent root path still yields usable resources", () => {
    const reg = createDiskSessionResourceRegistry({
      storageDir: "/proc/0/no-such-place-for-quanta",
    })
    const r = reg.getOrCreate("sess-I")
    // Resources still usable for the lifetime of the process even when
    // the disk cannot be written.
    expect(r.store).toBeDefined()
    expect(r.cache).toBeDefined()
    expect(() =>
      r.store.append({ kind: "skill_activation", skillId: "git", trigger: "auto", at: 1 }),
    ).not.toThrow()
    expect(r.store.snapshot().length).toBe(1)
  })
})

describe("ADR-0348 §J — path-traversal id sanitization", () => {
  test("hostile id never escapes storageDir", async () => {
    const dir = await tempStorage()
    const reg = createDiskSessionResourceRegistry({ storageDir: dir })
    const hostileId = "../../etc/passwd"
    const r = reg.getOrCreate(hostileId)
    expect(r.store).toBeDefined()
    // The on-disk session dir must NOT be outside storageDir.
    // We check that *some* directory under `dir/` was created for this
    // session; sanitization replaces `/` with `_`.
    const deadline = Date.now() + 2000
    let foundSanitized = false
    while (Date.now() < deadline) {
      try {
        // Sanitized form replaces `/` and `.` with `_`.
        await readFile(join(dir, "______etc_passwd", "meta.json"), "utf8")
        foundSanitized = true
        break
      } catch {
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    expect(foundSanitized).toBe(true)
  })
})

describe("ADR-0348 §K — concurrent getOrCreate same id", () => {
  test("synchronous re-entrancy returns same ref", () => {
    const dir = join(tmpdir(), `adr0348-K-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const reg = createDiskSessionResourceRegistry({ storageDir: dir })
    // Two synchronous calls — no microtask in between.
    const a = reg.getOrCreate("sess-K")
    const b = reg.getOrCreate("sess-K")
    expect(a).toBe(b)
    expect(reg.size()).toBe(1)
  })
})

describe("ADR-0348 §L — corrupt jsonl ⇒ fallback skip bad lines", () => {
  test("partial corruption — keep good lines, drop bad", async () => {
    const dir = await tempStorage()
    const sessionDir = join(dir, "sess-L")
    await mkdir(sessionDir, { recursive: true })
    // Hand-craft an events.jsonl with 1 good + 1 bad + 1 good line.
    const lines = [
      JSON.stringify({ kind: "context_update", field: "cwd", prev: "/a", next: "/b", at: 1 }),
      "{garbage line that won't parse",
      JSON.stringify({ kind: "mode_change", prev: "x", next: "y", at: 2 }),
    ]
    await writeFile(join(sessionDir, "events.jsonl"), lines.join("\n"), "utf8")
    await writeFile(
      join(sessionDir, "meta.json"),
      JSON.stringify({ sessionId: "sess-L", lastTouched: Date.now() }),
      "utf8",
    )

    const reg = createDiskSessionResourceRegistry({ storageDir: dir })
    const r = reg.getOrCreate("sess-L")
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if (r.store.snapshot().length >= 2) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(r.store.snapshot().length).toBe(2)
    expect(r.store.snapshot()[0]?.kind).toBe("context_update")
    expect(r.store.snapshot()[1]?.kind).toBe("mode_change")
  })
})

describe("ADR-0348 §M — cache replay text byte-identical", () => {
  test("rebuilt cache returns same text on getOrBuild", async () => {
    const dir = await tempStorage()
    const reg1 = createDiskSessionResourceRegistry({ storageDir: dir })
    const r1 = reg1.getOrCreate("sess-M")
    const key = asCacheKey("sess-M")
    const text = "the system prompt body"
    r1.cache.getOrBuild(key, () => text)
    await waitForFile(join(dir, "sess-M", "prompt-cache.jsonl"), (b) => b.includes(text))

    const reg2 = createDiskSessionResourceRegistry({ storageDir: dir })
    const r2 = reg2.getOrCreate("sess-M")
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if (r2.cache.peek(key) !== null) break
      await new Promise((r) => setTimeout(r, 10))
    }
    const peeked = r2.cache.peek(key)
    expect(peeked).not.toBeNull()
    expect(peeked?.text).toBe(text)
  })
})

describe("ADR-0348 §N — size() reflects in-memory tracked entries", () => {
  test("size grows + drops as expected", async () => {
    const dir = await tempStorage()
    const reg = createDiskSessionResourceRegistry({ storageDir: dir })
    expect(reg.size()).toBe(0)
    reg.getOrCreate("a")
    expect(reg.size()).toBe(1)
    reg.getOrCreate("b")
    expect(reg.size()).toBe(2)
    reg.evict("a")
    expect(reg.size()).toBe(1)
    reg.clear()
    expect(reg.size()).toBe(0)
  })
})
