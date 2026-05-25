# ADR-0297: Sandbox-driven HITL — remove always-confirm command pattern matching

## Status
Accepted — 2026-05-25

## Context

The `bash` tool's `hitlTier(input)` previously inferred the always-confirm
gate by **inspecting the command string** with a 9-entry regex list
(`ALWAYS_CONFIRM_PATTERNS` in `src/tool/bash/index.ts`) — `curl|wget|gh
api|git push|git send-pack|git fetch|git commit --amend|git reset --hard`
escalated to always-confirm; everything else fell to pre-approval-ok.

The `GIT_PREFIX` regex was added (and hardened over multiple rounds — Round
1, Round 2 send-pack, etc.) to cover legal git global-option bypasses (`git
-C dir push`, `git --no-pager push`, `git -c k=v push`, `git --git-dir=…
push`). Each hardening round was a reaction to a new bypass class.

This was a **heuristic** — the gate guessed risk by looking at the command
text. The same risk surface is, however, already addressed authoritatively
at a different layer: the OS sandbox profile (`QUANTA_SANDBOX`,
ADR-0136 / ADR-0192). When the operator opts into `read-only`, the OS
itself refuses mutating syscalls — `git push` is harmless because the
kernel will reject the network connect. When they opt into
`workspace-write-net`, they have already accepted that the agent may make
network calls within the session — every shell command should be audited
under that scope, not just the ones containing the literal substring
`curl`.

Two failure modes follow from the heuristic posture:

- **False negative** — a new exfiltration vector (`scp`, `nc`, `rsync`,
  `aws s3 cp`, `gh release upload`, `kubectl apply`, …) ships in the
  user's $PATH and the regex list does NOT know about it. The agent
  silently runs it.
- **False positive** — `echo "git push --help"` matches `\bgit\b…push\b`
  and prompts the user. The agent looks broken.

Both failure modes are inherent to command-string matching. No amount of
GIT_PREFIX refinement can close them.

## Decision

**Delete the command-string heuristic. Let the sandbox profile decide.**

`bashTool` becomes a factory `makeBashTool({ sandboxProfile? })` that
closes over the resolved `OsSandboxProfile`. The `hitlTier` decision is a
**closed-enum switch** over the profile — zero command inspection:

| sandbox profile        | bash HITL tier      | Rationale |
|------------------------|---------------------|-----------|
| `read-only`            | `pre-approval-ok`   | OS itself refuses mutation — confirmation is redundant ceremony |
| `workspace-write`      | `pre-approval-ok`   | Operator explicitly accepted cwd writes |
| `workspace-write-net`  | `always-confirm`    | Network egress was opted in but each call is audited |
| `danger-full-access`   | `pre-approval-ok`   | Operator explicitly released all gates |
| `off` / unset          | `always-confirm`    | No sandbox → we don't know command risk → conservative |

The exported `bashTool` singleton (legacy back-compat) constructs with
sandbox profile **unset** → it now returns `always-confirm` for ALL
commands. Composition roots that wire a sandbox profile call
`makeBashTool({ sandboxProfile })` and the registry uses that instance.

### Deletions

- `ALWAYS_CONFIRM_PATTERNS` (9 entries, ~18 lines)
- `GIT_PREFIX` constant (the legal global-option matcher)
- `bashHitlTier(input)` rewritten — no longer reads `input.command`

### Surface change

- `bashTool: Tool<Input>` (singleton, still exported)
- NEW: `makeBashTool(opts: { sandboxProfile?: OsSandboxProfile }): Tool<Input>`
- `buildDefaultTools(ports: DefaultToolPorts)` — `ports.sandboxProfile?:
  OsSandboxProfile` new optional field

### Composition wire

`src/apps/cli/sandbox-wire.ts` already resolves the profile at boot from
`QUANTA_SANDBOX`. The CLI assembly path threads it through
`buildDefaultTools({ sandboxProfile })` — done via the existing slot.

## Consequences

### Positive
- **Zero command-string heuristic** in the HITL path. No regex maintenance
  burden. No false-positive (`echo "git push --help"`), no false-negative
  (`scp`, `aws s3`, …).
- `git -C dir push`, `git --no-pager push`, `git -c k=v push`,
  `git --git-dir=… push` — all option-injection bypasses become moot: the
  matcher is gone. The sandbox profile (or its absence) decides.
- New mutating CLIs ship in $PATH freely without us tracking them. The
  operator's profile choice is the single source of truth.
- The 4 hardening rounds against bypass classes are removed in one change.

### Negative — BREAKING under "unset" / default
- Sessions that ran with `QUANTA_SANDBOX` unset previously saw most bash
  commands as `pre-approval-ok` (regex did not match). They now see
  **every** bash command at `always-confirm` — a confirm prompt for `ls`,
  `bun test`, `git status`. The conservative posture is intentional: no
  sandbox = unknown risk.
- Operators who want the legacy "frictionless except dangerous" UX must
  opt into `QUANTA_SANDBOX=workspace-write` (or `read-only` for read-only
  sessions). The opt-in is one env var.
- Existing tests in `tests/unit/hitl-tier-classifier.test.ts` that
  asserted `pre-approval-ok` for `ls -la`, `git status`, `bun test`, the
  10-entry negative-control block, etc. now reflect new semantics
  (`always-confirm` under unset). Updated in this change.

### Negative — wider scope
- Sessions in `read-only` mode used to confirm `git push` (regex match)
  and now do not. This is correct (the kernel will refuse), but operators
  who relied on the confirmation as a UX nudge lose that nudge.

## Non-goals
- Permission-policy HARD_DENY (`rm -rf /`, `curl … | bash`, fork bomb)
  remains in `@/permission` policy-rules and is **upstream** of this
  HITL tier decision. The dispatch seam still routes HARD_DENY hits to
  `hand-off-required`. This change does NOT widen the HARD_DENY surface
  — it only removes command-pattern matching from the *softer*
  always-confirm tier.
- The OS sandbox enforcement itself (Seatbelt / Landlock+seccomp /
  bubblewrap) is unchanged; ADR-0192 / ADR-0193 stand.
- Per-command operator overrides (HITL annotations, ADR-0020 registry
  annotations) remain — operators who want `kubectl` → always-confirm
  irrespective of profile use the existing annotation surface.

## Migration
1. Operators who previously ran without `QUANTA_SANDBOX` SHOULD pick one:
   - `read-only` for review / triage sessions (zero confirms after this)
   - `workspace-write` for edit sessions (zero confirms after this)
   - `workspace-write-net` for sessions that legitimately fetch (every
     command audited — same UX as the old curl/wget rules but uniform)
   - `danger-full-access` only when sandboxing is intentionally disabled
2. CI / batch hosts SHOULD set the profile explicitly. Unset = audit-
   every-command is correct but high-friction for batch.

## Implementation
- `src/tool/bash/index.ts` — `makeBashTool({ sandboxProfile })` factory;
  patterns + GIT_PREFIX + tier function deleted.
- `src/tool/index.ts` — `DefaultToolPorts.sandboxProfile?:
  OsSandboxProfile`; `buildDefaultTools` forwards to `makeBashTool`.
- `src/apps/cli/sandbox-wire.ts` exposes the resolved profile so the
  composition root can thread it.
- `tests/hellgate/bash-hitl-sandbox-driven.test.ts` — ≥15 cases covering
  the closed-enum matrix; pre-existing classifier/dispatch tests updated
  to reflect new semantics.

## References
- ADR-0020 (HITL 4-tier gate; tiers themselves unchanged)
- ADR-0136 (OS sandbox helper)
- ADR-0192 (sandbox profile architecture)
- Memory `no-heuristics-only-validated` (load-bearing directive)
- Memory `codex-seatbelt-sandbox-profile` (profile semantics)
