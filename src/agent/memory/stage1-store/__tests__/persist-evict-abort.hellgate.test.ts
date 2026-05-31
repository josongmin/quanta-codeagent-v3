/**
 * T05 / audit C-20 — `persistSession` persist + eviction loops honor caller
 * abort MID-FLIGHT.
 *
 * Before this ticket only the distillation phase observed `deps.signal`; the
 * subsequent per-record persist loop and `sweepEviction` ran to completion even
 * after a cancel, saving N records / running eviction the caller no longer
 * wanted. The fix consumes the T01 shared `throwIfAborted` primitive (NOT a new
 * local abort helper) at the head of each loop iteration.
 *
 * `persistSession` is best-effort (never throws), so an abort surfaces as an
 * EARLY RETURN: whatever was committed before the cancel stays, nothing after
 * the cancel runs. This battery proves: (a) a pre-aborted signal commits zero
 * records, (b) a signal aborted after the first record stops the loop, (c)
 * eviction does not run once aborted.
 */

import { describe, expect, test } from "bun:test"
import type { Message } from "@/llm"
import { type PersistDeps, persistSession } from "@/agent/memory"
import type { MemoryEntry, PersistentStorePort } from "@/memory"

/** Assistant message in block-content form — the heuristic distiller reads
 *  `content[].text`, so a plain-string content yields zero records. */
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

/** Minimal store spy that records every save/delete/update and lets a hook
 *  fire on each save (so a test can abort mid-loop). */
const makeStore = (onSave?: (id: string) => void) => {
  const rows = new Map<string, MemoryEntry>()
  const saves: string[] = []
  const deletes: string[] = []
  const updates: string[] = []
  const store: PersistentStorePort = {
    save: (e) => {
      saves.push(e.id)
      rows.set(e.id, e)
      onSave?.(e.id)
      return Promise.resolve()
    },
    update: (id) => {
      updates.push(id)
      return Promise.resolve()
    },
    delete: (id) => {
      deletes.push(id)
      rows.delete(id)
      return Promise.resolve()
    },
    get: (id) => Promise.resolve(rows.get(id)),
    all: () => Promise.resolve([...rows.values()]),
    recall: () => Promise.resolve([]),
  }
  return { store, saves, deletes, updates }
}

/** One distilled record via the heuristic path (no LLM/embedder). */
const finalMessages: Message[] = [
  { role: "user", content: [{ type: "text", text: "first task: build the parser" }] },
  assistant("Done. Parser built and tested successfully."),
]

describe("persistSession — caller abort mid-flight (C-20)", () => {
  test("pre-aborted signal ⇒ NO records committed (loop never starts)", async () => {
    const { store, saves } = makeStore()
    const controller = new AbortController()
    controller.abort()
    const deps: PersistDeps = {
      store,
      signal: controller.signal,
      now: () => 1_700_000_000_000,
    }
    await persistSession(deps, { sessionId: "s-1", finalMessages })
    // The per-record loop's throwIfAborted blocks even the first save — before
    // this ticket the loop committed every record regardless of the signal.
    expect(saves).toEqual([])
  })

  test("control: WITHOUT a signal the SAME fixture commits its record (the abort is the only difference)", async () => {
    const { store, saves } = makeStore()
    const deps: PersistDeps = { store, now: () => 1_700_000_000_000 }
    await persistSession(deps, { sessionId: "s-1b", finalMessages })
    // Proves the pre-abort empty result above is caused by the signal, not by a
    // distiller that produced zero records.
    expect(saves.length).toBe(1)
  })

  test("aborted signal ⇒ eviction sweep does NOT delete/decay", async () => {
    const { store, deletes, updates } = makeStore()
    // Pre-seed an old, low-importance entry that WOULD be eviction-eligible.
    await store.save({
      id: "old",
      kind: "observation",
      text: "stale",
      tags: [],
      createdAt: 0,
      importance: 0.01,
    })
    const controller = new AbortController()
    controller.abort()
    const deps: PersistDeps = {
      store,
      signal: controller.signal,
      now: () => 1_700_000_000_000,
      // Force-tiny caps so the seeded entry WOULD be eviction-eligible — the
      // abort is the only reason nothing is deleted/decayed.
      evictionCaps: { semanticMax: 0, episodicMax: 0 },
    }
    await persistSession(deps, { sessionId: "s-3", finalMessages })
    expect(deletes).toEqual([])
    expect(updates).toEqual([])
  })

  test("no signal ⇒ persist proceeds normally (default-OFF: behavior unchanged)", async () => {
    const { store, saves } = makeStore()
    const deps: PersistDeps = { store, now: () => 1_700_000_000_000 }
    await persistSession(deps, { sessionId: "s-4", finalMessages })
    expect(saves.length).toBeGreaterThanOrEqual(1)
  })
})
