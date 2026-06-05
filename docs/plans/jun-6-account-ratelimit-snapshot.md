# RFC — account rate-limit snapshot (proactive backoff from `*-ratelimit-*` headers)

- Status: DRAFT (design only — no source changed by this RFC)
- Date: 2026-06-06
- Axis: `@/llm` usage/header parsing + `@/agent` retry policy
- Pair: builds on the **B3 `retry-after` work** (LANDED, grep-verified §3.2) which parses
  `retry-after` / `retry-after-ms` / `x-ratelimit-reset` to drive a server-instructed delay
  AFTER a 429. This RFC adds the PROACTIVE half: read the remaining-quota / reset headers on
  EVERY response and back off BEFORE the 429 fires.
- Default-OFF, byte-identical when the knob is unset (no header read on success, no notify).
- ROI: **MEDIUM** — turns blind 429-then-retry into "slow down as you approach the cap",
  reducing wasted requests + tail latency on quota-tight accounts. Bounded value (only helps
  accounts that actually run near their TPM/RPM ceiling).

---

## 1. 요약 (Summary)

Today quanta is purely REACTIVE to rate limits: it parses the `retry-after` family ONLY at
the error boundary (`LLMError.fromSdkError`, `errors.ts:213, 304-315`) and waits the
server-instructed delay AFTER a 429 has already burned a request
(`retry.ts:69-79, 145-158`). It never reads the `x-ratelimit-remaining-*` /
`anthropic-ratelimit-*` headers that providers return on EVERY response (success or
failure), which advertise "you have N requests / M tokens left in this window, resetting at
T." So quanta keeps firing at full rate until it slams into the ceiling, eats a 429, and
only THEN backs off.

This RFC adds an **account rate-limit snapshot**: a pure parser that reads the
remaining/limit/reset headers off each provider response, a small per-route snapshot store,
and a proactive-backoff policy that inserts a short pre-request delay when the remaining
quota is critically low (and the reset is imminent), plus a notify surface so a UI can show
"⚠ approaching rate limit, N tokens left, resets in Ms." All of it is gated default-OFF and
adds ZERO behavior when the knob is unset (no header read, no delay, no event). The header
parsing reuses the proven magnitude-band/HTTP-date discipline B3 already built for
`x-ratelimit-reset` (`errors.ts:357-396`).

---

## 2. 경쟁사 레퍼런스 (Anthropic — verified headers)

### 2.1 The rate-limit response headers (verified via claude-api skill)

Verified against the bundled `claude-api` skill (`shared/error-codes.md` § 429, +
`shared/managed-agents-api-reference.md`): on a 429 Anthropic returns `retry-after` plus
`x-ratelimit-limit-*` and `x-ratelimit-remaining-*`. These remaining/limit headers are
returned on NON-429 responses too — they are the live quota meter, not just an error
artifact. The canonical family (Anthropic spelling): `anthropic-ratelimit-requests-remaining`,
`anthropic-ratelimit-requests-reset`, `anthropic-ratelimit-tokens-remaining`,
`anthropic-ratelimit-tokens-reset` (primary window), with secondary/input-output token
windows. OpenAI's mirror: `x-ratelimit-remaining-requests` / `x-ratelimit-remaining-tokens`
/ `x-ratelimit-reset-requests` / `x-ratelimit-reset-tokens`. (근거: claude-api skill names the
`x-ratelimit-*` / `anthropic-ratelimit-*` headers as the proactive signal; the exact
secondary-window spellings are provider-doc-derived, treated as a closed allowlist in §4.1.)

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

### 3.1 Header reading is REACTIVE-ONLY, at the error boundary

`extractHeaders(e)` (`errors.ts:213, 238`) pulls headers ONLY from a thrown SDK error, and
`parseRetryAfterMs(get, now)` reads exactly THREE keys — `retry-after-ms`, `retry-after`,
`x-ratelimit-reset` (`errors.ts:304-315`). It does NOT read any `*-remaining-*` /
`*-limit-*` header. `grep -rn "remaining\|ratelimit-requests\|ratelimit-tokens\|anthropic-ratelimit"
src` (excluding `.js`) ⇒ **0 hits** — the remaining-quota headers are never read anywhere.
On a SUCCESSFUL response, no header is consulted at all (the adapters decode the stream and
emit `usage`, `adapters/anthropic.ts:143-184`; headers are dropped).

### 3.2 B3 retry-after — the reactive precedent this RFC extends

`resolveDelayMs(e, attempt, …)` (`retry.ts:69-79`): IF the error carries `retryAfterMs`
(parsed at `fromSdkError`), the server delay wins (clamped to `MAX_SERVER_DELAY_MS = 60_000`,
`retry.ts:61`); else full-jitter exponential backoff. `RETRYABLE_KINDS` includes
`rate_limit` (`retry.ts:133-138`); `status === 429 ⇒ "rate_limit"` (`errors.ts:625`). So the
machinery to WAIT a parsed delay exists — but it only fires AFTER a 429. The `x-ratelimit-reset`
parser (`errors.ts:357-396`) already handles the three magnitude bands (epoch-ms ≥1e12,
epoch-s ≥1e9, relative-s) + HTTP-date — exactly the robustness a proactive reset parse needs.

### 3.3 Usage events flow, but carry no header data

The loop folds the terminal `usage` StreamEvent into recorder/budget
(`loop.ts:197-262, 447-473`), but `usage` is token COUNTS only (`types.ts:182-189`) — there
is no channel carrying response HEADERS to the loop. So a proactive snapshot needs a new,
thin header-capture seam on the adapter→loop path (§4.2), distinct from `usage`.

### 3.4 No snapshot store, no proactive-delay site

There is no per-route "remaining quota" state and no pre-request delay hook. The only delay
sites are the retry backoff (`retry.ts:302`) and the in-loop turn-retry — both POST-failure.
A PRE-request proactive delay is a new (gated) site.

---

## 4. 설계 (Design)

### 4.1 A pure snapshot parser (closed allowlist, reuses B3 reset discipline)

```ts
// src/llm/ratelimit-snapshot/parse.ts  — pure, imports nothing but its types
export interface RateLimitSnapshot {
  readonly requestsRemaining?: number
  readonly requestsResetMs?: number        // ms until reset (relative), via B3 reset parser
  readonly tokensRemaining?: number
  readonly tokensResetMs?: number
  readonly observedAt: number              // injected clock
}
export const parseRateLimitSnapshot = (
  get: (name: string) => string | null,   // same HeaderLookup shape as errors.ts
  now: () => number,                        // injected — NO Date.now in the slice
): RateLimitSnapshot | undefined => { … }
```

- A CLOSED allowlist of header names (both vendor spellings) — `anthropic-ratelimit-*` and
  `x-ratelimit-*-{requests,tokens}`. Unknown headers ignored.
- The `*-reset` parse REUSES B3's `parseRateLimitResetHeader` magnitude-band + HTTP-date
  logic (`errors.ts:357-396`) — same epoch-ms/epoch-s/relative disambiguation, same
  `finiteMs` non-finite guard (`errors.ts:329-330`). No new heuristic; no `Date.now()`
  (clock injected, matching B3's `now` param).
- Returns `undefined` when NO recognized header is present (most non-Anthropic/proxy
  responses) ⇒ the store keeps its last value or stays empty ⇒ no behavior.

### 4.2 Header-capture seam (adapter → snapshot, default-OFF)

The SDK exposes response headers via `client.messages.create(...).withResponse()` /
the raw response object. Add an OPTIONAL `onResponseHeaders?: (get) => void` to the adapter
config (mirroring the optional `onChunk` hook already threaded through
`adapters/anthropic.ts:171-175`): when set, the adapter calls it once with the response's
header lookup. **Absent ⇒ the adapter does not even request the response object ⇒
byte-identical** (no extra allocation, no header read). The composition root wires this hook
to `snapshotStore.update(parseRateLimitSnapshot(get, clock))` only when the knob is on. This
is a thin, success-path seam distinct from `usage` (which is token counts) and from
`fromSdkError` (which is the 429 path).

### 4.3 Snapshot store (per route, last-write-wins)

```ts
// src/llm/ratelimit-snapshot/store.ts
export interface RateLimitSnapshotStore {
  update(s: RateLimitSnapshot | undefined): void   // undefined ⇒ no-op
  current(): RateLimitSnapshot | undefined          // latest non-undefined
}
```

Keyed per logical route (provider+model) — a tiny in-memory `Map`, last-write-wins. No
clock inside (the snapshot carries `observedAt`). Pure container, DI'd into the loop.

### 4.4 Proactive-backoff policy (measured, not a guessed threshold)

The policy is deliberately CONSERVATIVE and SERVER-ANCHORED (honoring the project's
"no arbitrary heuristic / measure-first" rule — the no-sketchy-code scanner and MEMORY both
ban invented thresholds):

```ts
// pure function — inputs only, no clock read (now passed in)
export const proactiveDelayMs = (s: RateLimitSnapshot, now: number): number => {
  // Back off ONLY when the provider says we are OUT (remaining <= 0) — then wait until the
  // server-advertised reset (the SAME quantity B3 honors AFTER a 429, just consulted
  // BEFORE the request). This is not a guessed "80% of quota" threshold; it is
  // "the provider told us the bucket is empty, here is when it refills."
  const empty = (s.tokensRemaining !== undefined && s.tokensRemaining <= 0) ||
                (s.requestsRemaining !== undefined && s.requestsRemaining <= 0)
  if (!empty) return 0
  const resetMs = Math.min(s.tokensResetMs ?? Infinity, s.requestsResetMs ?? Infinity)
  if (!Number.isFinite(resetMs)) return 0
  return Math.min(Math.max(0, resetMs), MAX_SERVER_DELAY_MS)   // reuse B3's 60s clamp
}
```

- **The trigger is the provider's OWN `remaining <= 0`**, not a quanta-invented percentage —
  so it is a measured signal, exactly like B3's `retry-after`. (A Phase-2 could add an
  opt-in "soft" margin, but Phase-1 ships only the unambiguous empty-bucket case to avoid an
  arbitrary threshold.)
- The delay is clamped to the SAME `MAX_SERVER_DELAY_MS = 60_000` B3 uses (`retry.ts:61`) —
  one bounded ceiling, no second magic constant.
- Applied at a single gated pre-request site in the loop (before opening the model stream),
  composing with — not replacing — the existing post-429 backoff.

### 4.5 Notify surface

A `RateLimitSnapshot` StreamEvent variant (or a dedicated notify callback) lets the CLI
render "⚠ rate limit: N tokens left, resets in Ms" — presence/quantity only, NEVER any
secret. Forwarded WITHOUT folding into recorder/budget (transient UI signal, exactly the
`output_progress` discipline, `types.ts:190-213`). Default-OFF ⇒ never emitted.

---

## 5. 통합 (Integration)

### 5.1 Knob (default-OFF, byte-identical)

- `QUANTA_RATELIMIT_PROACTIVE` (`runtime-config.ts` beside `mcpSampling`, `:606-611`). Unset
  ⇒ the `onResponseHeaders` hook is NOT wired ⇒ the adapter never reads headers on success,
  the store is never constructed, `proactiveDelayMs` is never called, no event emitted ⇒
  **byte-identical to today** (the reactive B3 429 path is untouched either way).
- No tool, no manifest row (a transport/policy seam).

### 5.2 Feature catalog (fc)

`ratelimit-snapshot.yaml` under the LLM-resilience subsystem:
`depends_on: [b3-retry-after]`, `labels: ["resilience", "absorbed:anthropic"]`,
`status: planned`.

### 5.3 Slice / fence

- New `src/llm/ratelimit-snapshot/` slice: `parse.ts` (pure, reuses the B3 reset-band logic
  — extract `parseRateLimitResetHeader` to a shared helper imported by both `errors.ts` and
  this slice, or duplicate the small closed function with a differential parity test),
  `store.ts`, `policy.ts`. Imports only `@/shared`-level shapes — plane-clean, no `@/agent`.
- `src/llm/adapters/anthropic.ts` (+ openai-responses) — optional `onResponseHeaders` hook
  (the success-path seam, §4.2).
- The store construction, hook wiring, and the gated pre-request delay live at the
  composition root + the loop (`@/agent/loop` already owns the pre-stream point where
  `usage` is teed, `loop.ts:680-682`); the `proactiveDelayMs` call sits there behind the
  knob.

---

## 6. 테스트 계획 (Test plan)

### 6.1 Hellgate (adversarial, pure parser + policy)

- **band disambiguation (reuses B3 cases):** `*-reset` as epoch-ms (≥1e12), epoch-s (≥1e9),
  relative-s, and HTTP-date all parse to the correct relative ms; past reset ⇒ `undefined`;
  non-finite / negative ⇒ `undefined` (the `finiteMs` guard, `errors.ts:329-330`).
- **vendor-spelling allowlist:** `anthropic-ratelimit-tokens-remaining` AND
  `x-ratelimit-remaining-tokens` both parse; an unknown header is ignored; absent all ⇒
  `parseRateLimitSnapshot` returns `undefined`.
- **policy empty-bucket only:** `tokensRemaining: 0, tokensResetMs: 5000` ⇒
  `proactiveDelayMs == 5000`; `tokensRemaining: 500` (not empty) ⇒ `0` (NO guessed-margin
  backoff — Phase 1 only fires on the provider's own zero); hostile `tokensResetMs: 1e15`
  ⇒ clamped to 60_000 (the B3 ceiling).
- **store last-write-wins:** `update(A); update(undefined); current() === A` (an
  unrecognized response does NOT clobber the last good snapshot).
- **default-OFF byte-identical:** knob unset ⇒ `onResponseHeaders` not wired (assert the
  adapter constructs without a header hook); the post-429 B3 path is unchanged.
- **no-leak:** the snapshot/notify carries only numbers + reset ms — assert no header VALUE
  string (which could carry an org id) is emitted in any event/log.

### 6.2 e2e

Replay a 2-turn run where turn 1's response carries
`anthropic-ratelimit-tokens-remaining: 0, anthropic-ratelimit-tokens-reset: <+5s>`; assert
(a) the store holds the snapshot, (b) the gated pre-request site delays ~5s before turn 2,
(c) a `RateLimitSnapshot` notify is forwarded, (d) recorder/budget token counts are
UNCHANGED (the notify is not accounting). Knob-off variant ⇒ no delay, no notify.

---

## 7. 단계 (Phasing)

- **Phase 1 — snapshot + empty-bucket proactive delay (this RFC).** Pure parser, store, the
  server-anchored empty-bucket policy, the success-path header hook, the notify. Default-OFF.
  Shippable unit; no invented threshold.
- **Phase 2 — opt-in soft margin (measured).** Add a `QUANTA_RATELIMIT_SOFT_MARGIN` that
  starts spacing requests when remaining drops below an OPERATOR-SET fraction — but only
  ship this after measuring real near-limit traffic (per the no-arbitrary-heuristic rule;
  the threshold is operator-chosen, not quanta-invented).
- **Phase 3 — cross-window awareness.** Track the secondary/input-output token windows
  separately so the tightest binding window drives the delay.

---

## 8. 리스크 / 대안 (Risks / alternatives)

- **An invented threshold would be a project-rule violation (primary design constraint).**
  MEMORY + the no-sketchy-code scanner ban arbitrary thresholds/magic delays. Phase 1
  therefore triggers ONLY on the provider's own `remaining <= 0` and waits the provider's
  own reset — the same measured-signal posture as B3's `retry-after`. The soft-margin
  (guessable) case is deferred to an opt-in, operator-set Phase 2.
- **Header spelling drift / proxies.** A proxy or non-Anthropic endpoint may not send these
  headers, or send different spellings. Mitigation: closed allowlist of BOTH vendor
  spellings; `undefined` on no-match ⇒ the store stays empty ⇒ zero behavior (graceful — the
  reactive B3 429 path still protects us). Documented as "best-effort meter, not a guarantee."
- **Double-counting / wrong delay.** The proactive delay composes with (does not replace)
  the post-429 backoff; both clamp to the same 60s ceiling, so a turn can never sleep
  unboundedly. The notify is explicitly NON-accounting (UI-only, like `output_progress`),
  so token budgets are never perturbed.
- **Extra header read on the success path.** Mitigated by default-OFF + the optional hook:
  when the knob is unset the adapter does not even request the response object, so there is
  zero added work in the common case.
- **ROI is bounded.** This only helps accounts that actually run near their TPM/RPM cap —
  for everyone else the headers say "plenty remaining" and the policy returns `0`. Medium
  ROI, modest cost (a pure parser reusing B3's hardest part). Honest.
- **Alternative — derive a synthetic remaining from local token accounting.** Rejected: a
  local estimate (chars/4) is not the provider's authoritative quota and would re-introduce
  a guess. Reading the provider's own headers is the only honest signal.

---

## 9. 코드 위치 요약 (Code-location summary)

**Create:**
- `src/llm/ratelimit-snapshot/parse.ts` — `parseRateLimitSnapshot` (reuses B3 reset-band).
- `src/llm/ratelimit-snapshot/store.ts` — `RateLimitSnapshotStore`.
- `src/llm/ratelimit-snapshot/policy.ts` — `proactiveDelayMs` (empty-bucket, B3 60s clamp).
- `…/__tests__/ratelimit-snapshot.hellgate.test.ts` + replay e2e (§6).
- `tools/feature-catalog/…/ratelimit-snapshot.yaml`.

**Touch:**
- `src/shared/errors.ts:357-396` — extract `parseRateLimitResetHeader` to a shared helper
  (or keep + add a differential-parity test) so the snapshot parser and the B3 path share
  the band logic.
- `src/llm/adapters/anthropic.ts:171-184` (+ `openai-responses.ts`) — optional
  `onResponseHeaders` success-path hook.
- `src/agent/loop.ts:680-682` — gated pre-request `proactiveDelayMs` site + notify forward.
- `src/shared/runtime-config.ts:606-611` — `QUANTA_RATELIMIT_PROACTIVE` flag.
- `@/host/runtime` — construct the store, wire the header hook + notify when the knob is on.

**Read-only (referenced):**
- `src/shared/errors.ts:213, 304-315, 329-330, 625` — B3 reactive parse + `finiteMs` + 429
  classification.
- `src/agent/retry.ts:61, 69-79, 133-158` — the post-429 backoff this RFC complements.
