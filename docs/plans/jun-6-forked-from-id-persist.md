# RFC — persist `forked_from_id` (fork lineage) to disk

**Date:** 2026-06-06
**Status:** Design (NOT implementation). This doc proposes a seam; it ships no code.
**Slice:** `@/session` (`SessionMeta` + the persisted `sessionMetaSchema` + `forkSession`
in `src/session/store.ts`). No new slice — one optional field + one assignment.
**Default posture:** OFF, byte-identical. The field is OPTIONAL; old transcripts (and
non-fork sessions) simply omit it. A session that was not forked has no `forkedFromId` —
its on-disk shape is unchanged.

> Scope note: this is the trivial one. `forkSession` already HOLDS the source id (`id`) at
> the moment it mints the child meta — it just discards it. The whole RFC is "stop
> discarding it." Kept tight per the brief.

---

## 1. 요약 (Summary)

When `forkSession(id, …)` copies a transcript into a new session id, the **lineage link to
the source is lost on disk**: the new `SessionMeta` records `createdAt`, `title` (defaulting
to `"<source> (fork)"`), `cwd`, but **not which session it was forked from**. So a `/fork`
chain is reconstructible only from the `" (fork)"` title suffix — fragile, lossy, and gone
the moment the user renames.

This RFC adds **one optional field** — `forkedFromId?: string` — to `SessionMeta` and its
persisted zod schema, and **one assignment** in `forkSession` (the source `id` is right
there). Old transcripts that lack the field load unchanged (absent ⇒ "not a fork / unknown
parent"). That is the entire feature.

---

## 2. 경쟁사 레퍼런스 (Competitor reference)

- **Codex** session JSONL carries fork/branch lineage in its `turn_context` / thread
  envelope (the v3 memory reference `codex-session-jsonl-envelope` records a
  `thread_spawn` / fork relationship). The cue is simply: **fork lineage is a first-class
  persisted field, not an inferred-from-title convention.**
- The field name `forkedFromId` mirrors the snake-case `forked_from_id` the task names; on
  the wire (envelope schema) it can be `forked_from_id` to match the Codex/JSONL convention,
  while the in-memory `SessionMeta` uses camelCase `forkedFromId` like its siblings
  (`gitSha`/`gitBranch`/`gitOriginUrl`, `src/session/types.ts:28-31`).

---

## 3. 현재 quanta 상태 (grep-verified, cite file:line)

### 3.1 `SessionMeta` has NO fork-parent field

`src/session/types.ts:17-31`:

```ts
export interface SessionMeta {
  id: string
  title: string
  cwd: string
  createdAt: number
  lastTouched: number
  archived: boolean
  gitSha?: string          // ← optional fields already exist (the pattern to copy)
  gitBranch?: string
  gitOriginUrl?: string
}
```

No `forkedFromId` / `parentId` / lineage. `grep -rn "forked_from\|forkedFrom\|forkParent"
src/session/` → **0 hits** — confirmed in-memory-only-and-discarded, never persisted.

### 3.2 `forkSession` HOLDS the source id and throws it away

`src/session/store.ts:418-457`:

```ts
export const forkSession = async (id, opts?, provider?): Promise<string> => {
  const source = await loadSessionById(id, provider)        // `id` = the parent
  …
  const newMeta: SessionMeta = {
    id: newId,
    title: opts?.title ?? `${source.meta.title} (fork)`,    // ← lineage only as a title suffix
    cwd: opts?.cwd ?? source.meta.cwd,
    createdAt: now,
    lastTouched: now,
    archived: false,
    // ← NO forkedFromId, even though `id` is in scope right here
  }
  …
}
```

The parent `id` is the function's first parameter, in scope at the exact line the child meta
is built. One assignment closes the gap.

### 3.3 The persisted schema is NON-strict ⇒ additive field is back-compat

`src/session/store.ts:192-202`, `sessionMetaSchema` mirrors the interface and is a plain
`z.object({…})` (NOT `.strict()`) — so adding `forkedFromId: z.string().min(1).optional()`
loads old files unchanged (the absent field is valid) and never rejects a legacy transcript.
`readSavedSession` (`store.ts:213+`) returns `undefined` only on parse/shape mismatch; an
optional field cannot cause one.

---

## 4. 설계 (Design)

### 4.1 The field (mirror `gitSha`)

```ts
// src/session/types.ts — SessionMeta, next to gitSha (same optional shape)
/** Session id this transcript was forked from (`forkSession`). Absent on
 *  non-fork sessions AND on legacy transcripts minted before this field —
 *  absent means "no known parent", never lossy stripping (same discipline as
 *  the git-fingerprint fields). Persisted so a `/fork` lineage chain survives
 *  rename + reload (the `" (fork)"` title suffix is cosmetic and mutable). */
forkedFromId?: string
```

### 4.2 The schema (mirror the git-fingerprint optionals)

```ts
// src/session/store.ts — sessionMetaSchema, next to gitOriginUrl
forkedFromId: z.string().min(1).optional(),
```

### 4.3 The one assignment

```ts
// src/session/store.ts — forkSession, in newMeta
const newMeta: SessionMeta = {
  id: newId,
  title: opts?.title ?? `${source.meta.title} (fork)`,
  cwd: opts?.cwd ?? source.meta.cwd,
  createdAt: now,
  lastTouched: now,
  archived: false,
  forkedFromId: id,            // ← the source id (the function's first param)
}
```

### 4.4 Round-trip + back-compat

- **Write:** `forkSession` writes `forkedFromId` into the `SavedSession` JSON
  (`writeSessionFile`, `store.ts:453`) and the index meta (`commitMetaAfterSnapshot`,
  `store.ts:455`).
- **Read:** `readSavedSession` parses it through the now-augmented optional schema; present
  ⇒ surfaced on `meta.forkedFromId`, absent ⇒ `undefined`. **No migration step** — optional
  field, old files valid as-is.
- **Preserved across rename/archive:** `renameSession` / `archiveSession` /
  `unarchiveSession` all do `{ ...existing.meta, … }` spreads (`store.ts:288,360,409,…`), so
  they carry `forkedFromId` through untouched automatically — no edits needed there.
- **Envelope mirror (optional, Phase 2):** if the lineage should also appear in the JSONL
  envelope (`src/session/envelope.ts` `SessionMetaRecordSchema`, which is `.strict()`,
  `:74`), add `forked_from_id: NonEmptyString.optional()` there too. Phase-2 only — the
  snapshot JSON is the source of truth; the envelope mirror is for replay tooling.

---

## 5. 통합 (Integration)

- **Knob:** none. The field is set by `forkSession` whenever a fork happens (forks are
  already an opt-in user action via `/fork`); a non-fork session never gets it. No gate
  needed — absence IS the default-OFF.
- **Surface:** `/sessions show <id>` and the fork/list renderer
  (`src/runner/session-ops/index.ts:322`, the "Session … — title (N turns)" line) can append
  `(forked from <shortId>)` when `forkedFromId` is present — a one-line cosmetic add, absent
  ⇒ no change.
- **fc:** one feature-catalog node `fork-lineage-persist` on the session-persistence axis
  (next to the git-fingerprint node).
- **Fence:** entirely within `@/session`. No cross-slice change. The optional `(forked from)`
  render touches only the existing session-ops formatter.

---

## 6. 테스트 계획 (Hellgate + e2e)

`tests/unit/fork-lineage-hellgate.test.ts`:

1. **Round-trip.** `forkSession(parent)` → load child → `meta.forkedFromId === parent`.
2. **Back-compat (the load-bearing case).** A legacy `SavedSession` JSON with **no**
   `forkedFromId` parses cleanly via the augmented schema; `meta.forkedFromId === undefined`;
   no warning logged, no rejection.
3. **Non-fork omits it.** A normally-created session has no `forkedFromId` (absent, not
   `null`/`""`). Assert the written JSON does not contain the key.
4. **Survives rename/archive.** Fork → `renameSession` → reload → `forkedFromId` still
   present and unchanged. Same for archive/unarchive round-trip.
5. **Chain.** Fork A→B→C; assert `C.forkedFromId === B` and `B.forkedFromId === A`
   (lineage is a chain, each link records only its immediate parent).
6. **`min(1)` guard.** A forged JSON with `forkedFromId: ""` is rejected by the schema (the
   `.min(1)` mirrors the git-fingerprint optionals' `NonEmptyString` discipline).

e2e: `/fork <id>` then `/sessions show <newId>` renders the `(forked from …)` line; reload
the CLI and confirm it persists.

---

## 7. 단계 (Phases)

- **Phase 1 (the whole feature):** the optional field on `SessionMeta` + schema + the one
  `forkedFromId: id` assignment in `forkSession`. Hellgate 1–6. Default-OFF (absence).
- **Phase 2 (optional polish):** the `(forked from …)` render line + the `.strict()` envelope
  mirror (`forked_from_id`) for replay tooling + fc node. Backlog-light.

---

## 8. 리스크 / 대안 (Risks & alternatives)

- **R1 — back-compat.** Mitigated by construction: optional field, non-strict snapshot
  schema, absent ⇒ valid. Hellgate 2 is the explicit lock. The git-fingerprint fields
  (`gitSha` et al.) are the proven precedent — they were added the same way without breaking
  legacy reads.
- **R2 — dangling parent reference.** The parent session may later be deleted; `forkedFromId`
  becomes a reference to a non-existent id. *Acceptable:* it is provenance metadata, not a
  live pointer — a consumer that resolves it handles "parent not found" gracefully (the
  fork's own transcript is self-contained; the lineage is informational).
- **R3 — privacy.** The id is an opaque UUID, not a path or secret — no leak surface.
- **Alternative — infer lineage from the `" (fork)"` title suffix.** That is the status quo,
  and it is fragile: the suffix is a default that `opts.title` overrides and `renameSession`
  wipes. Persisting the id is strictly more robust at one field's cost.

---

## 9. 코드 위치 요약 (Code-location summary)

**Audited (read, grounds the design):**
- `src/session/types.ts:17-31` — `SessionMeta` (no fork field; `gitSha` optional precedent).
- `src/session/store.ts:418-457` — `forkSession` (holds `id`, discards lineage).
- `src/session/store.ts:192-202` — `sessionMetaSchema` (non-strict ⇒ additive-safe).
- `src/session/store.ts:288,360,409` — `{ ...existing.meta }` spreads that auto-carry the field.
- `src/session/envelope.ts:74` — the `.strict()` envelope mirror (Phase-2 optional add).
- `src/runner/session-ops/index.ts:322` — the session render line for the `(forked from)` add.

**To add (implementation, NOT in this RFC):**
- `src/session/types.ts` — `forkedFromId?: string`.
- `src/session/store.ts` — schema field + `forkedFromId: id` in `forkSession`.
- `tools/feature-catalog/…` — `fork-lineage-persist` node.
- `tests/unit/fork-lineage-hellgate.test.ts` — the §6 battery.
