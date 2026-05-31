# Rejected false-positives (6)

Findings raised by the finders that the adversarial **verification pass rejected** after re-reading the source. Recorded so they are not re-raised in future audits. Each entry: the claim, the file:line, and *why it's not a real bug*.

---

## FP-1 · plugin · "launchPluginMcpServers uses `manifest.name` instead of pluginId"
- **File:** [src/agent/plugin-mcp-launcher/launcher.ts:113](../../../src/agent/plugin-mcp-launcher/launcher.ts#L113)
- **Verdict:** invalid (dead code)
- **Why:** The function is never called in production (ADR-0338: "this is a primitive… wiring belongs to a follow-up ADR"). The real activation handler (`handler.ts` `runMcpStep`, 143-181) never calls it and passes `pluginId` correctly. The launcher's imported manifest type (`@/skill/plugin-manifest`) has **no `id` field**, so `manifest.name` is the only identifier available — internally consistent for that type. Bug only materializes if the function is wired with a discovery manifest. Tracked as the **latent** finding C-15 + dead-code C-16 instead.

## FP-2 · plugin · "SOLID: launchPluginMcpServers imports wrong PluginManifest type"
- **File:** [src/agent/plugin-mcp-launcher/launcher.ts:38](../../../src/agent/plugin-mcp-launcher/launcher.ts#L38)
- **Verdict:** invalid as raised → **re-scoped** to C-15
- **Why:** The type mismatch is real but **unreachable**: only test files call `launchPluginMcpServers`, and the production handler deliberately bypasses it (handler.ts comment 113-115 documents the ADR-0336 vs ADR-0039 shape difference). Zero runtime impact today. We keep it as C-15 (HIGH, *latent*) because it's a genuine architectural defect that becomes a real bug on wiring — but it is **not** an active bug, so the "this will break registry ops now" framing is rejected.

## FP-3 · plugin · "Incorrect manifest id usage breaks registry ops"
- **File:** [src/agent/plugin-mcp-launcher/launcher.ts:113](../../../src/agent/plugin-mcp-launcher/launcher.ts#L113)
- **Verdict:** false-positive (duplicate of FP-1 from a different finder)
- **Why:** Same as FP-1 — the launcher uses the skill manifest type that only has `name`; line 113 is correct *for that type*. Discovery manifests never reach the launcher.

## FP-4 · plugin · "Resource leak: handles added after shutdownAll() clears maps are never shut down"
- **File:** [src/agent/plugin-mcp-launcher/registry.ts:54-74](../../../src/agent/plugin-mcp-launcher/registry.ts#L54-L74)
- **Verdict:** false-positive — the finder read the order backwards
- **Why:** The code **snapshots handles (58-61) BEFORE clearing the maps (62-63)**, with an explicit comment: "Snapshot the handles before clearing so a track() racing with shutdownAll cannot cause a handle to be leaked. Order: handles first, then clear." Handles added after the snapshot belong to the next `shutdownAll()` call. Intentional, correct.

## FP-5 · memory-core · "Race: SqliteStore.update() read-then-update without transaction isolation"
- **File:** [src/memory/adapters/sqlite.ts:167-175](../../../src/memory/adapters/sqlite.ts#L167-L175)
- **Verdict:** false-positive — race not reachable
- **Why:** The read-then-update pattern is theoretically racy, but every call path is **sequential `await`**: `reinforce()` (memory.ts:148-154), `applyOp()`/`sweepEviction()` for-loops, and `recallContext`/`persistSession` in the main loop (loop.ts:692, :1987) are all awaited in series. No `Promise.all([update, update])` on the same id exists in the codebase. (Note: this is distinct from the *cross-process* concern in ML-12, which remains a real medium.)

## FP-6 · memory-core · "Unwrapped appendFileSync in JsonlFileStage1Store.append() causes state inconsistency"
- **File:** [src/memory/stage1-store/jsonl-file.ts:155-167](../../../src/memory/stage1-store/jsonl-file.ts#L155-L167)
- **Verdict:** false-positive as a *bug* — intentional design
- **Why:** ADR-0207 explicitly documents **best-effort durability**: "the in-memory hydrated map is the source of truth post-construction; the on-disk log is the crash-recovery seed." The port contract (port.ts:17-19) permits fire-and-forget on the mutate side; `hydrate()` skips corrupt lines; the `chmodSync` swallow (162-166) establishes that file-I/O failures in this cache layer are accepted. Data isn't lost — it stays in the in-memory source of truth. **Caveat:** the *coupling* defect (in-memory advanced + disk write failed mid-`touch`) **is** real and kept as C-8 — that's about the `touch()` wrapper breaking atomicity, not about `append()` itself being unwrapped.
