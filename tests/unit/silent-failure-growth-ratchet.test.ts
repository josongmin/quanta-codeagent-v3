/**
 * Silent-failure growth ratchet — repo-wide freeze on error-swallowing forms.
 *
 * Swallow forms are counted across `src/` (prod-only) and pinned to a
 * one-directional `<=` CEILING (the jun-10 reliability audit's "no NEW silent
 * failure" rule; D14 swapped the original strict-equal floor for a ceiling —
 * see the contract + D14 note below). This complements — does not replace — the
 * existing guards:
 *
 *   - `src-no-sketchy-code.test.ts` bans EMPTY `catch {}` bodies outright
 *     (curated allowlist). It does NOT see a bare catch with a non-empty
 *     body that still never looks at the error.
 *   - `silent-catch-24h-ratchet.test.ts` pins bare-catch counts in 5
 *     specific audited files. The other ~hundreds of src files had NO
 *     growth bound until this ratchet.
 *   - `terminal-defaults-ratchet.test.ts` already bans `process.exit` /
 *     stdio ownership outside app composition roots.
 *
 * Counted forms:
 *
 *   A. Bare `} catch {` — the error is never BOUND, so it cannot be logged,
 *      attributed, or rethrown. New code must bind and attribute:
 *      `} catch (e) { logger.warn(`<label>: ${errMessage(e)}`) }` (or rethrow
 *      / return a typed Result). Deliberate best-effort degrades are fine —
 *      they just have to say so through the logger with a stable label.
 *
 *   B. `.catch(() => null)` / `.catch(() => undefined)` — a promise
 *      rejection collapsed to a nullish value with zero attribution. New
 *      code should `.catch((e) => { logger.debug(`<label>: ${errMessage(e)}`); return null })`
 *      so the swallow is visible in telemetry.
 *
 *   C. `catch { return [] | {} | "" | 0 | false }` — fail-open masking: the
 *      caller cannot distinguish "probe failed" from "genuinely empty"
 *      (jun-10 silent-failure audit R3, finding #12).
 *
 *   D. Debug-only catch — `catch (e) {` whose FIRST non-comment statement is
 *      `logger.debug(` (jun-10 audit R1, findings #4/8/9/10/11: silent pump
 *      death surfaced only at debug verbosity). The promise twin
 *      (`.catch((e) => logger.debug(...))`) is zero-tolerance + pinned
 *      allowlist. By construction the form misses debug-then-rethrow blocks
 *      (those are fine) and catches where debug isn't first — acceptable
 *      narrowness, matches house norm.
 *
 *   E. Non-abortable sleep — `new Promise((r) => setTimeout(r, ms))` strands
 *      cancellation: an aborted turn keeps waiting the full delay (jun-10
 *      audit R2, findings #6/#22). New code must use the abort-aware sleep
 *      in src/agent/loop/sleep.ts.
 *
 *   F. `JSON.stringify` through a truncating write — `writeFileSync(p,
 *      JSON.stringify(v))` (and writeFile/Bun.write) torn by a crash leaves
 *      corrupt persisted state (jun-10 audit R5, findings #1/2/3/17/19).
 *      Route through `writeFileAtomic` in `@/storage` (ADR-0398). HONEST
 *      LIMITATION: this line-level form only sees an INLINE stringify — a
 *      `writeFileSync(p, json)` with the payload in a variable is invisible
 *      here and needs the per-site fixes + hellgates.
 *
 * ALL forms (A–F) follow the audit's "prod" definition: `src/` excluding
 * `__tests__/` dirs and `*.test.ts` (in-src test/hellgate files author the
 * banned shapes on purpose, so an all-files count churned the baseline on every
 * test edit — a false REGRESSION signal). Forms A/B were re-scoped to `countProd`
 * for the same reason (see the `BARE_CATCH_BASELINE` note + the
 * `forms A/B are prod-scoped` self-consistency guard below). The `countAll`
 * helper still exists, but only the `@ts-expect-error` arm (which legitimately wants
 * the whole tree) uses it.
 *
 * Ratchet contract (house pattern, ONE-directional ceiling — D14):
 *   - count > baseline → REGRESSION, fix the new swallow.
 *   - count <= baseline → PASS. A drop is fine; a non-failing advisory logs
 *     "you can tighten the baseline to N" so the floor can move forward
 *     voluntarily, WITHOUT a red test forcing a reflexive bump (the strict-equal
 *     form did force one, re-admitting growth headroom — META-LESSON #6).
 *
 * KNOWN LIMITATION — net-neutral substitution (rounds-2/3 audit). The
 * high-volume forms (A bare-catch, B nullish) are AGGREGATE counts with no
 * per-site identity, so a single commit that REMOVES n swallows and ADDS ≤n new
 * ones nets at-or-below the ceiling and slips past. Per-file identity (the shape
 * the low-count zero-tolerance forms — `@ts-expect-error`, the debug-only-promise
 * allowlist — use) is economically infeasible at the ~1000-site volume of forms
 * A/B (the allowlist would be larger than the code it guards and churn every
 * edit). So substitution within the ceiling is caught by CODE REVIEW + the diff,
 * NOT this ratchet — the ratchet's job is bounding net GROWTH. The zero-headroom
 * pin (baseline == live count) makes any pure +1 red immediately, which closes
 * the common case; only a concurrent genuine removal opens the window.
 *
 * NOTE on biome: `nursery/noFloatingPromises` / `noMisusedPromises` would
 * cover the unawaited-promise corner of this class, but both rules crash
 * biome 2.4.15's type-inference worker (stack overflow) on this repo —
 * re-evaluate on the next biome upgrade. Until then this ratchet + the
 * sketchy-code scanner are the enforcement surface.
 *
 * Pure regex over file contents; src/ only (tests exercise violations on
 * purpose). Read-only, deterministic across platforms.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { extname, join, relative, sep } from "node:path"
import { logger } from "@/shared"

const SRC = join(__dirname, "..", "..", "src")

/**
 * Ceiling baselines (one-directional `<=`, see the D14 note below), PROD-only
 * (excludes `*.test.ts` + `__tests__/` — see `isProdFile`), re-pinned
 * 2026-06-10 on the post-fix tree.
 *
 * Why prod-only (changed from the original all-files scan): in-src hellgate
 * tests legitimately author `} catch {` / `.catch(() => null)` to exercise the
 * very failures these forms guard against, so an all-files count churned this
 * baseline on every test edit — a false REGRESSION signal that trains people to
 * bump the number reflexively (defeating the ratchet). Scoping to prod matches
 * forms C–F below and the audit's actual target: PROD silent failures. The
 * jun-10 fix sprint's net prod delta here is the gc.ts atomic/lock rewrite's
 * documented NO-THROW best-effort read helpers (`readFileSafe`/`fileSizeSafe`/…
 * — return a safe default for a missing/unreadable file, never mask a core
 * write); the core `writeAtomicTruncateSafe` surfaces failure as a `false`
 * return, not a swallow.
 */
// D14 (jun-10 audit, META-LESSON #6): these baselines are a one-directional
// CEILING enforced with `<=`, NOT strict-equal. A strict-equal floor was
// self-defeating — any lane that REMOVED a swallow dropped the count below the
// pinned number and reded the ratchet, training people to reflexively bump the
// constant (which then re-admitted the growth headroom the ratchet was meant to
// deny). Under `<=`: growth past the ceiling fails; a drop passes (and a
// non-failing advisory logs "you can tighten to N"). Each constant is set to
// the CURRENT resting prod count (measured 2026-06-10 on this tree, incl. the
// concurrent in-flight feature work: codemode/runtime.ts,
// session-resource-registry adapters, the mid-turn-approval slice — NO-THROW
// best-effort registry helpers, not new dangerous swallows) so it is green now
// and won't break when other lanes reduce counts.
// Re-measured 2026-06-15 after merge resolution (activity-spine + bench preset
// unification + quanta-home SSOT): new slices contribute bare catches / nullish
// swallows / non-abortable sleep; ceilings raised to lock in the new floor.
// Re-measured 2026-06-25 (ADR-0296 bash auto-background): +2 bare catches, both
// justified: `runtime/bash-bg-registry.ts` reader-error catch (DOCUMENTED swallow
// — the error is already surfaced into the shared stdout/stderr buffer), and
// `runtime/shell.ts` `askConsent` `} catch { return false }` (FAIL-CLOSED safe
// default — a thrown consent prompt DENIES background adoption). Ceiling 1101 →
// 1103. (The shell.ts site also bumps CATCH_RETURN_EMPTY 109 → 110 below.)
// Re-measured 2026-07-07 (jul-6/7 observation-kernel S1-S4 + concurrent session-
// resource / bench work): +51 bare catches, AUDITED all DELIBERATE no-throw, none
// a new dangerous swallow. Sampled the top contributors: session-resource-registry
// (disk/sqlite adapters, run-ledger, approval-state store) — best-effort persistence
// / port-no-throw contracts that degrade to a documented safe default (null / false /
// 0 / fallback-entry); codemode/runtime.ts — VM & handle teardown races
// (`/* already torn down — nothing to release */`); tool/evidence/runtime.ts — probe
// fallbacks; observation lsp-refuter/lsp-enrich — audit-blessed graceful-degradation
// (their file header pins "NEVER throws … graceful skip", "Pure … no env reads", so
// attribution would VIOLATE the design, not improve it). Every site returns a safe
// default; none strand caller-needed work. Moving target while observation+bench work
// is mid-commit; red-on-injection teeth still trip on the NEXT unjustified swallow.
// Ceiling 1103 → 1154.
// Re-measured 2026-08-04 (aug-02 absorption RFC-01~09): +1 bare catch, AUDITED
// legit fail-closed default — `runner/hunk-mutation-journal.ts` undo reads the
// target file and, if it is UNREADABLE since apply, returns `{status:"stale"}`
// (refuses the revert — a SAFE default, never a stranded work path), same class
// as the shell.ts askConsent `} catch { return false }` precedent above. (The
// store.ts rollback-preserve read is ATTRIBUTED via logger.warn, not counted.)
// Ceiling 1154 → 1155.
// Re-measured 2026-08-10 (aug-02 canvas/rewind landings): 3 NEW bare catches
// appeared; 2 were FIXED (bound + `logger.warn` attribution) — `persist-turn.ts`
// message-id assignment and `review-diff-canvas.ts` sink.capture, both moved out
// of this bucket. The remaining +1 is a JUSTIFIED best-effort probe:
// `tool/git/review-diff.ts::tryParseOne` — a `JSON.parse` throw on non-JSON
// reviewer output IS the answer (`tryParseReport` deliberately tries multiple
// candidates expecting most to fail); `null` is normal control flow, not a
// swallowed error. +1 justified site only — NO blanket bump. Ceiling 1155 → 1156.
// 2026-08-22 — the ceiling was BREACHED (live prod 1163 > 1156). Classified, NOT
// papered over: the growth is +8 in `src/apps/bench/**` and -1 in `runner/batch/`.
// Ceiling HELD at 1156 and SEVEN swallows were bound + attributed instead (each
// keeps its control flow byte-for-byte; only a `logger.warn` was added):
//   - runner/batch/report-envelope.ts `mirrorReportToSsot` - NEW site (commit
//     8cdf4badb). A silently-failing canonical mirror makes the SSOT results dir
//     look like the run never happened => `report-envelope.mirrorReportToSsot`.
//   - agent/loop-activation-hook.ts x2 - the per-turn activation hot path. The
//     `activatePlugins` catch bumped `codex_r2.activation.errors` but dropped the
//     error itself (a counter says THAT, never WHAT), and the outer
//     `reconcileSkillMcpDeps` guard made a skipped reconcile indistinguishable
//     from "nothing to do" => `loop-activation-hook.{activatePlugins,
//     reconcileSkillMcpDeps}`.
//   - tool/output-spill.ts x4 - spill-dir retention. Both prune surfaces only run
//     AFTER a successful spill write into that same dir, so a `readdir` failure is
//     a real fs fault (never the benign "nothing spilled yet"), and a `remove`
//     failure defeats the retention bound this function exists to enforce - both
//     previously grew the dir unbounded in silence =>
//     `output-spill.pruneSpillDir{,Async}.{readdir,remove}`. (The 2 readdir sites
//     were also `catch { return [] }`, so CATCH_RETURN_EMPTY drops 110 -> 108.)
// TIGHTENED 2026-08-22 (1156 -> 1147), same classify-not-paper pass, at the
// SOURCE this time. The +8 that ate the entire ceiling headroom above was grown
// by `src/apps/bench/**` after the 8c58ef0fe pin (13 new bare catches in new
// bench files, -5 removed elsewhere in bench). Repaying it in the slice that
// borrowed it: NINE of those 13 were bound + attributed (control flow byte-for-
// byte identical at every site — only a `logger.warn`, or the already-returned
// refusal message, gained the error):
//   - profiles/corpus-read.ts `readFamilyCorpusFile` - a `readFileSync` fault
//     collapsed to `undefined`; `readFamilyDatasetInstanceIds` then degrades that
//     to `[]`, so "dataset absent" and "dataset unreadable" were the same event
//     => `corpus-read.readFamilyCorpusFile`.
//   - profiles/jsonl-corpus.ts + promax/corpus/public-reader.ts (rowsFromJsonl) -
//     a malformed JSONL line is DROPPED by documented design, but a dropped line
//     is a dropped INSTANCE: a hand-edited chunk file quietly ran fewer tasks with
//     no trace. The skip stays; it is now attributed.
//   - promax/corpus/public-reader.ts `readProMaxCorpusRows` - text that OPENS with
//     `[` is declaring the bare-array form, so a parse fault there is a CORRUPT
//     corpus, not a format mismatch; `catch { return [] }` made it indistinguishable
//     from an empty one. (Also drops CATCH_RETURN_EMPTY.)
//   - promax/campaign/rails.ts `collectTestFiles` - a `statSync` fault silently
//     SHRINKS `resolvedTestFiles`, i.e. the empty-selection trap that module exists
//     to close, re-entered through the error path.
//   - terminal/harbor-results.ts `isDirectory` - gates the whole results scan
//     (`scanHarborJobDir` -> `[]`), so an unreadable job dir read as "this run
//     produced no trials". (Also drops CATCH_RETURN_EMPTY.)
//   - commands/terminal.ts `defaultCanWriteDir` - a DOCTOR probe: `accessSync`
//     throws for ELOOP/EIO/a lost race as well as EACCES, and all of them were
//     reported as "not writable". (Also drops CATCH_RETURN_EMPTY.)
//   - harness/promax/campaign-freeze.ts + remote/box-session/official-grade-
//     transport.ts - both already REFUSED loudly but neither refusal carried the
//     parse fault or the offending bytes; the error is now folded into the message
//     that was already being returned (no logger added).
// The remaining 4 new bench sites are JUSTIFIED, traced to their callers, and
// deliberately left bare: harness/promax/image-preflight.ts `parseInspect` and
// terminal/doctor.ts `checkAgentImport` both surface an `inspect_unparseable` /
// "produced no JSON" refusal that ALREADY embeds the offending stdout, so the
// parse message adds nothing the raw bytes do not; promax/corpus/layout.ts
// `resolveExisting` uses the `realpathSync` throw as the walk-up loop's own
// control flow (a missing leaf is the normal case, per its jsdoc); and
// public-reader.ts's second `JSON.parse` is the documented object-vs-JSONL format
// DISCRIMINATOR, where failing over to the line reader is the success path.
// 2026-08-23 (RFC-06 F1 disabled-store lock): the lock's 4 new bare catches
// briefly took this to 1151. They were fixed AT SOURCE in `5155a7959` (bound +
// attributed through the error each catch already had a channel for), so the
// ceiling returns to its pre-lock value rather than keeping the slack. Do not
// re-raise it for that file: the precedent is that a leaf slice with no logger
// still has to bind, because `@/skill` can fold the reason into the error it
// already throws.
const BARE_CATCH_BASELINE = 1147
// Re-measured 2026-06-25 (repo-cache GC + committed in-flight bench work): the
// `reapStaleMirrorTemps` `stat(p).catch(() => null)` not-found PROBE (handled via
// `if (st !== null …)`, a vanished orphan tmp is simply skipped) plus one further
// committed probe brought the live src/ floor to 145. All are handled-null probes,
// not swallowed work paths. Ceiling 143 → 145. (Moving target while bench work is
// mid-commit; red-on-injection teeth still trip on the NEXT unjustified swallow.)
// Re-measured 2026-07-07 (jul-6/7 observation kernel + lsp/bench work): +20, AUDITED
// all handled-null PROBES, not swallowed work: observation lsp-refuter/lsp-enrich
// (open/documentSymbol/hover/stop `.catch(() => null)` — audit-blessed graceful skip,
// the provider header pins "NEVER throws … degrade to no-enrichment"); lsp/adapters/
// base.ts + agent/lsp-bridge/nav.ts (LSP call probes → null when the server is
// absent); runner/batch/eval/repo-regression-discovery-adapter.ts (regression-probe
// misses); apps/cli/attach + apps/bench/remote/single-box-guard (best-effort). Each
// null is consumed as "signal absent", never a stranded work path. Ceiling 145 → 165.
// Re-measured 2026-08-04 (aug-02 absorption RFC-06 worktree hardening): +6, AUDITED
// all handled-undefined PROBES, not swallowed work: `runtime/worktree-fork.ts` +
// `worktree-inspect.ts` — `realpath(path).catch(() => undefined)` (canonicalize a
// path that may not exist → treated as unresolvable) and `runShell("git status
// --porcelain").catch(() => undefined)` (git-status probe → undefined ⇒ fail-CLOSED
// "treat as dirty", never a stranded path). Each undefined is consumed as "signal
// absent". Ceiling 165 → 171.
// Re-measured 2026-08-29 (live prod 172 > 171 — the ceiling was BREACHED). Both
// sites added since the last reconciliation were AUDITED, not bumped past:
//   - agent/loop/skill-gate.ts `resolveActiveModelId` — routing an unroutable
//     skill override while answering a COMPACTION-THRESHOLD question. The whole
//     point of the call site is that a threshold question must never kill a
//     turn, and the undefined is consumed one line down (`snapshot?.port ??
//     config.llm`), so the degrade to the base model is the documented answer,
//     not a dropped work path.
//   - agent/sticky-model/session-scoped-store.ts `serialized` — the swallow is
//     on the CHAIN TAIL only. The caller still awaits `run`, which rejects
//     normally; without the tail catch a single rejection becomes an unhandled
//     rejection AND wedges every later `/model` in the session. Swallowing the
//     tail is what keeps the failure visible on the branch that has a caller.
// Ceiling 171 → 172.
const NULLISH_PROMISE_SWALLOW_BASELINE = 172

/**
 * Forms C–F: ceiling baselines (one-directional `<=`) re-measured 2026-06-10 on
 * the POST-fix tree (the audit's pre-fix numbers were R3=94 / R1=11 / R2=5 /
 * R5=13; the 14 fix lanes moved several sites before these constants were
 * pinned).
 */
// Re-measured 2026-06-25 (ADR-0296 bash auto-background): +1 for
// `runtime/shell.ts` `askConsent` `catch { return false }` — a FAIL-CLOSED safe
// default (a thrown consent prompt DENIES background adoption), not a swallowed
// work path. Ceiling 109 → 110.
// Re-measured 2026-07-07 (jul-6/7 session-resource / bench work): +1 fail-open,
// AUDITED — a session-resource-registry disk-adapter probe returns `[]` on a
// vanished/racing entry (best-effort hygiene, the port contract forbids throwing);
// the caller treats `[]` as "nothing to reclaim", never as "genuinely complete".
// Ceiling 110 → 111.
// TIGHTENED 2026-08-22 (111 -> 108): the two `pruneSpillDir{,Async}` `catch {
// return [] }` readdir masks in tool/output-spill.ts were migrated to bound +
// `logger.warn` (see the BARE_CATCH_BASELINE note above), and the 1 unit of
// pre-existing slack (HEAD measured 110 under a 111 ceiling) is retired at the
// same time. Pinned to the live prod count so the improvement cannot erode.
// TIGHTENED 2026-08-22 (108 -> 105): three of the bench bare-catch repairs above
// (public-reader `readProMaxCorpusRows`, harbor-results `isDirectory`,
// commands/terminal `defaultCanWriteDir`) were ALSO `catch { return []|false }`
// fail-open masks, so binding them retires 3 units here too. Pinned to the live
// prod count so the improvement cannot erode.
const CATCH_RETURN_EMPTY_BASELINE = 105
// Re-measured 2026-06-17 (RFC jun-17 LSP warm backend): +1 for
// `startBackgroundLspPrewarm` in agent/lsp-bridge.ts — a fire-and-forget
// session-start prewarm whose failure is a documented best-effort skip (the
// first real LSP call simply warms cold), never a stranded-work path, so a
// `logger.debug` swallow is correct and the catch must not propagate (it is
// invoked via `void`). Ceiling 8 → 9.
// Re-measured 2026-08-08 (classify-not-paper): +4, all from the 2026-08-01
// 8-bucket quality refactor (commit 8a60faa1a), NONE a pump/transport/exit path
// (the Form-D danger class). AUDITED all 4 as DOCUMENTED fail-open bench-eval
// probes whose module header pins the safe fallback, so `.debug` is the correct
// attribution (upgrading to `.warn`+propagate would be WRONG — the failure is a
// valid path, not stranded work):
//   • runner/batch/eval/llm-candidate-select.ts ×2 — `chooseBestCandidate` /
//     `reviewBestCandidate` ask/parse failure ⇒ "FAILS OPEN to the caller's
//     deterministic winner" (module INVARIANT, header lines 16-19); the LLM only
//     re-ranks an already-admissible set, so a probe miss keeps the deterministic
//     pick, never resurrects/strands a candidate.
//   • runner/batch/eval/selection-smoke.ts ×2 — issue-MWE smoke write/exec
//     failure ⇒ `null` ("setup/exec failures stay fail-open", header line 66-67);
//     `null` is consumed as "no smoke signal", never as a real negative.
// These 4 predate the aug-02 RFC work (the RFC packets added ZERO debug-only
// sites — verified by per-file base→live diff). Ceiling 9 → 13.
const DEBUG_ONLY_CATCH_BASELINE = 13
// D13: re-measured after widening NON_ABORTABLE_SLEEP_RE to tolerate the typed
// `new Promise<void>(…)` form — the prod count is 12 (was 6 under the
// generic-blind regex; the extra 6 were always there, just invisible).
// Re-measured 2026-06-14: lsp-bridge.ts LSP availability timeout uses the same
// Promise+setTimeout form (already in committed HEAD); ceiling raised to 13.
// Re-measured 2026-06-15: quanta-home SSOT + bench-preset merge adds 2 new
// non-abortable sleeps; ceiling raised to 15.
// 2026-08-23 (RFC-06 F1 disabled-store lock): the lock's contended-retry sleep
// briefly took this to 17. Fixed at source in `5155a7959` — the retry now uses
// a timer-clearing sleep instead of a raw `new Promise((r) => setTimeout(…))`,
// so the ceiling returns to 16 rather than keeping the slack.
const NON_ABORTABLE_SLEEP_BASELINE = 16
// Re-measured 2026-07-07 (jul-6/7 observation + bench diagnostics): +4 truncating
// writes, AUDITED — all DIAGNOSTIC / bench-artifact dumps, NOT durable load-bearing
// state: closure-diagnostics-io + patch-static-sanity + repro-artifacts-sink (bench
// eval diagnostics) and apps/bench/trajectory + apps/terminal/brain-mode reports. A
// crash mid-dump loses a re-runnable diagnostic, never corrupts persisted app state
// (durable state — auth token-store, node-repl state — already writes temp+rename).
// Standing rule for the NEXT one: route any LOAD-BEARING persisted JSON through
// `writeFileAtomic` (@/storage, ADR-0398); diagnostics may stay direct. Ceiling 9 → 13.
// Re-measured 2026-08-23 (RFC-06 F1 disabled-store lock): +1, and this one is
// STRUCTURALLY exempt rather than merely diagnostic. The write is the lock's
// `{pid, acquiredAt}` body, written through the handle returned by
// `open(lockPath,"wx")`. The remedy — `writeFileAtomic` (temp file + rename) —
// cannot be applied here by construction: a rename would REPLACE the
// exclusively-created inode and destroy the mutual-exclusion contract the
// O_EXCL create exists to establish. It also clears the standing rule's bar
// anyway (diagnostics may stay direct): no production reader parses the body —
// staleness is decided from the file's MTIME — so a crash mid-write loses a
// diagnostic, never persisted state. The sibling agent file-lock writes the
// identical payload for the identical reason (disk-adapter/file-lock.ts:281),
// via a variable, which is this form's documented blind spot. Ceiling 13 -> 14.
const STRINGIFY_TRUNCATING_WRITE_BASELINE = 14

// Same canonical form as silent-catch-24h-ratchet: no binding, swallowed.
// A bound `} catch (e) {` deliberately does NOT match.
const BARE_CATCH_RE = /\}\s*catch\s*\{/g

// Rejection collapsed to a nullish literal with no error binding.
const NULLISH_SWALLOW_RE = /\.catch\(\s*\(\)\s*=>\s*(?:null|undefined)\s*\)/g

// Form C — catch (bare) whose body is exactly `return <empty literal>`.
const CATCH_RETURN_EMPTY_RE = /catch \{\n\s*return (?:\[\]|\{\}|""|0|false)\n\s*\}/g

// Form D — bound catch whose first non-comment statement is logger.debug(.
const DEBUG_ONLY_CATCH_RE = /catch \(\w+\) \{\n(?:\s*\/\/[^\n]*\n)*\s*logger\.debug\(/g

// Form D promise twin — rejection handler that goes straight to logger.debug(.
const DEBUG_ONLY_PROMISE_RE = /\.catch\(\s*\(?\w*\)?\s*=>\s*\{?\s*logger\.debug\(/g

// Form E — raw timer sleep with no AbortSignal hook. The optional `<…>` after
// `new Promise` tolerates the typed-Promise form `new Promise<void>((r) =>
// setTimeout(…))` (D13: jun-10 audit R4 found the un-generic regex blind to it).
const NON_ABORTABLE_SLEEP_RE =
  /new Promise(?:<[^>]*>)?\(\s*\(?(?:r|res|resolve)\w*\)?\s*=>\s*setTimeout\(/g

// Form F — line-level: a write call with an INLINE JSON.stringify payload…
const STRINGIFY_WRITE_LINE_RE = /(?:writeFileSync|writeFile|Bun\.write)\([^\n]*JSON\.stringify/
// …unless the line itself is already on the atomic/temp-file path.
const STRINGIFY_WRITE_EXCLUDE_RE = /atomic|tmp/

const walk = (dir: string, out: string[]): string[] => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (extname(p) === ".ts" && !p.endsWith(".d.ts")) out.push(p)
  }
  return out
}

const isProdFile = (p: string): boolean =>
  !p.endsWith(".test.ts") && !p.includes(`${sep}__tests__${sep}`)

const countIn = (
  files: readonly string[],
  re: RegExp,
): { total: number; perFile: Map<string, number> } => {
  const perFile = new Map<string, number>()
  let total = 0
  for (const file of files) {
    const n = [...readFileSync(file, "utf8").matchAll(re)].length
    if (n > 0) {
      perFile.set(relative(SRC, file), n)
      total += n
    }
  }
  return { total, perFile }
}

const countAll = (re: RegExp): { total: number; perFile: Map<string, number> } =>
  countIn(walk(SRC, []), re)

/** Forms C–F scan PROD files only (audit definition; header explains why). */
const countProd = (re: RegExp): { total: number; perFile: Map<string, number> } =>
  countIn(walk(SRC, []).filter(isProdFile), re)

/** Form F is line-level (match + same-line exclusion), not a content regex. */
const countStringifyWrites = (): { total: number; perFile: Map<string, number> } => {
  const perFile = new Map<string, number>()
  let total = 0
  for (const file of walk(SRC, []).filter(isProdFile)) {
    let n = 0
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (STRINGIFY_WRITE_LINE_RE.test(line) && !STRINGIFY_WRITE_EXCLUDE_RE.test(line)) n++
    }
    if (n > 0) {
      perFile.set(relative(SRC, file), n)
      total += n
    }
  }
  return { total, perFile }
}

const topFiles = (perFile: Map<string, number>): string =>
  [...perFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([f, n]) => `  ${n}× ${f}`)
    .join("\n")

const explain = (label: string, observed: number, baseline: number, fix: string): string =>
  `REGRESSION: a new ${label} was added (${observed} > ceiling ${baseline}). ${fix}\n` +
  `To locate new sites, diff your branch and grep for the pattern.`

/**
 * D14 one-directional ceiling. `observed > baseline` is the only failure mode.
 * A drop is NOT a failure — it emits a NON-FAILING advisory (so the floor can be
 * tightened voluntarily without a red test forcing a reflexive bump that
 * re-admits growth headroom — META-LESSON #6). Returns the perFile top-N for the
 * failure message.
 */
const assertCeiling = (
  label: string,
  observed: number,
  baseline: number,
  fix: string,
  perFile: Map<string, number>,
): void => {
  if (observed > baseline) {
    throw new Error(`${explain(label, observed, baseline, fix)} Top files:\n${topFiles(perFile)}`)
  }
  if (observed < baseline) {
    logger.info(
      `[silent-failure-ratchet] ${label} is below its ceiling (${observed} < ${baseline}). ` +
        `You can tighten the baseline constant to ${observed} to lock in the improvement.`,
    )
  }
  // Always-true belt so the test body has a teeth-bearing assertion even on the
  // common == path; the real teeth are the `throw` above (proven red-on-inject).
  expect(observed).toBeLessThanOrEqual(baseline)
}

describe("silent-failure growth ratchet (src/-wide, one-directional ceiling)", () => {
  test(`bare \`} catch {\` count <= ${BARE_CATCH_BASELINE} (prod ceiling)`, () => {
    const { total, perFile } = countProd(BARE_CATCH_RE)
    assertCeiling(
      "bare `} catch {`",
      total,
      BARE_CATCH_BASELINE,
      "Bind and attribute the error: `} catch (e) { logger.warn(`<label>: ${errMessage(e)}`) }`, rethrow, or return a typed Result.",
      perFile,
    )
  })

  // `@ts-expect-error` suppresses ALL type errors on the next line FOREVER and
  // silently survives the underlying fix — the canonical silent-failure
  // suppression. `@ts-expect-error <reason>` is the allowed form (it fails
  // the build when the error disappears). Zero-baseline: src/ has no real
  // uses today; the only matches are string LITERALS inside the
  // suppression-comment detector itself, which are pinned exactly.
  // (This cannot live in src-no-sketchy-code.test.ts — its scanner skips
  // comment lines, and @ts-expect-error always sits in a comment.)
  test("`@ts-ignore` is banned in src/ (use `@ts-expect-error <reason>`)", () => {
    const TS_IGNORE_RE = /@ts-ignore\b/g
    const LITERAL_ALLOWLIST: Readonly<Record<string, number>> = {
      // The detector names the pattern in string literals (`l.includes("@ts-expect-error")`).
      "tool/file-tree-summary/index.ts": 1,
    }
    const { perFile } = countAll(TS_IGNORE_RE)
    const offenders: string[] = []
    for (const [file, n] of perFile) {
      const allowed = LITERAL_ALLOWLIST[file] ?? 0
      if (n !== allowed) offenders.push(`  ${file}: ${n} (allowed ${allowed})`)
    }
    if (offenders.length > 0) {
      throw new Error(
        "`@ts-ignore` found in src/ — swap to `// @ts-expect-error <reason>` " +
          "so the suppression dies with the error it suppresses:\n" +
          offenders.join("\n"),
      )
    }
    expect(offenders.length).toBe(0)
  })

  test(`\`.catch(() => null|undefined)\` count <= ${NULLISH_PROMISE_SWALLOW_BASELINE} (prod ceiling)`, () => {
    const { total, perFile } = countProd(NULLISH_SWALLOW_RE)
    assertCeiling(
      "`.catch(() => null|undefined)` promise swallow",
      total,
      NULLISH_PROMISE_SWALLOW_BASELINE,
      "Attribute before degrading: `.catch((e) => { logger.debug(`<label>: ${errMessage(e)}`); return null })`.",
      perFile,
    )
  })

  // Form C (jun-10 audit R3) — fail-open masking via empty-literal return.
  test(`catch → return empty-literal count <= ${CATCH_RETURN_EMPTY_BASELINE} (prod ceiling)`, () => {
    const { total, perFile } = countProd(CATCH_RETURN_EMPTY_RE)
    assertCeiling(
      '`catch { return []|{}|""|0|false }` fail-open mask',
      total,
      CATCH_RETURN_EMPTY_BASELINE,
      "The caller cannot tell 'probe failed' from 'genuinely empty'. Degrade loudly: " +
        "return a typed `ok:false`/null result, or log first — " +
        "`} catch (e) { logger.debug(`<label>: ${errMessage(e)}`); return [] }`.",
      perFile,
    )
  })

  // Form D (jun-10 audit R1) — debug-only catch: a dying pump/transport is
  // visible only at debug verbosity, so prod death is silent (#4/8/9/10/11).
  test(`debug-only catch count <= ${DEBUG_ONLY_CATCH_BASELINE} (prod ceiling)`, () => {
    const { total, perFile } = countProd(DEBUG_ONLY_CATCH_RE)
    assertCeiling(
      "debug-only `catch (e) { logger.debug(…)` block",
      total,
      DEBUG_ONLY_CATCH_BASELINE,
      "If the failure can strand pending work (pump/transport/exit paths), upgrade to " +
        "`logger.warn` AND propagate the failure (fireExit / failAllPending / rethrow). " +
        "Reserve `.debug` for documented teardown races — and document them.",
      perFile,
    )
  })

  // Form D promise twin — zero-tolerance + pinned per-file allowlist (the
  // house pattern of the @ts-expect-error arm above). Pre-fix audit measured 0;
  // the jun-10 atomic-write fix lane added two LEGITIMATE best-effort
  // cleanups, pinned exactly so they cannot grow.
  test("`.catch((e) => logger.debug(…))` promise swallow is zero outside the pinned allowlist (prod)", () => {
    const PINNED_ALLOWLIST: Readonly<Record<string, number>> = {
      // Atomic-write cleanup path (jun-10 audit #17 fix): chmod mode-preserve
      // + temp-file unlink AFTER the real write error is already rethrown —
      // best-effort teardown with nothing left to surface. The 3rd (audit D10
      // fix) is the post-rename parent-DIR fsync — durability hardening that is
      // advisory by nature (the rename already landed; most fs don't need it),
      // so a fsync failure is genuinely best-effort, not a stranded-work path.
      "migration/external-config/persist.ts": 3,
    }
    const { perFile } = countProd(DEBUG_ONLY_PROMISE_RE)
    const offenders: string[] = []
    for (const [file, n] of perFile) {
      const allowed = PINNED_ALLOWLIST[file] ?? 0
      if (n !== allowed) offenders.push(`  ${file}: ${n} (allowed ${allowed})`)
    }
    if (offenders.length > 0) {
      throw new Error(
        "debug-only promise rejection handler found in src/ — a rejection routed straight " +
          "to `logger.debug` is invisible in prod. Upgrade to `logger.warn` + propagate, or " +
          "rethrow after logging:\n" +
          offenders.join("\n"),
      )
    }
    expect(offenders.length).toBe(0)
  })

  // Form E (jun-10 audit R2) — non-abortable sleep strands cancellation.
  test(`non-abortable \`new Promise((r) => setTimeout(…))\` sleep count <= ${NON_ABORTABLE_SLEEP_BASELINE} (prod ceiling)`, () => {
    const { total, perFile } = countProd(NON_ABORTABLE_SLEEP_RE)
    assertCeiling(
      "non-abortable timer sleep",
      total,
      NON_ABORTABLE_SLEEP_BASELINE,
      "A raw `new Promise((r) => setTimeout(r, ms))` keeps waiting the full delay after " +
        "the turn is aborted. Use the abort-aware sleep in src/agent/loop/sleep.ts " +
        "(threads AbortSignal; settles immediately on abort) instead.",
      perFile,
    )
  })

  // Form F (jun-10 audit R5) — JSON.stringify through a truncating write.
  test(`JSON.stringify through truncating write count <= ${STRINGIFY_TRUNCATING_WRITE_BASELINE} (prod ceiling)`, () => {
    const { total, perFile } = countStringifyWrites()
    assertCeiling(
      "`writeFile*(…, JSON.stringify(…))` truncating persisted-state write",
      total,
      STRINGIFY_TRUNCATING_WRITE_BASELINE,
      "A truncate-then-write torn by a crash leaves CORRUPT state on disk. Route persisted " +
        "JSON through `writeFileAtomic` in `@/storage` (ADR-0398: temp file + rename).",
      perFile,
    )
  })

  // ── D13: typed-Promise blind spot ──────────────────────────────────────
  // The widened NON_ABORTABLE_SLEEP_RE must match the generic form
  // `new Promise<void>((r) => setTimeout(…))` the un-generic regex missed.
  test("Form E regex matches the typed-Promise sleep form (D13)", () => {
    // Fresh regex (the const has the /g flag → lastIndex statefulness).
    const re = new RegExp(NON_ABORTABLE_SLEEP_RE.source)
    expect(re.test("new Promise<void>((r)=>setTimeout(r,1))")).toBe(true)
    expect(re.test("new Promise<void>((resolve) => setTimeout(resolve, ms))")).toBe(true)
    // The original ungeneric form must still match (no regression).
    expect(re.test("new Promise((r) => setTimeout(r, 1))")).toBe(true)
    expect(re.test("new Promise<unknown>((res) => setTimeout(res, 5))")).toBe(true)
  })

  // ── D5: self-consistency guard ─────────────────────────────────────────
  // Binds the header's CLAIMED scope to the ENFORCED scope as a test, not
  // prose, so the doc can't silently drift back to "full-src walk". The header
  // now says forms A/B are PROD-scoped (via countProd) — prove filtering is
  // ACTIVE (countAll strictly exceeds countProd, i.e. in-src test files DO
  // author these shapes and ARE excluded) and that the pinned ceiling sits at
  // or above the live prod count. We do NOT assert exact-equal on the baseline
  // (that would reintroduce the strict-equal bump reflex D14 removed).
  test("forms A/B are prod-scoped: filtering is active + ceiling >= live prod (D5)", () => {
    const bareAll = countAll(BARE_CATCH_RE).total
    const bareProd = countProd(BARE_CATCH_RE).total
    const nullishAll = countAll(NULLISH_SWALLOW_RE).total
    const nullishProd = countProd(NULLISH_SWALLOW_RE).total

    // Filtering is active: in-src test/hellgate files author these shapes and
    // are excluded, so the all-files count is strictly larger than prod-only.
    expect(bareAll).toBeGreaterThan(bareProd)
    expect(nullishAll).toBeGreaterThan(nullishProd)

    // The pinned ceiling is a valid upper bound on live prod (>=, never <).
    expect(BARE_CATCH_BASELINE).toBeGreaterThanOrEqual(bareProd)
    expect(NULLISH_PROMISE_SWALLOW_BASELINE).toBeGreaterThanOrEqual(nullishProd)
  })

  // ── D14: ceiling teeth — RED on growth, GREEN on drop ──────────────────
  // (1) Inject a bare-catch into a FRESH prod-shaped fixture tree and run the
  //     real BARE_CATCH_RE + the real assertCeiling over it: growth past the
  //     ceiling MUST throw. This proves the ratchet has teeth on real bytes,
  //     not just on the in-repo count which floats with in-flight work.
  test("ratchet FAILS when a new bare-catch pushes a fixture over its ceiling (D14)", () => {
    const dir = mkdtempSync(join(tmpdir(), "silent-ratchet-fixture-"))
    try {
      // A prod-shaped src file (no .test.ts, not under __tests__/).
      const f = join(dir, "fixture-prod.ts")
      writeFileSync(
        f,
        // One bare `} catch {` — exactly the form BARE_CATCH_RE counts.
        "export function probe() {\n  try {\n    risky()\n  } catch {\n    return 0\n  }\n}\n",
      )
      const fixtureProd = walk(dir, []).filter(isProdFile)
      const { total, perFile } = countIn(fixtureProd, BARE_CATCH_RE)
      expect(total).toBe(1)
      // Ceiling of 0 → injecting 1 must throw (the regression path).
      expect(() =>
        assertCeiling("bare `} catch {`", total, 0, "bind + attribute", perFile),
      ).toThrow(/REGRESSION/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // (2) Under `<=`, an observed count BELOW the ceiling PASSES (no reflexive
  //     bump). This is the core of D14 — removing a swallow must never red.
  test("ratchet PASSES when count is below the ceiling under `<=` (D14)", () => {
    // 5 observed against a ceiling of 9 → no throw; advisory is non-failing.
    expect(() => assertCeiling("demo", 5, 9, "fix text", new Map([["a/b.ts", 5]]))).not.toThrow()
    // Equality also passes.
    expect(() => assertCeiling("demo", 9, 9, "fix text", new Map())).not.toThrow()
  })
})
