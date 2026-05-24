# ADR-0199: macOS Seatbelt verbatim profile + strict knobs

- **Status**: Accepted (Phase 1 — verbatim parity fixtures + 4 strict knobs default-OFF + injection-defended workspace escape; Phase 2 = sandbox-exec live integration battery extension)
- **Date**: 2026-05-25
- **Related**:
  - ADR-0136 (OS sandbox helper foundation — establishes `compileSeatbeltProfile` baseline)
  - ADR-0193 (Linux sandbox native impl — sibling axis; this ADR mirrors the macOS axis)
  - ADR-0150 (Phase 2 bubblewrap fallback)
- **Reference**: Codex `codex-seatbelt-sandbox-profile` verbatim profile shape (memory: [[codex-seatbelt-sandbox-profile]]), `.extracted_source/codex/` strings (Rust binary)

## Context

Three vendors (Codex / Claude Code / Cursor) ship a macOS sandbox layer
that compiles a Seatbelt (SBPL) profile and shells out via `sandbox-exec
-p <profile> -- argv...`. Our existing `compileSeatbeltProfile` in
`src/runtime/os-sandbox/seatbelt.ts` carries a comment claiming "mirrors
Codex baseline" but two real gaps remained:

1. **No verbatim parity test.** The comment was the only contract.
   A drift in our line list would silently desynchronize from the Codex
   baseline (which is the only public reference for what a working
   macOS dev-tooling sandbox needs to read — `/Library/Apple`,
   `/System/Library/PrivateFrameworks`, `/private/var/db/timezone`, etc.).
2. **No strict knobs.** Codex's baseline is permissive by design
   (subprocess-spawning is on, `/tmp` write may be wanted, network is
   profile-driven). For high-assurance turns (planning / read-only audit /
   air-gapped review) we want a tightened policy without forking the
   whole compiler. There was no seam for that.
3. **Workspace path injection surface.** The workspace path is
   string-interpolated into the SBPL profile. Today's
   `escapeSbpl` escapes `"` and `\` — good — but the escape contract
   was tested only as a side effect of byte-determinism. An adversarial
   workspace containing `)` or `"` could in principle prematurely
   close an `(subpath "…")` sexp. The defense exists; the lock was
   missing.

## Decision

### Part 1 — Verbatim parity fixtures (`parity-fixtures/`)

Three checked-in fixture files capture the **exact** Codex-shape profile
output, with the workspace path placeholder `__WORKSPACE__` to be
substituted by the hellgate:

- `parity-fixtures/read-only.sb` — file-write* lines absent
- `parity-fixtures/workspace-write.sb` — file-write* on workspace only
- `parity-fixtures/workspace-write-net.sb` — workspace-write + network allow

The hellgate compares `compileSeatbeltProfile(policy, "/ws")` output
byte-for-byte against `fixture.replace(/__WORKSPACE__/g, "/ws")`.
Drift in either direction (us moving, Codex moving) breaks the gate
loudly. The intent is **lock**, not "track upstream automatically" —
upstream churn requires a human acknowledging the diff via fixture edit.

### Part 2 — Strict knob compiler (`strict-policy.ts`)

A new optional `StrictKnobs` argument to `compileSeatbeltProfile`:

| Knob | Default | When `true` |
|------|---------|-------------|
| `denyForkAdditional` | `false` | Add `(deny process-fork)` after the baseline allow. Net effect: deny wins by being more specific. |
| `denyNetworkAlways` | `false` | Force `(deny network*)` even if profile / `allowNetwork` says allow. Strict wins. |
| `allowTmpWrite` | `false` | Add `/private/tmp` to the write subpath list. |
| `denyMetadataReadAbsolute` | `false` | Omit the `/` metadata-read allow (the existing baseline does not emit this line, but if a future profile arm does this knob suppresses it). |

When the optional argument is omitted entirely, the compiler is
**byte-identical** to the pre-ADR behavior — verified by HELL-SB-05.

### Part 3 — Profile diff (`profile-diff.ts`)

A tiny line-based differ used both by the hellgate (to make failures
actionable: "line 12: expected X, got Y") and as a debug tool for
running `compileSeatbeltProfile(policy)` against a fixture during
upstream-sync work.

### Part 4 — Injection defense

The workspace path is already escaped via `escapeSbpl` for `"` and `\`.
This ADR locks the contract by HELL-SB-03: workspace strings containing
`)`, `"`, `\n` either escape cleanly OR the compiler rejects them. The
chosen policy is **escape-not-reject** because rejecting would break
legitimate paths on hosts with unusual mount points, and Seatbelt's SBPL
treats `)` as syntactic only when not inside a string literal — once `"`
is escaped, `)` inside the string is no longer special. The hellgate
proves the closed-paren invariant by parsing the output and confirming
exactly one `(subpath "…")` per declared path.

## Consequences

- **Default-OFF for all knobs.** No production caller is affected unless
  they explicitly opt into `denyForkAdditional` / `denyNetworkAlways` /
  `allowTmpWrite` / `denyMetadataReadAbsolute`.
- **Darwin-only.** Hellgate integration tests
  (`tests/integration/seatbelt-exec-hellgate.test.ts`) use
  `describeOnDarwin` from `tests/_support/darwin-only.ts` so Linux CI
  records polite skips instead of false negatives.
- **Live exec battery deferred to Phase 2.** When attempting an
  end-to-end `sandbox-exec -p <profile> -- /bin/sh -c '…'` over the
  current baseline, `sh` exits with SIGABRT before producing output.
  The cause is twofold: (a) the baseline denies `process-exec` of new
  binaries by design (see `seatbelt.ts` design notes — "syscall-level
  analogue of no shell-out exits"), and (b) even with `(allow
  process-exec)` spliced in for diagnosis, `sh` aborts under the
  current framework-subpath allowlist (a real gap unrelated to ADR-0199
  parity). Both are pre-existing and out of scope for this ADR. The
  Phase-1 integration file registers two negative-side cases (null
  passthrough on `off` / `danger-full-access`) so the file is not
  dormant; the full live deny/allow matrix moves to a Phase 2 slice
  that widens the framework allowlist and ships a single
  `(allow process-exec)` decision.
- **Closed-port.** The `compileSeatbeltProfile(policy, workspace, opts?)`
  signature adds `opts` as the third optional argument. Existing
  call-sites (`src/runtime/os-sandbox/default.ts`) pass two arguments;
  byte-identical.
- **Codex upstream sync.** Future Codex profile changes appear as a
  test failure in HELL-SB-01/HELL-SB-10. The remediation is a fixture
  edit + a brief justification in the commit message, not a code change.
- **No new dependencies.** Pure string composition over the existing
  `SandboxPolicy` shape; plane-clean `src/runtime/os-sandbox/**` (no
  imports from other planes — enforced by the existing biome rule at
  `biome.json` line ~1217).

## Negative invariants (locked by hellgate)

- Default-OFF must remain byte-identical to ADR-0136 output.
- Workspace path must be escaped — never raw-interpolated.
- Strict knobs only **tighten** policy; they MUST NOT widen.
- `danger-full-access` and `off` profile return `null` (passthrough)
  even when strict knobs are set — strict knobs are advisory inside a
  compiled profile, not a mode override.
