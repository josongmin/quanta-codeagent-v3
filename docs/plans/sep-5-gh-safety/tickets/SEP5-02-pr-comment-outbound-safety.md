# SEP5-02 — PR comment outbound safety contracts

**Priority:** P1
**Status:** LANDED — exact clean CI green
**Depends on:** SEP5-01, SEP5-03
**Finding coverage:** D4

## Goal

All PR comment bodies cross one mandatory redaction and byte-cap boundary.
Retryable automation additionally uses idempotency and concurrent-post
reconciliation. Explicit HITL one-off comments retain create-new semantics.

## Contract split

```ts
export interface OutboundBodyPolicyPort {
  prepare(body: string): { readonly ok: true; readonly body: string }
    | { readonly ok: false; readonly error: string }
}

export interface AutomatedPrCommentPort {
  post(input: {
    readonly body: string
    readonly key: IdempotencyKey
  }): Promise<OutputPostResult>
}
```

`PrOutputSink` remains the automation authority. `gh_pr_comment` must use the
body policy but must not silently acquire the sink's update-existing semantics.

## Write set

| File | Change |
|---|---|
| `src/integrations/github/pr-output-sink.ts` | Extract/reuse body preparation without weakening existing reconcile logic |
| `src/integrations/github/types.ts` | Define the minimal injected body/automation port if no suitable port exists |
| `src/tool/gh/index.ts` | Require a body policy for `ghPrCommentTool`; remove raw `input.body` from argv |
| `src/apps/agent/mode-presets/ci-bot.ts` | Inject/use automated sink for summary posting |
| `src/apps/agent/types.ts` or existing seams file | Carry the sink/body policy through composition without concrete up-imports in libraries |
| `tests/unit/integrations/github/pr-output-sink-redaction-hellgate.test.ts` | Extend common body corpus |
| `tests/unit/tool/gh-pr-comment-outbound-policy.test.ts` | New HITL create-new/redaction battery |
| `tests/unit/apps/agent/ci-bot-pr-comment-safety.test.ts` | New automation retry/concurrency battery |

## Required logic

1. Redact before truncation so truncation cannot split a secret while leaving a
   visible suffix.
2. Compute the final UTF-8 byte cap including the hidden marker for automation.
3. Never place unredacted body text in progress, warning, or failure output.
4. ci-bot derives a stable idempotency key from repository, PR, run identity,
   and logical output kind. It must not use wall-clock time or random UUID.
5. `gh_pr_comment` calls `gh pr comment` after policy preparation and continues
   to require HITL on every surface. Two approved executions may create two
   comments.
6. A policy failure returns `ok:false` and makes zero external calls.

## RED rails

- Fabricated PAT/JWT/URL-userinfo in ci-bot assistant output reaches captured
  `gh` argv unredacted.
- The same automation key posted concurrently leaves more than one comment.
- A 65,000-byte body drops or truncates the idempotency marker.
- A throwing redactor still calls GitHub.
- Two explicit one-off invocations are incorrectly reconciled into one comment.

## Test and ratchet implementation

- Build both new tests on a captured fake `GhCliPort`, following
  `pr-output-sink-reconcile-hellgate-r4.test.ts`. Assert on argv/body bytes and
  call count; make zero real GitHub requests.
- Feed the shared secret corpus through one HITL `gh_pr_comment` path and one
  ci-bot automation path. The corpus floor is at least 17 and every raw fixture
  must be absent from captured argv, return values, warnings, and thrown errors.
- For automation, start two posts behind a deterministic barrier with the same
  repository/PR/run/output-kind key. Release together and require one durable
  marker/comment. Repeat with different output kinds and require two comments.
- Boundary rows cover final encoded sizes at cap-1, cap, and cap+1, including
  multibyte UTF-8 and the hidden marker. Assert marker preservation and byte
  count, not JavaScript string length.
- Mutation A passes `input.body` directly to argv; the named fixture row must
  leak and fail. Mutation B omits run identity from the stable key; two distinct
  runs must collide and fail. Mutation C makes `prepare` throw/return failure;
  captured GitHub calls must remain zero.
- Anti-vacuum floors are one HITL consumer, one automation consumer, two
  concurrency participants, and the shared corpus minimum. Explicit HITL calls
  are separately asserted to remain create-new twice.

## Proof rails

```sh
bun test tests/unit/integrations/github/pr-output-sink*.test.ts
bun test tests/unit/tool/gh-pr-comment-outbound-policy.test.ts
bun test tests/unit/apps/agent/ci-bot-pr-comment-safety.test.ts
bun test tests/integration/github-webhook-dispatch-e2e.test.ts
bun run typecheck
bun run lint:debt
```

## Definition of done

- No automated PR body bypasses redaction, cap, or idempotency.
- No HITL comment bypasses redaction or cap.
- Automated and user-driven retry semantics remain observably distinct.
- External calls and logs contain no raw fixture secret.

## Stop conditions

- The proposed API forces idempotency on explicit user-authored comments.
- The sink requires `@/tool` or another lower slice to import an app surface.
- A body can be externally sent when policy construction is missing.

## Closeout update — 2026-09-06

The remaining cap ambiguity is removed from both outbound policy projections:

- `src/integrations/github/outbound-body-policy.ts` owns a byte-safe UTF-8
  prefix operation and reserves marker bytes before truncation;
- `src/tool/gh/outbound-body-policy.ts` enforces the same strict final-byte cap
  for explicit HITL comments;
- an oversized required marker is a typed policy failure, never an over-cap
  body or a markerless success;
- no `cap + 5` tolerance remains.

The precise rails cover cap-1, cap, cap+1, multibyte boundaries, marker
preservation, and zero external calls on policy failure in
`tests/unit/integrations/github/pr-output-sink-loop-hellgate-r2.test.ts` and
`tests/unit/tool/gh-pr-comment-outbound-policy.test.ts`. Assertions use encoded
UTF-8 bytes rather than JavaScript character counts. The shared truncation
helper is exercised through both production consumers, so a copied test helper
cannot make the rail green.

**Current receipt:** the focused PR policy tests and the combined 23-file SEP5
bundle passed (`273 pass, 0 fail`). Exact clean closeout
`9139626f93763ce3b52f2b05a2224e30ebde0dd6` completed the 37/37 full suite and
all 21 `test:ci` gates. The implementation is delivered on `main`.
