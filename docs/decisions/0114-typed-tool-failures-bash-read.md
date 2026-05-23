# ADR-0114 — Typed tool failures: bash `permission_denied` + read `not_found` (gap closure)

**Status:** accepted (2026-05-23)
**Slice:** `@/tool` (bash + read)
**Tier:** S5 absorption (Cursor `ShellResult` / `EditResult` per-failure-mode oneof)
**Supersedes / extends:** absorb-#2 (the existing `ToolFailure` union and the
already-wired `bashTool`/`readTool`/`editTool` classifications)

## Context

`@/tool` already carries the closed `ToolFailure` discriminated union introduced
by absorb #2 (Cursor `ShellResult` / `EditResult` model):

```
ToolFailure =
  | { mode: "not_found"; path? }
  | { mode: "permission_denied"; path?; isReadonly? }
  | { mode: "rejected"; reason }
  | { mode: "timeout"; timeoutMs? }
  | { mode: "spawn_error"; error }
  | { mode: "error"; modelVisibleError?; clientVisibleError? }
```

`bashTool` already classifies `timeout` (the `ShellResult.timedOut` flag) and
`spawn_error` (the `exit 127 + command not found` shape). `readTool` already
classifies `permission_denied` (FsJail escape) and `not_found` (directory
target). `editTool` already classifies `not_found` (`old_string` mismatch) and
`permission_denied` (FsJail).

Two gaps remained — both surfaced as untyped failures the model could not
branch on:

1. **read on a missing file** — `statFile()` raised the raw OS `ENOENT` and the
   tool re-threw past the loop. The model saw a generic `error` instead of the
   `not_found` it could have recovered from.
2. **bash on a non-executable file** — `bash -lc <chmod-644>` exits 126 with
   `Permission denied` on stderr; the classifier left `failure` undefined, so a
   real OS exec-denial was indistinguishable from a script that legitimately
   exits 1.

## Decision

Extend the existing classifiers ONLY (no new ADR-level surface, no schema
change, no widening of the closed `ToolFailure` union).

### bash (`src/tool/bash/index.ts`)

`deriveBashFailure` gains a third branch:

```
exitCode === 126 AND /permission denied/i.test(stderr)  ⇒  { mode: "permission_denied" }
```

Narrowing on BOTH the exit code AND the stderr text avoids misclassifying an
unrelated 126 (POSIX also reserves 126 for "command found but not executable",
but the matching stderr is the load-bearing signal). `isReadonly` is
deliberately absent — this is a real OS-level denial, not a session
read-only-mode refusal.

### read (`src/tool/read/index.ts`)

`statFile()` and the follow-up `readFile()` now feed their `catch (e)` into a
single `classifyFsError(e, path)` helper that returns:

| input                                                  | classified `ToolResult`                                         |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| `FsJailError`                                          | `permission_denied { path, isReadonly: false }`                 |
| `errno: "ENOENT"` OR `message ~ /file not found/i`     | `not_found { path }` (output: `"File not found: <path>"`)        |
| anything else                                          | `null` — re-thrown (dispatch normalizes into a generic `error`) |

The same helper covers TOCTOU race-deletion between `statFile()` and
`readFile()`. Pre-fix the second branch re-threw; the fix wires the same
classification at both fall-points.

## Invariants

- **Opt-in seam, byte-identical default.** Every classification is on the
  `ok:false` path only. A tool that does not populate `failure` is byte-identical
  for every existing caller; the additive field is ABSENT (not `undefined`) on
  `ok:true` and on plain non-zero exits that fall outside the narrowed shapes.
- **Closed union — no widening.** The `ToolFailure` union stays at 6 modes; the
  exhaustive `switch (f.mode)` in `tests/unit/agent/tool-failure-mode.test.ts`
  (the `never`-default branch) still compiles.
- **`output` preserved.** The model-facing `output` text is the SAME as before
  on every path. `failure` is IN ADDITION TO — never INSTEAD OF — `output`.
- **No production-code import direction changes.** `src/tool/read` still only
  imports `@/storage` + `@/security`; `src/tool/bash` still only imports
  `@/runtime` + `@/security`. Slice fence intact.

## TDD trace

- `tests/unit/tool/typed-failures.test.ts` — 8 cases:
  - (a) bash timeout ⇒ `failure.mode: "timeout"` with `timeoutMs`
  - (b) read missing file ⇒ `failure.mode: "not_found"` (gap closure)
  - (b') read success ⇒ `failure` absent (no-false-positive)
  - (c) read FsJail escape ⇒ `failure.mode: "permission_denied"` (regression)
  - (d) edit `old_string` mismatch ⇒ `failure.mode: "not_found"` (regression)
  - (e) ordinary non-zero bash ⇒ NO `failure` field (byte-identical default)
  - (e') ok:true edit ⇒ NO `failure` field
  - (f) bash + non-exec script ⇒ `failure.mode: "permission_denied"` (gap closure)
- `tests/integration/typed-failures-e2e.test.ts` — 4 cases driving real
  `dispatchTool` through the real `bashTool`/`readTool` and asserting the
  typed `DispatchResult.failure` surface.
- `tests/unit/read.test.ts` — pre-existing "missing file rejects with a not-
  found error" test updated to assert the typed `not_found` failure (was
  `rejects.toThrow(/ENOENT|not found/i)`).

## Failure-mode mapping (canonical)

| Tool | Trigger                                              | `failure.mode`      | Carrying fields            |
| ---- | ---------------------------------------------------- | ------------------- | -------------------------- |
| bash | `timedOut === true`                                  | `timeout`           | `timeoutMs?`               |
| bash | `exit 127 + /command not found/i.test(stderr)`       | `spawn_error`       | `error`                    |
| bash | `exit 126 + /permission denied/i.test(stderr)`       | `permission_denied` | (no path / isReadonly)     |
| read | `FsJailError` from `statFile` or `readFile`          | `permission_denied` | `path`, `isReadonly:false` |
| read | `ENOENT` / `File not found:` from `statFile` or `readFile` | `not_found`         | `path`                     |
| read | `info.isDirectory === true`                          | `not_found`         | `path`                     |
| edit | `applyExactEdit/applyFuzzyEdit` mismatch             | `not_found`         | `path`                     |
| edit | `FsJailError` from `readFile`/`writeFile`            | `permission_denied` | `path`, `isReadonly:false` |
| edit | `gitWriteGuard` deny                                 | `permission_denied` | `path` (via helper)        |

## Consequences

- The model can now branch on `failure.mode === "not_found"` for a missing
  `read` target (re-issue `glob` or correct the path) without re-parsing the
  prose. Same for a `bash` command that hit EACCES on `execve` — the recovery is
  `chmod +x` or pick a different invocation, not "retry the same command".
- No new ADR-level surface. The closed `ToolFailure` union and the `Tool` /
  `DispatchResult` shapes are untouched.
- Refactor side-effect: `src/tool/read/index.ts` extracted `classifyFsError`
  and `renderReadOk` helpers so `execute` stays under the lint complexity gate.
  Pure: no I/O, no behavior change.

## Negative invariants (what is NOT absorbed)

- **No new `file_not_found` literal.** The canonical union already encodes a
  missing target as `not_found`; introducing a synonym would force every
  exhaustive switch to fork. Reusing `not_found` keeps the closed-union
  `never`-default check intact.
- **No widening of `permission_denied` to carry the stderr text.** Bash already
  surfaces the stderr in `evidence.stderr` and the `output` body; a structural
  duplicate is dead weight.
- **No bash exit-code → mode auto-table.** Only exit codes where the stderr
  text confirms the kind get classified. A bare `exit 126` without
  `Permission denied` stderr remains a plain non-zero failure.
