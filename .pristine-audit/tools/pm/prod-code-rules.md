# Prod-coding rules — silent-failure / prod-unsafe (src/-wide)

> Source: [docs/audits/jun-10-silent-failure-prod-audit.md](../../docs/audits/jun-10-silent-failure-prod-audit.md)
> (23 confirmed findings across 8 defect classes). Same discipline as
> [tools/feature-catalog/test-audit-rules.md](../feature-catalog/test-audit-rules.md):
> every rule is a **verbatim spec**, every **enforced** rule is grounded in an
> objective static signal inside a named ratchet test, and everything that needs
> judgement is marked **semantic** so the tooling's silence is never misread as
> a pass. **NO HEURISTICS** — frozen-count strict-equal or zero+named-allowlist
> only.

**THE RULE이 feature 단위 DoD라면, 이 문서는 코드 한 줄 단위의 prod-safety
바닥선이다.** 기능이든 버그픽스든 리팩토링이든, `src/`에 들어가는 모든 prod
코드에 적용된다. 새 코드가 아래 baseline을 올리면 해당 ratchet 테스트가 RED —
리뷰어의 기억력이 아니라 suite가 막는다.

---

## The rules — verbatim spec

1. **Bind AND attribute every catch.** `} catch (e) {` + a stable label through
   `@/shared` logger — level **≥ warn** for state/IPC/persistence failures;
   `debug` is reserved for *documented* best-effort probes (the allowlisted
   drain/teardown races). A catch that cannot name what failed is a swallow.
2. **Never return a success-shaped default from a failure path.** A caught
   error must surface as a typed `ok:false` / Result / rethrow — not `[]`,
   `{}`, `""`, `0`, `false`, or `failure:null` that is byte-identical to a
   real green.
3. **Persisted state writes are tmp+rename same-dir atomic, mode preserved.**
   Route through `writeFileAtomic` in `@/storage` (ADR-0398) — never a
   truncating `writeFile`/`Bun.write` of `JSON.stringify`. Shared maps are
   **merge-on-save** (fresh read of the same path first), never
   wholesale-replace from a per-process bag.
4. **Every sleep/backoff on a cancellable path takes an AbortSignal.** Use the
   abort-aware sleep in `src/agent/loop/sleep.ts` — a raw
   `new Promise((r) => setTimeout(r, ms))` on a path the user can Esc/Ctrl+C
   is a hang.
5. **Pump/stream death while the peer lives must surface exit.** A read pump
   that errors (or ends cleanly!) while the child process / connection is
   still alive must `fireExit` / `failAllPending` — never debug-and-limp into
   per-request generic timeouts while the supervisor stays "healthy".
6. **Classify errors by typed kind / statusCode, never message text.** Branch
   on `e instanceof TypedError && e.code === …` (e.g. `LspRequestError.code`),
   not `e.message.includes(…)` or `/…/.test(String(e))` — message-shape
   matching silently dies on the next upstream wording change.
7. **Every long-lived resource is registered at creation with a teardown
   call-site proven by a wiring test.** Intervals, daemons, children, watchers:
   "the registry has a `stopAll()`" is nothing until a reader-count test pins
   a real call site at the session-teardown chokepoint
   (`cleanupFinishedSession`).
8. **No sync fs on shared-daemon hot paths.** `writeFileSync` / sync GC prunes
   on the universal tool-result or event-loop path stall every session in the
   process — use async I/O (and spill/prune off the hot path).

---

## Enforcement matrix

Ratchet ids R1–R6 are the jun-10 audit's proposals; baseline constants live in
the enforcing test (that file is the SSOT — numbers drift downward as findings
burn down, and the both-direction strict-equal contract forces re-pinning).

| Rule | Status   | Signal |
| ---- | -------- | ------ |
| 1    | enforced | `tests/unit/silent-failure-growth-ratchet.test.ts` — bare `} catch {` frozen-count (form A), `.catch(() => null\|undefined)` frozen-count (form B), **R1** debug-only-catch frozen-count (catch whose first non-comment statement is `logger.debug`); plus `tests/unit/tool-no-throw-contract-guard.test.ts` (tool execute bodies: unguarded injected-port awaits flagged → errors become typed results, not escapes). warn-vs-debug *level choice* is semantic — see checklist. |
| 2    | enforced | **R3** in `tests/unit/silent-failure-growth-ratchet.test.ts` — `catch { return []\|{}\|""\|0\|false }` frozen-count (form C). The `ok:true`-reachable-without-execution variant is invisible to regex — see checklist item 4. |
| 3    | enforced | **R5** in `tests/unit/silent-failure-growth-ratchet.test.ts` — `(writeFileSync\|writeFile\|Bun.write)(…JSON.stringify` minus `atomic\|tmp` lines, frozen-count. Honest limitation: variable-payload writes (audit #1/#2/#3) evade the line regex; merge-vs-replace is semantic — see checklist items 2/3. |
| 4    | enforced | **R2** in `tests/unit/silent-failure-growth-ratchet.test.ts` — `new Promise((r) => setTimeout(` frozen-count in prod src; fix message names `src/agent/loop/sleep.ts`. |
| 5    | enforced | **R1** (above) bounds the *throwing* arm — a pump catch can no longer be debug-only without tripping the count. The *clean-end-while-alive* arm has NO catch to scan — per-transport hellgates required, see checklist item 6. |
| 6    | enforced | `tests/unit/src-no-sketchy-code.test.ts` — existing `e.message.includes(` ban + **R4** `String(e)` text-classification ban (`.test(String(e))` / `String(e).includes\|match(`), zero-tolerance. *Which* typed kind a boundary maps to is semantic — see checklist item 1. |
| 7    | enforced | **R6** — `tests/unit/side-agent-stopall-wiring-guard.test.ts`: reader-count wiring proof (`.stopAll(` has ≥1 prod call site, anchored at `src/agent/loop/session-lifecycle.ts` `cleanupFinishedSession`) + `tests/unit/side-agent-stopall-session-end-hellgate.test.ts` for the behavior. New long-lived resources need the same wiring-proof shape (house "zero unwired" precedent). |
| 8    | semantic | (human review — no scanner distinguishes a hot path from a cold one; flag any sync fs / sync GC reachable from the shared-daemon tool-result or event pump paths.) `tests/unit/terminal-defaults-ratchet.test.ts` covers the adjacent prod-unsafe class (`process.exit` / raw stdio outside app composition roots, zero+allowlist). |

Not yet ratcheted (audit-documented, deliberate): statement-position `void`
floating promises (parked on biome `nursery/noFloatingPromises` — crashes biome
2.4.15 on this repo, re-evaluate at next upgrade); `JSON.parse as <T>` (fix is
reusing the S19 zod validator in `src/session/store.ts`, then reconsider);
`Date.now()` ID-minting (0 confirmed findings).

---

## Non-mechanizable classes — semantic (review) checklist

리뷰에서만 잡힌다. 아래는 도구가 침묵해도 통과가 아니라는 뜻의 명시적 체크리스트
(test-audit-rules.md의 R4/R6/R7/R11/R12와 같은 지위).

| Item | Status | Check |
| ---- | ------ | ----- |
| 1. Error-kind routing at auth/token boundaries | semantic (review) | (human review — any catch that assigns an LLMError/OAuth `kind` must branch on a typed statusCode; `invalid_grant`/401 is the ONLY re-auth trigger. A transient 429/5xx/network blip at a refresh boundary is NOT `kind:"auth"`. No syntax distinguishes the right catch from the wrong one — even cause-preserving wraps were among the confirmed findings.) |
| 2. Replace-vs-merge on persisted maps | semantic (review) | (human review — any `write*Config`/save whose input does NOT start from a fresh read of the same path needs an explicit ownership justification; "writeConfig(currentBag)" silently wipes other sessions' keys while printing "saved".) |
| 3. Lock-coverage gaps | semantic (review) | (human review — which writes must be lock-gated is a per-subsystem invariant; reuse the file-lock in `src/agent/session-resource-registry/disk-adapter/file-lock.ts` and enforce with targeted hellgates that inject the concurrent append at the RIGHT point — after the tail re-read — not with pattern scans.) |
| 4. ok-semantics false-greens | semantic (review) | (human review — every tool result with `ok:true` must be reachable ONLY from a path where the underlying action actually executed; `ok: pkt.failure === null` is syntactically innocent and wrong — "nothing ran" ≠ green.) |
| 5. Unserialized fire-and-forget RMW | semantic (review) | (human review — a `void f()` whole-state read-modify-write needs an epoch token or serialization; the *race* is judgment-only even though the `void` itself is counted.) |
| 6. Pump "clean-end-while-alive" | semantic (review) | (human review + per-transport hellgates — for EVERY transport pump (stdio, http-sse, lsp, plugin-spawner): inject a stream that ends early while the process/connection lives, assert pending requests reject PROMPTLY via fireExit/failAllPending, not via timeout. No catch-pattern ratchet can ever see this path.) |

---

## When you trip a ratchet

- **count > baseline** → you added a new instance of a banned form. Fix the new
  site using the rule's named alternative (the test's error message points at
  it); do NOT bump the constant.
- **count < baseline** → you burned debt down. Tighten the baseline constant in
  the SAME change — the ratchet must move forward.
- A genuinely deliberate best-effort degrade is fine — it just has to say so
  through the logger with a stable label (which moves it out of every counted
  form).
