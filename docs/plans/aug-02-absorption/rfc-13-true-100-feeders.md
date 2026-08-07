# RFC-13 — True-100 feeders: close the last 2 upstream hops

**Status:** SCOPED — grounded plan for the 2 remaining feeder hops that keep two niche features from firing end-to-end. Everything else (RFC-01~12 + the 7-item deferred wave + the 3 daemon/route feeders) is wired, gated default-OFF, knob-registered (orphan 0/0), and real-nm verified on `main@615b9b586`. These 2 hops make **anchored-comment overlay** and **/rewind --restore-files** actually fire. Both additive, default-OFF, byte-identical-off. Current behavior is already SAFE (fail-closed / empty overlay); this is the last-mile producer binding.

## Why only these 2 remain

The 100%-audit proved wiring + knobs are complete. Two features are multi-hop producer→consumer chains where the final upstream *producer binding* is deferred:
- **anchored-comment**: web render ✓ (RFC12) + daemon SSOT/emit/projector ✓ (F2 `reviewFindingsToAnchors`, `9a6c1218f`) — but nothing feeds a real `git_review_diff`'s `ReviewFinding` anchors into a canvas `capture(...)`. The write/edit capture path has no review by design.
- **/rewind --restore-files**: coordinator ✓ (`aae7a0894`) + checkpoint-capture feeder ✓ (F3 `feedCheckpointCapture`, `159c57624`) — but the persist path never assigns durable **message ids**, so the feeder no-ops (`no-message-id`) and `/rewind` renders "no addressable message ids" (`rewind-cmd.ts:273`).

## HOP-1 — feed `git_review_diff` anchors into the canvas overlay

**Grounding (quanta):**
- Producer: `src/tool/git/review-diff.ts` / `review-anchor.ts` build `ReviewFinding{anchor{line}, verdict, category, shortSummary}` (RFC-09-2). `git_review_diff` is a READ tool (produces findings over `origin/main...HEAD`; does not mutate).
- Sink (ready): `src/apps/web-daemon/canvas-tool-diff-source.ts` — `capture(input: CapturedToolDiff)` accepts `anchors`; `reviewFindingsToAnchors(findings, diffPath)` (F2) already converts findings→`DiffAnchorComment`. The daemon SSOT `ToolDiffMessage.anchors?` + emitter emit them (F2). The web `DiffView.comments` overlay renders them (RFC12).
- GAP: `capture(...)` is only called by file-mutating tools (`write`/`edit`), which carry no review findings (`canvas-tool-diff-source.ts:5` header). Nothing routes `git_review_diff`'s diff + findings into a `capture(...)`.

**Implementation (additive producer):**
1. When `git_review_diff` runs and a canvas tool-diff sink is wired, emit a `capture({ path, before/after or unified diff, anchors: reviewFindingsToAnchors(findings, path) })` for the reviewed diff — so the canvas shows the review's own diff WITH its anchored comments. The sink is the EXISTING `CanvasToolDiffSource.capture`; reuse `reviewFindingsToAnchors` (already built). NO new emitter/schema.
2. Composition-root binding: thread the canvas tool-diff sink into `git_review_diff`'s tool context (the same `ToolContext` the write/edit path uses), gated on the existing canvas gate (the daemon/web surface). Absent sink ⇒ `git_review_diff` behaves exactly as today (findings returned to the model; no canvas emit) — byte-identical.

**Owner:** `src/tool/git/review-diff.ts` (emit at the review boundary) + the canvas tool-diff sink composition. **Gate:** rides the existing canvas surface gate; absent sink ⇒ byte-identical. **Admission RED:** a real `git_review_diff` with findings emits NO `ToolDiffMessage` with anchors to the canvas ⇒ overlay empty end-to-end; red-on-injection = drop the review→capture emit ⇒ overlay stays empty. **Effort:** S-M. **ROI:** niche web-observability (agent review findings visible inline in the web surface).

## HOP-2 — durable message-id assignment at the persist boundary

**Grounding (quanta):**
- `src/runner/orchestrate/persist-turn.ts` saves `messages: Message[]` via `saveSessionById` (id-mode), then fires the `PersistTurnCheckpointHook` (F3) which binds a checkpoint to the **last message id**. `Message.id` is OPTIONAL (`rewind-cmd.ts:325 id?: string`).
- Consumers require ids: `src/session/rewind.ts:159` `findIndex(m => m.id === fullId)`; `rewind-cmd.ts:273` prints "no addressable message ids (legacy / id-less)" when messages lack ids; F3's `feedCheckpointCapture` no-ops at `no-message-id`.
- GAP: NO production path assigns `Message.id` (grep: `assignMessageIds` absent from `persist-turn`/session save). So ids are always absent → `/rewind` + checkpoint-capture both inert.

**Implementation (idempotent, gated, at the per-TURN persist boundary — NOT the token hot loop):**
1. At the TOP of `persist-turn.ts` (before `saveSessionById` and the checkpoint hook), when the id-assign gate is ON, assign a STABLE id to each id-LESS message in the array — **idempotent**: a message that already has an id keeps it (survives reload/resume; never re-minted). Simplest stable scheme: per-session sequential (`m{n}` by position) OR a deterministic content-independent sequence; assigned once, persisted via the existing optional `Message.id`, preserved on reload. This is per-turn (once at save), NOT per-token — the same boundary F3's hook already lives on, so it is tractable and not the "in-loop" hot path the F3 note flagged.
2. Because the ids must exist BEFORE both the save (so the transcript is addressable) AND the checkpoint hook (F3 binds to them), assign them first in `persist-turn`, then save, then hook.
3. Gate: reuse `QUANTA_REWIND_CAPTURE` (F3's gate) OR a dedicated `QUANTA_MESSAGE_IDS` — register in BOTH `runtime-config.ts` + `runtime-config-knobs` (parity). Default-OFF ⇒ NO id assignment ⇒ saved transcript byte-identical (id field absent) ⇒ `/rewind` fail-closes as today. ON ⇒ ids present ⇒ `/rewind` + checkpoint-capture fire.

**Owner:** `src/runner/orchestrate/persist-turn.ts` (assign before save+hook). **Gate:** default-OFF; OFF ⇒ transcript byte-identical + `/rewind` fail-closed (today). **Admission RED:** gate ON — after a turn, saved messages have NO ids ⇒ `/rewind` still "no addressable ids" and checkpoint-capture no-ops; red-on-injection = drop the assign ⇒ reverts to id-less. Gate-OFF ⇒ transcript byte-identical (assert deep-equal to id-less save). **Risk:** per-turn (not per-token); idempotent (stable across resave); the only shape change is the additive `id` on messages when ON (already an optional schema field). Must prove: (a) OFF byte-identical, (b) ids stable across a resume/resave (same message keeps its id), (c) the 618+ loop baseline unaffected. **Effort:** M. **ROI:** unlocks `/rewind --restore-files` (durable file-level undo to a prior turn) + makes F3's checkpoint-capture actually capture.

## Landing rules

Both additive, default-OFF, single-owner (HOP-1 = review-diff emit + existing canvas sink; HOP-2 = persist-turn), reuse existing owners (reviewFindingsToAnchors / captureCheckpoint / Message.id) — NO new store/schema/emitter. Hellgate (admission RED + gate-OFF byte-identical + red-on-injection) + ≥3R hellaudit. HOP-2 must additionally prove id STABILITY across resume/resave and zero hot-loop regression. After both: anchored-comment overlay populates from real reviews, and `/rewind --restore-files` restores to a captured checkpoint — true end-to-end 100% for the two remaining features. Neither is a SWE-score lever; both are agent-state-observability / durable-undo UX, measure-first.
