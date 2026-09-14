# P0 hardening — SOTA++ plan (2026-09-13)

Scope: the P0 set from the 2026-09-13 competitor-reconciliation campaign — security holes reachable in default config + self-defects where the feature catalog (fc) claims a capability the code never fires. Evidence: `.extracted_source/GAP-RECONCILE-2026-09-13.md` (Part 1 overclaims, Part 2 gaps), `.extracted_source/REFRESH-DIFF-2026-09-13.md` (§A defects), `.extracted_source/_verify-2026-09-13-*.md` (probes). NOT competitor-feature absorption — that is the P1 backlog, parked.

**Status: PLAN ONLY. No implementation until the user greenlights a wave.**

---

## 0. Protocol (per item, non-negotiable)

Standard hellgate 5-stage ([[hellgate-implementation-protocol]]) + the two-round parallel audit the user asked for:

1. **RED e2e hellgate** — write the failing proof FIRST, at the surface the user reaches (real `runAgent`/PTY/`src/**/*.test.ts`, not a pure-fn unit — [[verification-scope-and-wiring-proof]]). It must fail for the *stated* reason (red-on-injection), and for security items it must be a **red-on-attack**: the exploit succeeds before the fix. A pure-function test that can't see the composition root is inadmissible here — every one of these bugs is a *wiring* bug, so the RED must exercise the wire.
2. **TDD + structural impl** — smallest change at the real seam; static-first, leaf-unit ([[work-protocol-hellgate-hellaudit-punchcard]] 천공카드). Default-OFF/byte-identical for behavior changes where a knob is involved; security fixes flip *closed* by default and document the escape hatch.
3. **Round-1 audit (parallel, 2 lenses)** — dispatch two agents at once:
   - **adversarial**: try to bypass the fix (new attack vector, the fix's own blind spot, a sibling call site the fix missed).
   - **objective/correctness**: does it do what it claims, no regression, no scope-creep, no vacuous assert; is the RED now GREEN for the right reason.
4. **Fix round-1 findings**, then **Round-2 audit (parallel, 2 lenses)** — the *final* pass:
   - **adversarial-regression**: re-attack + mutation (flip the guard, does a test catch it? [[test-quality-culture-portable]]).
   - **objective-wiring-proof**: prove the producer/gate is reachable from an app entrypoint (not just the pure fn) — the exact failure mode of OC-1/OC-2. For fc items, confirm the yaml maturity claim now matches code.
   Converge to clean (≥ the 2 rounds here + the campaign's prior verify round = the ≥3-adversarial-audit bar of [[claim-100-needs-3-adversarial-audits]]).
5. **Structural TDD backfill** — the regression test that would have caught this class (a round-trip test for OC-3, a producer-reachability test for OC-1/OC-2, a red-on-attack fixture for each SEC).

**Audit lenses run in PARALLEL per round** (two agents, one message), adversarial + objective both, both rounds. Do not accept a subagent's "clean" without the orchestrator re-checking the decisive `path:line` / re-running the RED ([[feedback-no-optimistic-judgment-from-few-signals]]).

## 0.1 Landing strategy (parallel waves)

⚠️ **Concurrent-session hazard live** ([[concurrent-session-git-hazard]]): another session is committing to this repo (HEAD moved `d091da703`→`c63a8e393` mid-session, tool-surface/permission zone). Before landing ANY wave: re-check HEAD, ff, and re-run the wave's RED against the current tree. Never rewrite refs, never blind `git stash`.

Waves are **file-disjoint** so they can run as parallel worktrees ([[parallel-wave-landing-coupled-hotpath]]); Wave-P overlaps the concurrent session's hot zone, so it lands last / main-direct with a fresh HEAD.

| wave | items | files (disjoint set) | concurrent-zone? |
|---|---|---|---|
| **W-EGRESS** | SEC-1, SEC-2, OC-4 | `src/llm/{factory,provider-router}.ts`, `src/shared/env-files.ts`, `src/lsp/adapters/*`, `src/runtime/os-sandbox/*` | no |
| **W-OBS** | OC-5/BUG-2, OC-1, OC-2 | `src/agent/context/*`, `src/apps/cli/context-*`, `src/activity/*` + producers, `src/host/runtime/agent-config-assembler.ts` | no |
| **W-SESSION** | OC-3/BUG-1, BUG-3, BUG-4 | `src/session/saved-session-schema.ts`, `src/objective/*`, web frontend `session-hooks.ts`/`App.tsx` | no |
| **W-PERM** ⚠️ | SEC-3, SEC-4, SEC-5 | `src/subagent/{agent-tools-6,handlers-6}.ts`, `src/permission/policy*.ts`, `src/agent/run-mode/repo-rules-policy.ts` | **YES — land last, fresh HEAD** |
| **W-DOC** | catalog-honesty | `docs/10.feature-catalog.md`, `tools/feature-catalog/features/**` (6 yaml) | no (fold into each wave that fixes the matching OC) |

Each wave ≥30 tool-uses → worktree; W-DOC is <30 → main-direct ([[feedback-worktree-dispatch-envelope]]). Worktree dispatch carries the 🛑 staleness preamble + port shapes verbatim ([[feedback-worktree-staleness-pattern]]).

## 0.2 Verification recipe (shared)

Local toolchain ([[verify-workflow]]): `./node_modules/.bin/tsc --noEmit`, `./node_modules/.bin/biome check <changed paths>`, `/Users/songmin/.bun/bin/bun test tests/unit tests/integration`. Security RED fixtures live under `tests/integration/**` and must be **red-on-attack** (exploit passes pre-fix). Strongest closure = a real OpenAI smoke for the loop-touching items (OC-1/OC-2/BUG-3). Fix only files this plan owns; surface (don't fix) the concurrent session's in-flight APIs.

---

## W-EGRESS

### SEC-1 · repo `.env` exfiltrates the API key
- **RED (red-on-attack):** integration test — write a scratch cwd with `.env` setting `OPENAI_BASE_URL=http://127.0.0.1:<port>/v1`, a real-env `OPENAI_API_KEY`, run the LLM factory path; assert the key currently egresses to the local listener (documents the hole), then flip the assertion to "refused/absent" post-fix. (Mirror the orchestrator's manual probe in `scratchpad/dotenv-probe`.)
- **Impl seam:** `src/llm/factory.ts:405,514` (`OPENAI_BASE_URL`) + `provider-router.ts:82-86` (`ANTHROPIC_*_BASE_URL` keys). Reuse the ADR-0555 provenance gate exactly as `memory-compose.ts:54` does: `envFileSourceOf("OPENAI_BASE_URL")` — if the base URL came from a repo `.env*` (not the real env), refuse to attach a real-env credential to it (or require an explicit `QUANTA_LLM_EGRESS`-style opt-in), emitting one attributed `logger.warn` naming the file. Real-env base URL = byte-identical.
- **Audit focus:** adversarial — `.env.dev`/`.env.local` precedence, `ANTHROPIC_*` keys, the memory embedder path (already gated — confirm no double-prompt), a base URL that is real-env but key from `.env` (mixed provenance). objective — real-env config unchanged; BYOK legit users not broken.

### SEC-2 · LSP runs repo-controlled code
- **RED:** integration test — scratch repo with a planted `.venv/bin/python` (a script that touches a sentinel file); spawn `PyrightAdapter`; assert the sentinel is created pre-fix (the orchestrator proved this 6×), absent post-fix. Sibling: a `rust-toolchain.toml` / `build.rs` fixture for rust-analyzer (mark UNVERIFIED-at-runtime if the server isn't installed; still assert the init-options are passed).
- **Impl seam:** `src/lsp/adapters/pyright.ts:18-30` (stop deriving the interpreter from repo `.venv`; pin to a trusted interpreter or gate on TrustStore), `rust-analyzer.ts` (pass initializationOptions: `cargo.buildScripts.enable=false`, `procMacro.enable=false`, `cargo.runBuildScripts=false`, `check.command` off), `base/transport.ts:73-86` (scrub egress-sensitive env for the server subprocess; `CARGO_NET_OFFLINE=true`). Mirror Codex desktop F6.
- **Audit focus:** adversarial — gopls (`go.work`/toolchain), clangd (`.clangd`, `compile_commands.json` compilers), tsserver (repo `node_modules/.bin`); does the fix cover all adapters or just pyright/rust? objective — legit LSP nav still works on a trusted repo.

### OC-4 · seatbelt strict knobs never passed → global reads
- **RED:** unit+integration — assert `compileSeatbeltProfile(policy, cwd)` (the actual production call shape at `wrap-argv.ts:85`, `default.ts:104`) currently yields `(allow file-read*)` with no workspace narrowing; then assert a workspace-read-boundary is emitted when the new knob is on.
- **Impl seam:** thread a `readBoundary: "workspace"|"system"` (Cursor N8 shape) from a knob through both call sites into `compileSeatbeltProfile`'s existing `opts?: StrictKnobs` (already implemented in `strict-policy.ts`, just unwired), + the bubblewrap (`--ro-bind` narrowing) and windows (`denyReadPaths`) mirrors. Keeps `~/.ssh`/`~/.aws`/`.env` outside a sandboxed command's read set. Default posture decision: on when sandbox is on (sandbox itself is off by default in CLI, so this is not a behavior change for the default path — document that).
- **Audit focus:** adversarial — dyld/libsystem still resolves (the reason the code went global; keep metadata-read global like Cursor); the bwrap/windows mirrors match the seatbelt semantics. objective — a legit workspace build still reads its own toolchain. **W-DOC:** downgrade/rewire `seatbelt-verbatim.yaml` (OC-4).

---

## W-OBS

### OC-5 / BUG-2 · `/context` excludes conversation tokens
- **RED:** unit — feed `snapshotToBreakdownInput` a snapshot with a 50k-char system prompt + a long transcript; assert `total` currently ignores the transcript ("94% left"); then assert `total` includes conversation + tool-def tokens. Plus an integration assert that the pre-compaction warning (`context-warning.ts`) fires when the transcript crosses threshold.
- **Impl seam:** `src/agent/context/usage-breakdown.ts:281` (`snapshotToBreakdownInput` must also receive the working-memory transcript tokens + tool-def tokens, not only `snap.system`), `context-usage-snapshot.ts:82` + web `canvas-usage-source.ts:56` (feed the transcript in). The estimator (`asMessage`/`estimateTokens`) already exists — the gap is *what* is passed.
- **Audit focus:** adversarial — double-counting cached vs uncached; the reasoning-token split; web vs CLI parity. objective — the number now matches the loop's own compaction trigger total. **W-DOC:** fix `context-usage-breakdown.yaml` deliberate_hold + maturity (OC-5).

### OC-1 · activity `stuck` never produced
- **RED (producer-reachability):** integration — drive a real loop into an approval-wait (or subagent-wait, or tool-in-flight past a threshold); assert `/activity` / the spine currently shows `running`, never `stuck`; then assert a `stuck` node with the right `Stuck.reason` appears.
- **Impl seam:** emit `{type:"node_status", id, status:"stuck", stuck:{reason,detail}}` (the existing `AgentActivityEvent` arm, `activity/types.ts:160`) from the producers: approval-wait (permission gate), subagent-wait (`wait_agent`), and a tool-in-flight watchdog past a threshold. Producers reach the spine via the `session-authorities` activity adapter already imported at `src/runner/assemble/session-authorities/build.ts`. The reducer/rollup/render already handle `stuck` — this is pure producer wiring.
- **Audit focus:** adversarial — a node cleared from `stuck` back to `running` on unblock (no stuck-latch); the closed `Stuck.reason` union covers the real wait kinds. objective — no false-stuck during normal fast tool calls (threshold sane). This is OC-1's own failure mode → the wiring-proof lens is mandatory. **W-DOC:** flip `activity-spine.yaml` claim honest.

### OC-2 · `cfg.pausedReason` unwired → `response_queued` never fires
- **RED (producer-reachability):** integration — queue a follow-up while a turn is paused (rate-limit / tool-in-flight); assert `response_queued` / `⏸ queued` currently never emits; then assert it fires with the right `PausedReason`.
- **Impl seam:** assign `cfg.pausedReason` in the composition root `src/host/runtime/agent-config-assembler.ts:788` (the `AgentConfig = {}` literal) — source it from the mid-turn-interruption state (`mid-turn-interruption/default.ts:171` already computes `inferPausedReason`). `control-poll.ts:152` already reads it + calls `emitResponseQueued`; the stdout renderer (`stream/adapters/stdout.ts:503`) already renders it. Pure wiring at one site.
- **Audit focus:** adversarial — the `serve-stdio` path (`followUpQueue: undefined` at serve-stdio-cmd.ts:272) — does it need it too, or is undefined correct there; thread-id scoping. objective — no spurious `response_queued` when not actually paused. **W-DOC:** `queued-follow-ups.yaml` claim honest.

---

## W-SESSION

### OC-3 / BUG-1 · resume strips message `origin`
- **RED (round-trip):** unit — build a session with a harness-authored compaction summary (origin=harness), `saveSession`→`readSessionSnapshot`, assert `origin` is currently lost (message reloads as plain user) → then assert it survives; plus an integration assert that a resumed summary is NOT canonicalized as a user-stated constraint by `SUMMARY_SYSTEM`.
- **Impl seam:** add `origin` to `src/session/saved-session-schema.ts:106-115` `messageSchema` (zod strips unknown keys — this is the whole bug). Confirm the writer actually persists it and the reader restores it; check `/rewind` (only checks id prefix) and `isHarnessAuthored` consumers.
- **Audit focus:** adversarial — messages with no id (the exact case that loses the tag); forward-compat for old saved sessions missing the field (default). objective — no schema-migration break on existing session files. **W-DOC:** `harness-provenance-on-message.yaml` L4→honest (OC-3).

### BUG-3 · goal retries auth/billing errors like no-progress
- **RED:** unit — call `computeGoalWakeDelay` with an `error` turn whose `stopCategory.reasonCode` is auth/billing; assert it currently returns the same escalating backoff as no-progress (retries ~20× to `product-hard-cap`); then assert it skips/pauses with a cause.
- **Impl seam:** `src/objective/goal-wake-policy.ts:150-175` + `objective-settlement.ts:39-47` — add a lookup table keyed on the existing `stopCategory.reasonCode` (already computed elsewhere, just ignored here): auth/billing/invalid-request → pause with cause (don't consume the autonomous cap); infra → the existing cooldown; genuine no-progress → the existing backoff. Claude Code N2 shape. NOT a new classifier.
- **Audit focus:** adversarial — an error that is genuinely transient (rate-limit) shouldn't pause forever; the closed reasonCode union is exhaustively classified ([[exhaustive-record-classification-drift-guard]] — `Record<ReasonCode,Policy>` + drift guard). objective — a real no-progress goal still backs off as before.

### BUG-4 · web silently loses a message when `send()` fails
- **RED:** web unit — mock `send()` to reject; assert the draft is currently cleared and the message lost; then assert the draft is retained and a "not-yet-confirmed" state shows.
- **Impl seam:** `src/apps/web` `session-hooks.ts:965-966` + `App.tsx:810` — do not clear the draft until `send()` resolves; stamp accepted events with the command id so the client can mark a send confirmed vs pending. (Daemon already rejects dup ids, so retention is safe.)
- **Audit focus:** adversarial — the two-frame partial-send race; reconnect while a send is pending. objective — normal send still clears the draft exactly once.

---

## W-PERM ⚠️ (land last, fresh HEAD — concurrent-session zone)

### SEC-3 · `write_stdin` bypasses HARD_DENY
- **RED (red-on-attack):** integration — `exec_command` starts `bash`, then `write_stdin` sends `rm -rf ~\n`; assert HARD_DENY is currently not consulted (the orchestrator probed `hardDeny=null`); then assert the destructive stdin is denied/HITL'd.
- **Impl seam:** `src/subagent/agent-tools-6.ts:186-194` — add a command extractor for `write_stdin` mirroring `exec_command`'s (feed the stdin bytes to the same pre-dispatch deny check); `handlers-6.ts:151-176` — gate before writing. Consider keying the session grant on content, not the bare `"write_stdin"` name (amplifier). Also SEC-1-adjacent: `exec_command` spawns outside the OS sandbox — note for W-EGRESS overlap.
- **Audit focus:** adversarial — chunked/partial writes that assemble a denied command across calls; interactive REPL stdin (python `os.system`); the bare-name grant amplifier. objective — legit interactive stdin (answering a prompt) still works.

### SEC-4 · `rm -rf "$@"` / unknown targets pass
- **RED (red-on-attack):** unit+integration — `rm -rf "$@"`, `set -- ~; rm -rf "$@"`, `x=~; rm -rf "$x"`, `xargs rm -rf`; assert all currently pass under bypass; then assert destructive-verb + `unknown` target → blocked/HITL.
- **Impl seam:** `src/permission/policy.ts:93` (`unknown` is computed but only read for hard-deny) — for destructive verbs (`rm -rf`, etc.) treat an `unknown`/unresolvable target as ask-not-allow (Claude Code N16). Data half in `policy-rules.ts`.
- **Audit focus:** adversarial — the wildcard-before-subcommand rule; `find -delete`, `shred`, `>` truncation as sibling destructive verbs; false-positive on a safe `rm ./known`. objective — a resolvable safe delete still passes. **W-DOC:** `shell-effect-authority.yaml` title honest (OC-6).

### SEC-5 · untrusted-repo AGENTS.md loaded with no trust check
- **RED (red-on-attack):** integration — an untrusted repo with an AGENTS.md carrying an injected instruction; assert it currently lands in the trusted `project_md` system section; then assert an untrusted repo's AGENTS.md is withheld (or quarantined) until trusted.
- **Impl seam:** `src/agent/run-mode/repo-rules-policy.ts:26-33` (interactive → `"load"` unconditionally) + `session-state-ports.ts:252` — consult `TrustStore` (`src/config/trust-store.ts`, `TrustStore` class + `canonicalizeProjectPath`) before returning `load`; untrusted → skip/quarantine. Codex F30 shape.
- **Audit focus:** adversarial — nested/tree-scoped AGENTS.md (deeper-wins), first-run trust prompt UX, symlinked repo paths (canonicalize). objective — a trusted repo (the developer's own) still loads its rules unchanged.

---

## W-DOC (catalog honesty — code-unmodified, fold per wave)
- `docs/10.feature-catalog.md:2478` — delete/rewrite the stale "Heartbeat/cron 자동화 미흡수" line (automation-engine/scheduler-rrule/heartbeat-eligibility are absorbed). Move to a "흡수완료" note.
- OC-1..6 yaml maturity: each wave that wires the missing producer flips its yaml claim to match code; any left unwired gets an honest downgrade + a `deliberate_hold`. `bun fc audit`/`reachability` is the enforcement judge — the id must clear on its own, no baseline edit ([[jul-30-ratchet-burndown-classify-not-paper]]).

---

## Sequencing recommendation
1. **W-EGRESS first** (SEC-1 is the worst hole, all cost S, no concurrent-zone overlap).
2. **W-OBS + W-SESSION in parallel** (disjoint; OC-1/OC-2/OC-5 are the north-star wiring, BUG-1/BUG-3 are cheap correctness).
3. **W-PERM last** with a fresh HEAD + re-run RED (concurrent session owns that zone).
4. W-DOC folds into each.

Two-round parallel adversarial+objective audit per item, converging clean, before any wave is declared landed.
