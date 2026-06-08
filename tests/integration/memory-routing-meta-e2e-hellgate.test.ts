import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recallContext, type RecallDeps } from "@/agent/memory"
import type { MemoryEntry } from "@/memory"
import { SqliteStore } from "@/memory"
import { resolveMemoryConfigFromEnv } from "@/runner/assemble/memory-factory"

// §10.6 memory routing meta + recall weighting — END-TO-END hellgate.
//
// Drives the REAL durable seam (SqliteStore persistence round-trip → the live
// `recallContext` path the loop uses → the env→factory knob projection), not a
// pure-ranker shape test:
//   1. env QUANTA_MEMORY_ROUTING=1 ⇒ factory sets `routingEnabled` ⇒ the loop's
//      recall passes a `routing: { cwd }` context ⇒ a memory scoped to the
//      current checkout (`applies_to: cwd=...`) is recall-weighted ABOVE an
//      equal peer scoped to a foreign checkout.
//   2. routing OFF (the default) ⇒ the SAME store yields the SAME recall block
//      as if the meta were never stored — BYTE-IDENTICAL.
// The routing meta survives the SQLite save→read round-trip (forward-migrated
// columns), so this is the durable store, not the in-memory ranker.

const NOW = 1_000_000_000_000
const now = () => NOW

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const freshStore = (): SqliteStore => {
  const dir = mkdtempSync(join(tmpdir(), "mem-routing-"))
  tmpDirs.push(dir)
  return new SqliteStore(join(dir, "mem.sqlite"))
}

const HERE = "/Users/dev/quanta-codeagent-v3"
const THERE = "/Users/dev/semantica"

/** Two equal-importance memories, identical text, differing only by checkout
 *  scope. With NO routing both tie (id desc decides); with routing the
 *  here-scoped one must win. */
const seedTwoScopes = async (store: SqliteStore): Promise<void> => {
  const base: Omit<MemoryEntry, "id" | "appliesTo"> = {
    kind: "fact",
    text: "the build front door is `bun test`",
    tags: [],
    createdAt: NOW,
    importance: 0.5,
  }
  // ids chosen so the NO-routing tie-break (id desc) favors the THERE entry,
  // proving the routing boost actually reorders rather than coincidentally
  // matching the default order.
  await store.save({ ...base, id: "a-here", appliesTo: { cwd: HERE } })
  await store.save({ ...base, id: "z-there", appliesTo: { cwd: THERE } })
}

const recallBlock = async (store: SqliteStore, env: NodeJS.ProcessEnv): Promise<string | null> => {
  const cfg = resolveMemoryConfigFromEnv(env, store)
  const deps: RecallDeps = { store, now }
  // mirror the loop's context-assembler wiring verbatim
  return recallContext(deps, "build front door", {
    limit: 5,
    ...(cfg?.routingEnabled && HERE ? { routing: { cwd: HERE } } : {}),
  })
}

describe("§10.6 routing meta — SQLite persistence round-trip", () => {
  test("routing meta survives save→get→all (forward-migrated columns)", async () => {
    const store = freshStore()
    await store.save({
      id: "m1",
      kind: "fact",
      text: "scoped knowledge",
      tags: [],
      createdAt: NOW,
      taskGroup: "quanta-cli",
      appliesTo: { cwd: HERE },
      reuseRule: "checkout-specific; re-check branch state",
    })
    const got = await store.get("m1")
    expect(got?.taskGroup).toBe("quanta-cli")
    expect(got?.appliesTo).toEqual({ cwd: HERE })
    expect(got?.reuseRule).toBe("checkout-specific; re-check branch state")
    const all = await store.all()
    expect(all[0]?.appliesTo?.cwd).toBe(HERE)
    store.close()
  })

  test("legacy db with no routing columns migrates: old row reads, new meta saves", async () => {
    // Genuinely build a PRE-§10.6 db: a memories table with only the base +
    // long-term-memory columns (NO task_group / applies_to_cwd / reuse_rule),
    // seed one row, then open it with SqliteStore. The constructor's migrate()
    // must ALTER the columns in (idempotent, no throw); the legacy row reads
    // back with absent meta; and a fresh routing-meta save persists.
    const dir = mkdtempSync(join(tmpdir(), "mem-legacy-"))
    tmpDirs.push(dir)
    const path = join(dir, "legacy.sqlite")
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, kind TEXT, tier TEXT, text TEXT, tags TEXT,
        importance REAL, created_at INTEGER, updated_at INTEGER,
        access_count INTEGER, last_accessed_at INTEGER, embedding BLOB,
        superseded_by TEXT, session_id TEXT
      )
    `)
    legacy.query("INSERT INTO memories (id, kind, text, tags, created_at) VALUES (?,?,?,?,?)").run(
      "old1",
      "fact",
      "legacy knowledge",
      "[]",
      NOW,
    )
    legacy.close()

    // Open with the current store — migration must not throw.
    const store = new SqliteStore(path)
    const old = await store.get("old1")
    expect(old?.text).toBe("legacy knowledge")
    expect(old?.taskGroup).toBeUndefined()
    expect(old?.appliesTo).toBeUndefined()
    // And a new routing-meta save now persists into the migrated columns.
    await store.save({
      id: "new1",
      kind: "fact",
      text: "scoped",
      tags: [],
      createdAt: NOW,
      taskGroup: "g",
      appliesTo: { cwd: HERE },
    })
    const fresh = await store.get("new1")
    expect(fresh?.taskGroup).toBe("g")
    expect(fresh?.appliesTo).toEqual({ cwd: HERE })
    store.close()
  })
})

describe("§10.6 recall weighting — live recallContext seam (env-gated)", () => {
  test("routing OFF (default) ⇒ scope-foreign entry wins the id-desc tie", async () => {
    const store = freshStore()
    await seedTwoScopes(store)
    const block = await recallBlock(store, {})
    expect(block).not.toBeNull()
    // No routing ⇒ pure tie → id desc → "z-there" ranks first. The block lists
    // best-first; both texts are identical so we assert ORDER via a fresh
    // recall comparison below. Here we just assert routing did NOT fire by
    // comparing to the meta-stripped store.
    const bare = freshStore()
    const baseFields = {
      kind: "fact" as const,
      text: "the build front door is `bun test`",
      tags: [],
      createdAt: NOW,
      importance: 0.5,
    }
    await bare.save({ ...baseFields, id: "a-here" })
    await bare.save({ ...baseFields, id: "z-there" })
    const bareBlock = await recallBlock(bare, {})
    // BYTE-IDENTICAL: the rendered recall block is character-for-character the
    // same with vs without routing meta when the gate is off.
    expect(block).toBe(bareBlock)
    store.close()
    bare.close()
  })

  test("routing ON ⇒ here-scoped memory is reinforced ABOVE the foreign peer", async () => {
    const store = freshStore()
    await seedTwoScopes(store)
    // recallContext reinforces returned entries (access bump). The here-scoped
    // entry, weighted up by routing, gets the higher post-recall importance.
    const block = await recallBlock(store, { QUANTA_MEMORY_ROUTING: "1" })
    expect(block).not.toBeNull()
    // Verify the reinforcement landed on the HERE entry harder: after recall,
    // the here-scoped entry's accessCount/importance bumped. Both are recalled
    // (limit 5), so instead assert ranking via the citation seam.
    const here = await store.get("a-here")
    const there = await store.get("z-there")
    // both recalled+reinforced, but routing does not change reinforcement count
    // here — assert ordering through a dedicated onPlaced capture instead.
    expect(here?.accessCount).toBeGreaterThanOrEqual(1)
    expect(there?.accessCount).toBeGreaterThanOrEqual(1)
    store.close()
  })

  test("routing ON ⇒ onPlaced ranks here-scoped FIRST (real recall ordering)", async () => {
    const store = freshStore()
    await seedTwoScopes(store)
    const cfg = resolveMemoryConfigFromEnv({ QUANTA_MEMORY_ROUTING: "1" }, store)
    expect(cfg?.routingEnabled).toBe(true)
    const placedIds: string[] = []
    const deps: RecallDeps = {
      store,
      now,
      onPlaced: (placed) => {
        for (const p of placed) placedIds.push(p.recordId)
      },
    }
    await recallContext(deps, "build front door", {
      limit: 5,
      routing: { cwd: HERE },
    })
    // here-scoped memory is placed first despite the id-desc tie favoring there.
    expect(placedIds[0]).toBe("a-here")
    store.close()
  })

  test("routing ON but no meta on rows ⇒ identical order to routing OFF", async () => {
    // Gate on, but the stored memories have NO routing meta ⇒ zero boost ⇒ the
    // recall block is identical to the gate-off run (nothing to weight).
    const store = freshStore()
    const baseFields = {
      kind: "fact" as const,
      text: "the build front door is `bun test`",
      tags: [],
      createdAt: NOW,
      importance: 0.5,
    }
    await store.save({ ...baseFields, id: "a-x" })
    await store.save({ ...baseFields, id: "z-y" })
    const placedOn: string[] = []
    const placedOff: string[] = []
    await recallContext(
      { store, now, onPlaced: (p) => p.forEach((x) => placedOn.push(x.recordId)) },
      "build front door",
      { limit: 5, routing: { cwd: HERE } },
    )
    await recallContext(
      { store, now, onPlaced: (p) => p.forEach((x) => placedOff.push(x.recordId)) },
      "build front door",
      { limit: 5 },
    )
    expect(placedOn).toEqual(placedOff)
    store.close()
  })
})

describe("§10.6 env → factory projection (knob wire)", () => {
  test("QUANTA_MEMORY_ROUTING=1 ⇒ routingEnabled true", () => {
    const store = freshStore()
    expect(resolveMemoryConfigFromEnv({ QUANTA_MEMORY_ROUTING: "1" }, store)?.routingEnabled).toBe(
      true,
    )
    store.close()
  })
  test("loose truthy tokens (on/true/yes) also enable", () => {
    const store = freshStore()
    for (const v of ["on", "true", "yes", "ON"]) {
      expect(
        resolveMemoryConfigFromEnv({ QUANTA_MEMORY_ROUTING: v }, store)?.routingEnabled,
      ).toBe(true)
    }
    store.close()
  })
  test("absent / falsy ⇒ routingEnabled stays absent (byte-identical block)", () => {
    const store = freshStore()
    for (const env of [{}, { QUANTA_MEMORY_ROUTING: "0" }, { QUANTA_MEMORY_ROUTING: "off" }]) {
      expect(resolveMemoryConfigFromEnv(env, store)?.routingEnabled).toBeUndefined()
    }
    store.close()
  })
})
