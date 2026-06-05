# RFC — AI-generated session title (cheap LLM call on the first turn)

**Date:** 2026-06-06
**Status:** Design (NOT implementation). This doc proposes a seam; it ships no code.
**Slice:** `@/agent` (a first-turn hook on the `session_start` path in `loop.ts`) + a tiny
new leaf for the title generator (closed-port `LLMPort` injection) + `@/session`
(`SessionMeta.title` write via the existing `renameSession`). No mutation of the main turn.
**Default posture:** OFF, byte-identical. Gated behind `QUANTA_SESSION_AUTO_TITLE` (default
unset ⇒ no extra LLM call, no title write, no behavior change). Fire-and-forget / best-effort
— it NEVER blocks, delays, or fails the turn.

> Scope note: titles today are **manual only** (`/sessions rename` or the `" (fork)"`
> default). This RFC adds an opt-in, cost-gated, cheap-model call that names the session from
> the first user prompt, written off the hot path. The cheap-model knob mirrors the existing
> `QUANTA_COMPACT_MODEL` precedent exactly.

---

## 1. 요약 (Summary)

A session's title is set **only manually** today: `renameSession(id, title)` from
`/sessions rename`, or the auto `"<source> (fork)"` suffix on fork. A brand-new session's
title is whatever the surface seeded (often the id or a placeholder) until a human renames
it — so session lists are unscannable until the user does bookkeeping.

This RFC adds an **opt-in auto-titler**: on the **first turn only**, fire a **cheap-model**
LLM call (`summarize this request in ≤6 words`) against the first user prompt, and write the
result to `SessionMeta.title` via the existing `renameSession`. Three hard constraints:

1. **Default-OFF** — `QUANTA_SESSION_AUTO_TITLE` unset ⇒ zero extra calls, zero title writes,
   byte-identical loop.
2. **Never blocks** — fire-and-forget: the title call runs **concurrently** with (or detached
   from) the real turn; the turn never awaits it, and a failed/slow title call is swallowed.
3. **Cost-gated + cheap** — uses an injected, separately-configured cheap `LLMPort`
   (`QUANTA_SESSION_TITLE_MODEL`, mirroring `QUANTA_COMPACT_MODEL`), not the main model; runs
   **once per session** (first turn), never per-turn.

Closed-port: the title generator takes an injected `LLMPort` + a `renameSession` writer port
+ an injected clock — no `Date.now`/`process.env` in the leaf.

---

## 2. 경쟁사 레퍼런스 (Competitor reference)

- **Claude Code** auto-summarizes a conversation into a short title shown in its session
  list, generated from the opening message via a cheap model — the exact UX this absorbs.
- **Codex** names archived sessions; its corpus calibration (`codex-session-corpus-…`) shows
  sessions are listed/browsed at scale, which is precisely when an auto-title pays off.
- The honest divergence: quanta makes it **opt-in + best-effort + cheap-model-pinned** rather
  than always-on, because quanta's posture is "no surprise spend" — an extra LLM call must be
  a deliberate knob, and it must never be on the latency-critical path of the user's turn.

---

## 3. 현재 quanta 상태 (grep-verified, cite file:line)

### 3.1 Titles are manual-only

- `renameSession(id, title)` (`src/session/store.ts:404-409`) is the ONLY title writer:
  `const nextMeta = { ...existing.meta, title, lastTouched: Date.now() }`.
- It is reached only from `/sessions rename` (`src/runner/session-ops/index.ts:356`,
  `await renameSession(id, title)`) and the fork default `"<source> (fork)"`
  (`store.ts:431`). `grep -rn "auto.?title\|generateTitle\|titleFromPrompt" src/` → **0 hits**
  — no auto-titler exists.

### 3.2 The first-turn fire point already exists

`src/agent/loop.ts:2533-2535`:

```ts
args.cfg.stream.emit({ type: "session_start" })
await args.cfg.hooks.emit({ type: "session_start", sessionId: args.sessionId })
```

`session_start` fires ONCE per run (the `HookEvent` `session_start` carries `sessionId`,
`hooks.ts:127`). The first user prompt is observable at the same point via the
`user_prompt_submit` hook (`hooks.ts:190`, "the prompt the model is about to see"). Either is
a clean, already-wired first-turn anchor — no new lifecycle plumbing needed.

### 3.3 The cheap-model knob precedent is exact

`QUANTA_COMPACT_MODEL` (`src/runner/assemble/compaction.ts:52`, "`QUANTA_COMPACT_MODEL`
value (trimmed). Empty/undefined ⇒ `undefined`") is the established pattern for "a
*separate, cheaper* model for a background subtask". The title model copies it verbatim as
`QUANTA_SESSION_TITLE_MODEL`. The `LLMPort` it builds is the same `createLLM` factory
(`src/llm/factory.ts:277`) the loop uses, just pinned to the cheap model.

### 3.4 `LLMPort` is a clean injection surface

`src/llm/ports.ts:4-31` — `LLMPort.stream(input): AsyncIterable<StreamEvent>` plus optional
`model`/`provider` metadata. The titler consumes exactly this interface (one short
non-streaming-equivalent call, drained to a string), so it is fully closed-port: inject an
`LLMPort`, no factory coupling in the leaf.

---

## 4. 설계 (Design — closed-port DI)

### 4.1 The titler leaf (pure, injected ports)

A tiny new leaf `src/agent/session-title/` (or `src/session/auto-title.ts`):

```ts
interface AutoTitlePorts {
  llm: LLMPort                               // injected cheap-model port
  rename: (id: string, title: string) => Promise<void>   // adapter over renameSession
  clock: () => number                        // injected (no Date.now in the leaf)
  maxWords?: number                          // default e.g. 6
  timeoutMs?: number                         // injected cap; best-effort
}

async function generateSessionTitle(
  sessionId: string,
  firstPrompt: string,
  ports: AutoTitlePorts,
): Promise<void>   // resolves void; ALL failures swallowed (best-effort)
```

It builds a minimal prompt ("Summarize this request as a ≤6-word title, no punctuation:
\n<firstPrompt truncated to N chars>"), drains `ports.llm.stream(...)` to text, sanitizes
(strip newlines, clamp length), and `await ports.rename(sessionId, title)`. Any throw/timeout
⇒ caught, logged at debug, returns — **never propagates**.

### 4.2 Fire-and-forget wiring (the never-block guarantee)

At the `session_start` fire point (`loop.ts:2535`), when the knob is ON and the session has
no human-set title yet, the loop **kicks off** `generateSessionTitle(...)` **without
awaiting it**:

```ts
if (autoTitlePort && isFirstTurn && !hasUserTitle) {
  void autoTitlePort.maybeTitle(sessionId, firstPromptText)   // detached, never awaited
}
```

`autoTitlePort` is an **injected duck-typed seam** (closed-port DI) built at the composition
root from the cheap `LLMPort` + a `renameSession` adapter + clock. Absent (knob off / not
wired) ⇒ the branch never runs ⇒ byte-identical. The turn proceeds immediately; the title
write lands whenever the cheap call returns (typically after the turn is well underway, which
is fine — it only updates metadata).

### 4.3 Run-once + don't-clobber

- **Once per session:** gated on `isFirstTurn` (the loop already tracks turn count;
  `turn_start` carries `turn`, `hooks.ts:182`) so it never fires on turn 2+.
- **Don't clobber a human title:** before writing, re-check the session's current title; if it
  differs from the seeded placeholder (i.e. a human already renamed it, possibly racing),
  **skip the write**. The check is a fresh `loadSessionById` read inside the titler (it owns
  the read→write, last-writer-aware). This makes the auto-title strictly subordinate to manual
  rename.
- **Idempotent:** if two runs somehow race (resume + first turn), the title write is a plain
  `renameSession` (a `{ ...meta, title }` spread, `store.ts:409`) — last write wins, no
  corruption.

### 4.4 Cost + latency gating

- Cheap model pinned via `QUANTA_SESSION_TITLE_MODEL` (mirrors `QUANTA_COMPACT_MODEL`,
  §3.3); if unset, the feature can fall back to the main model OR stay inert — **recommended
  inert** (require an explicit cheap model so the feature can never silently bill the
  expensive model).
- `timeoutMs` cap (injected) abandons a slow title call — best-effort, the session just keeps
  its placeholder title.
- The prompt truncates `firstPrompt` to a small char budget (e.g. 2K) so input cost is
  bounded regardless of prompt size.

---

## 5. 통합 (Integration)

- **Knob (default-OFF):** `QUANTA_SESSION_AUTO_TITLE` (boolean, default unset ⇒ feature
  inert) + `QUANTA_SESSION_TITLE_MODEL` (cheap model id; unset ⇒ inert, never falls back to
  the expensive model). Both registered in the knob registry + `help-render.ts` next to
  `QUANTA_COMPACT_MODEL`.
- **Hook/first-turn:** the detached kick-off at the `session_start` fire point
  (`loop.ts:2535`); no new hook event needed — it reuses the existing first-turn anchor.
- **LLM:** the cheap `LLMPort` built by the composition root via `createLLM`
  (`factory.ts:277`) pinned to `QUANTA_SESSION_TITLE_MODEL`; injected into the titler leaf.
- **Session write:** via the existing `renameSession` (`store.ts:404`) — no new persistence
  path, the title rides the proven meta-spread.
- **fc:** one feature-catalog node `ai-session-title` on the session-UX axis; reachability
  wired through the kick-off → titler → renameSession path.
- **Fence:** the titler leaf imports only `LLMPort` (`@/llm` type) and takes the `rename`
  writer + clock as injected ports — it does NOT import `@/session` store internals or
  `@/agent` loop internals. The composition root wires the real `renameSession` adapter.

---

## 6. 테스트 계획 (Hellgate + e2e)

`tests/unit/ai-session-title-hellgate.test.ts` (fake `LLMPort` + fake `rename` + fake clock):

1. **Default-OFF ⇒ byte-identical.** Knob unset ⇒ titler never invoked, no LLM call, no
   `rename` call; the loop's first turn is identical to baseline.
2. **Happy path.** Knob on + fake LLM returns "Fix auth bug" ⇒ `rename(sessionId, "Fix auth
   bug")` called exactly once; sanitized (no newlines, clamped).
3. **Never blocks.** The fake LLM hangs (never resolves); assert the **turn completes
   normally** (the title promise is detached, the turn does not await it) — the headline
   guarantee.
4. **Best-effort swallow.** Fake LLM throws ⇒ no rename, no thrown error, turn unaffected;
   debug log emitted, nothing propagates.
5. **Run-once.** Drive turns 1,2,3 ⇒ the titler is invoked only on turn 1.
6. **Don't-clobber.** A human `renameSession` lands before the title call returns ⇒ the titler
   re-reads, sees a non-placeholder title, **skips** the write (manual wins).
7. **Cost gate.** `QUANTA_SESSION_TITLE_MODEL` unset ⇒ feature inert even with
   `QUANTA_SESSION_AUTO_TITLE=1` (never bills the expensive model).
8. **Timeout.** Slow LLM beyond `timeoutMs` (fake clock) ⇒ abandoned, placeholder kept, turn
   fine.

e2e (gated): with both knobs set against a recorded cheap-model fixture, start a session with
a real first prompt → after the turn, `/sessions list` shows the generated title; with knobs
unset → placeholder title unchanged.

---

## 7. 단계 (Phases)

- **Phase 1 (core):** the titler leaf (injected `LLMPort` + `rename` + clock) + the detached
  `session_start` kick-off + `QUANTA_SESSION_AUTO_TITLE` / `QUANTA_SESSION_TITLE_MODEL` knobs.
  Hellgate 1–5,7,8. Default-OFF.
- **Phase 2 (polish):** the don't-clobber re-read (6) + fc node + `/sessions` render
  surfacing the auto vs manual provenance (optional).
- **Phase 3 (optional):** re-title on major topic shift (e.g. after a compaction the title is
  stale) — a *second* best-effort call gated behind a stricter knob. Backlog; out of scope.

---

## 8. 리스크 / 대안 (Risks & alternatives)

- **R1 — surprise spend (the headline cost risk).** *Mitigation:* default-OFF + a **separate
  cheap-model knob that must be explicitly set** (no silent fallback to the expensive model,
  §4.4) + once-per-session + truncated input. Hellgate 7 locks the cost gate. ROI: one tiny
  call per session vs. unscannable session lists.
- **R2 — blocking / latency on the user's turn.** *Mitigation:* fire-and-forget — the turn
  never awaits the title promise (§4.2); a hung/slow call is abandoned via `timeoutMs`.
  Hellgate 3 is the explicit never-block lock. This is the single most important invariant.
- **R3 — clobbering a human title.** *Mitigation:* the don't-clobber re-read (§4.3, Hellgate
  6) — manual rename always wins; the auto-title is subordinate.
- **R4 — bad/garbage title from the model.** Sanitized (strip newlines, clamp length, drop
  punctuation per prompt); worst case is a slightly-off short string that the user can rename
  — strictly better than the placeholder. Per `no-heuristics-only-validated`, the prompt
  wording should be tuned against sampled outputs, not asserted quality.
- **R5 — prompt injection in the first user message steering the title.** Bounded blast
  radius: the title is metadata-only (a display string), never executed, never fed back into
  the agent loop; a malicious title is at most cosmetic.
- **Alternative — derive a title heuristically (first N chars of the prompt).** Zero-cost but
  low-quality (a raw prompt prefix is not a title). Offered as a `mode: "prefix" | "llm"`
  fallback so a cost-averse operator gets *something* with no LLM call — recommended as a
  Phase-2 sub-option, not the default.
- **Alternative — do it on session *end* (summarize the whole session).** Higher quality but
  the title is useless during the session (when the user is actually browsing the list).
  First-turn is the right moment; end-of-session re-title is the Phase-3 polish.

---

## 9. 코드 위치 요약 (Code-location summary)

**Audited (read, grounds the design):**
- `src/session/store.ts:404-409` — `renameSession` (the only title writer; the write path).
- `src/runner/session-ops/index.ts:356` — `/sessions rename` (the manual-only caller).
- `src/agent/loop.ts:2533-2535` — the `session_start` first-turn fire point.
- `src/agent/hooks.ts:127,182,190` — `session_start`/`turn_start`/`user_prompt_submit` anchors.
- `src/runner/assemble/compaction.ts:52` — `QUANTA_COMPACT_MODEL` (the cheap-model knob
  precedent).
- `src/llm/ports.ts:4-31` — `LLMPort` (the injected interface).
- `src/llm/factory.ts:277` — `createLLM` (builds the cheap port at the composition root).

**To add (implementation, NOT in this RFC):**
- `src/agent/session-title/` (or `src/session/auto-title.ts`) — the titler leaf (injected
  `LLMPort` + `rename` + clock).
- `src/agent/loop.ts` (composition root) — the detached `void autoTitlePort.maybeTitle(...)`
  kick-off + injected `autoTitlePort`.
- `src/runner/knobs/…` + `help-render.ts` — `QUANTA_SESSION_AUTO_TITLE` +
  `QUANTA_SESSION_TITLE_MODEL`.
- `tools/feature-catalog/…` — `ai-session-title` node.
- `tests/unit/ai-session-title-hellgate.test.ts` — the §6 battery.
