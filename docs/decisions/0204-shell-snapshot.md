# ADR-0204: Per-turn shell environment snapshot (hermetic shell)

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0006 (runtime sandbox + env scrubbing), ADR-0081 (shell
  typed events), ADR-0201 (fork session — sibling fork-safety primitive),
  ADR-0144 (observability metrics — follow-up `quanta.shell.*` keys).

## Context

A 4-way agent on-disk audit (Claude / Cursor / Codex / quanta) shows
**Codex** uniquely persists, at every turn entry, a shell-state snapshot
to `~/.codex/shell_snapshots/{thread-uuid}.{ns}.sh` (~90KB typical).
Subsequent shell-tool invocations spawn the user shell with that file
`source`d, so user-defined aliases / functions / exported parameters
(typically loaded by `~/.zshrc` or `~/.bashrc`) are visible to the
command — even after a fork / resume that re-enters in a fresh process
with no rc execution.

quanta today calls `runShell` (`src/runtime/shell.ts`) which spawns
`bash -lc` with a **scrubbed** env (ADR-0006). The login-flag (`-l`)
gives `.bash_profile` / `.zprofile` execution but does NOT source
`.bashrc` / `.zshrc` interactively — and after a fork (ADR-0201) the
fresh shell loses any state that depended on the parent session's
interactive customizations. The asymmetry against Codex is real:
identical user input produces a different command surface depending on
whether quanta was started fresh vs. resumed from a snapshot.

Wire surface in quanta is small — `src/tool/git/runner.ts`, the tools
that delegate to `runShell`, and one or two ad-hoc `Bun.spawn(["bash",
"-c", …])` sites. The cost of NOT having a port is that any future fix
must scatter snapshot logic at each spawn site. The cost of HAVING the
port now (default-OFF) is one new directory under `src/runtime/` with
zero existing-byte change.

## Decision

Ship a **slice-only** snapshot primitive at `src/runtime/shell-snapshot/`:

1. **Closed port** — `ShellSnapshotPort` exposes two operations:
   - `capture({ shell: "zsh"|"bash" }) → Result<SnapshotHandle, SnapErr>`
     persists the active shell's env to a file under
     `~/.quanta/shell_snapshots/{id}.sh` (mode 0600).
   - `restore(handle, prefix) → string[]` returns a NEW argv that, when
     the prefix is recognized as a `*sh -c` form, prepends `source
     {path};` to the user command. Non-shell prefixes are returned
     unchanged with a `degradeReason` carried out-of-band (return type
     stays `string[]` — degrade is reported via the caller's existing
     observability path).
2. **Per-shell adapters** — `zsh-capture.ts` runs
   `zsh -i -c "typeset -p; alias; declare -f"` (zsh-correct ordering);
   `bash-capture.ts` runs `bash -i -c "declare -p; declare -f; alias"`.
   Empty output ⇒ `Err("empty-capture")`; missing binary ⇒
   `Err("shell-missing")`; > 10s ⇒ `Err("capture-timeout")`.
3. **File store** — atomic write with `{ mode: 0o600 }`, sanitised id
   (`[^A-Za-z0-9._-]` → `-`, leading dot/dash stripped, 48-char cap), a
   nonce suffix to guarantee unique paths under concurrent capture, and
   `prune(olderThanMs)` for retention.
4. **Headless stub** — deterministic content for tests; never touches
   the filesystem.
5. **No wire**. The composition root, CLI, agent loop, tool slice, and
   scheduler are NOT modified by this ADR. Wire-up to `runShell` is a
   follow-up slice; until then the byte-identical guarantee of the
   spawn path is preserved verbatim.

## Consequences

- **Default-OFF byte-identical.** No caller imports the new module
  yet; `runShell` is untouched. Spawned argv stays
  `["bash","-lc",cmd]` exactly as before.
- **Filesystem.** Introduces `~/.quanta/shell_snapshots/` (mode 0700 on
  the directory, 0600 on files). `prune` is provided so the directory
  does not grow unbounded once wired; until wired, the directory is
  never created.
- **Security.** id-sanitisation rejects path-injection (`;`, `\n`,
  `..`, leading `-`); the captured file is mode 0600 so other users on
  the host cannot read environment values; `source` is invoked with a
  bracketed path under the user's HOME — never with model-supplied
  content.
- **Observability follow-up.** Once wired, emit
  `quanta.shell.snapshot_duration_ms` and
  `quanta.shell.snapshot_bytes` via the existing OTel metric registry
  (ADR-0144). Not emitted in this ADR — the primitive is silent.
- **Test-only headless stub.** `headless-stub.ts` returns a constant
  payload so unit / integration suites do not depend on a real shell
  being installed on CI; the production code-path is exercised by the
  hellgate at `tests/unit/runtime/shell-snapshot-hellgate.test.ts`.

## Negative invariants

- The slice does NOT modify `src/agent/`, `src/memory/`,
  `src/scheduler/`, or `src/tool/` — wiring is a deliberate later
  step. A grep for `shell-snapshot` outside `src/runtime/shell-snapshot/`
  and `tests/unit/runtime/shell-snapshot-hellgate.test.ts` must return
  empty until the follow-up wire ADR.
- `restore` NEVER mutates the input prefix array.
- `capture` NEVER calls `source` itself — it only persists the
  serialised state. Sourcing happens inside the spawned shell at
  command-execution time.
- `restore` NEVER touches the captured file — it only prepends a
  `source` directive to the argv string.
