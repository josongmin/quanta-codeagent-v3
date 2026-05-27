# ADR-0377 — Cross-platform inspector path normalization

Status: Accepted
Date: 2026-05-28
Relates: ADR-0370 (inspector + `/session-registry` slash), ADR-0365
(Windows flock strategy), ADR-0361 (sqlite backend), ADR-0351 (disk
backend), memory `codex-logs-retention-pattern` (Codex
`logs_2.sqlite` admin parity).

## Context

ADR-0370 added an operator-visibility inspector for the
`SessionResourceRegistry` slice — three backends (in-memory / disk /
sqlite) each producing a `RegistryStats` snapshot rendered by
`formatRegistryStats`. The snapshot intentionally did NOT carry the
backend's on-disk path: the formatter only rendered counts + bytes +
caps. Two parity gaps surfaced after the slice landed:

1. **Operator can't see WHERE the data lives.** A Codex admin
   inspecting `~/.codex/logs_2.sqlite` always knows the path because
   they shelled into it. quanta's slash output gave no equivalent
   hint, so a misconfigured `QUANTA_SESSION_REGISTRY_*` env var was
   invisible until a session leaked into the wrong store.
2. **Windows ↔ POSIX rendering divergence.** ADR-0365 declared the
   slice "should work" on Windows for the flock primitive. If the
   inspector ever DID surface a path, it would render
   `C:\Users\op\AppData\…` on Windows and `/home/op/.quanta/…` on
   POSIX — defeating the Codex parity goal (Codex output is POSIX
   shape regardless of host). Operators reading a forwarded log line
   would have to know which OS produced it before grep-ing.

The fix is two-part: (a) surface the backend's storage location in
`RegistryStats`, and (b) normalize the rendered form to POSIX so
Windows and POSIX outputs are byte-identical for the path.

## Decision

1. **Add `RegistryStats.path?: string`** — optional read-only field
   on the existing snapshot interface. Present for `disk` + `sqlite`
   backends; absent (`undefined`) for `in-memory` (which has no
   on-disk location).
2. **Normalize backslashes to forward slashes** in the inspector
   (`normalizePath: (p) => p.replace(/\\/g, "/")`). No other rewrite:
   no `~` expansion, no `path.resolve`, no `//` collapse — the
   inspector echoes the path it was handed, transformed only on the
   separator axis. Operators must be able to grep the rendered path
   against their config without surprise.
3. **Echo `path` on the unavailable branch** as well. A typo'd
   `QUANTA_SESSION_REGISTRY_SQLITE_PATH` produces `available: false`
   today — surfacing the (normalized) bad path lets the operator
   diagnose without a separate `printenv`.
4. **Formatter renders a `Path:` line** whenever `s.path !== undefined`.
   The line lives ABOVE the body so it survives the early-return on
   `!s.available`, matching the operator-debugging case where the
   path matters most.
5. **Backend wiring** — `inspectDiskRegistryByPath(storageDir)` and
   `inspectSqliteRegistryByPath(databasePath)` both call
   `normalizePath` once on the input and include it in every return
   branch. `inspectInMemoryRegistry` does NOT set `path` (no
   location).

## Closed-port read-only variant — justification

The `RegistryStats` interface is a closed shape consumed by:

- `src/agent/session-resource-registry/inspector.ts` (producer)
- `src/apps/cli/session-registry-cmd.ts` (consumer — calls
  `formatRegistryStats(s)` directly)
- `src/agent/session-resource-registry/__tests__/inspector.hellgate.test.ts`
  (consumer — constructs literals to test the formatter)

Adding a NEW optional readonly field is backward-compatible because:

- Consumers that spread / destructure existing fields keep working
  unchanged — the new field is simply ignored.
- Consumers that construct literals (the hellgate, in particular)
  do NOT need to add the field; `?` makes it optional at the type
  level.
- The producer adds the field in three places (two echo branches,
  one happy path) so no consumer ever sees a "partial" shape — the
  field is set whenever the backend has a path concept and absent
  whenever it does not.
- No public method on the closed `SessionResourceRegistry` port
  changes. The port stays byte-identical to ADR-0345. The inspector
  is a SIBLING of the port (memory `codex-session-jsonl-envelope`
  pattern — backend-specific reads via sibling functions, not port
  widening).

This is the same "read-only widening" pattern ADR-0218 (mode-typed
delegation) and ADR-0210 (3-way restore) used to add operator-facing
fields without re-opening a closed port.

## Non-goals

- **No `~` expansion.** An operator may be reading a forwarded
  config from another machine; rendering the literal preserves the
  forensic trail. `path.resolve` or `os.homedir()` would erase that
  signal.
- **No absolute → relative rewrite.** The operator needs an
  unambiguous handle they can paste into their own shell to inspect
  the same store.
- **No `//` collapse.** UNC paths (`\\server\share\…` on Windows) map
  to `//server/share/…` on the POSIX form — the doubled leading
  slash is meaningful. The current Codex SMB story is out of scope
  (ADR-0365 §Decision), but pre-collapsing here would silently
  break that future.
- **No drive-letter normalization.** `C:` stays `C:`; we do not
  lowercase it or rewrite it to `/c/`. Operators on WSL who paste
  a `/mnt/c/…` path get `/mnt/c/…` back; operators on native Windows
  who paste `C:\…` get `C:/…` back.
- **No mutation of the port.** The 5-method `SessionResourceRegistry`
  shape stays untouched.
- **No mutation of any composition root or loop.** This is a leaf
  slice — `inspector.ts` + the hellgate + this ADR. No
  `assemble.ts` / `loop.ts` / `prompt.ts` mutation.

## Implementation

```ts
// src/agent/session-resource-registry/inspector.ts

export interface RegistryStats {
  // …existing fields…
  readonly path?: string   // ADR-0377: POSIX-normalized backend location
}

const normalizePath = (p: string): string => {
  if (typeof p !== "string") return ""
  return p.replace(/\\/g, "/")
}

export const inspectDiskRegistryByPath = async (
  storageDir: string,
): Promise<RegistryStats> => {
  const path = normalizePath(storageDir)
  // …
  return { ...ZERO_DISK_STATS, path }   // unavailable branch
  // …
  return { backend: "disk", /* … */ path, available: true }
}

export const inspectSqliteRegistryByPath = async (
  databasePath: string,
): Promise<RegistryStats> => {
  const path = normalizePath(databasePath)
  // (mirrors disk wiring — both branches carry `path`)
}

export const formatRegistryStats = (s: RegistryStats): string => {
  // …title…
  if (s.path !== undefined) lines.push(`Path:            ${s.path}`)
  // …body…
}
```

## NO-THROW

`normalizePath` is total. The `typeof p !== "string"` guard is a
defence-in-depth check — the static type rules it out, but the
inspector is operator-facing and the slice's contract is
"NO-THROW" (memory `agent-loop-4way-comparison`: hardened harness
philosophy). On non-string input the helper returns `""` so the
caller still gets a `path` field of a known type.

## Hellgate

`src/agent/session-resource-registry/__tests__/inspector.hellgate.test.ts`
extended from 15 to 23 cases (+8 ADR-0377 cases):

- [16] disk path with backslashes → forward slashes only (Windows
  shape input on POSIX runner — readdir naturally fails, the path
  is still echoed on the unavailable branch).
- [17] disk path already forward-slash → unchanged.
- [18] disk path with mixed separators → all flipped.
- [19] sqlite path with backslashes → forward slashes only.
- [20] in-memory backend → `path` field absent.
- [21] formatter renders `Path:` line for disk.
- [22] formatter renders `Path:` line for sqlite.
- [23] formatter omits `Path:` line for in-memory.

## Backward compatibility

- Callers that spread the previous `RegistryStats` shape keep working
  byte-identically — `path` is optional so missing it is legal.
- The 15 existing hellgate cases continue to pass — none of them
  asserted on `path` and none of them constructed a literal that
  conflicts with the new field.
- The `/session-registry` slash command emits one extra line of
  output (the `Path:` line) when the backend is disk / sqlite.
  This is operator-facing additive behaviour, not a regression.

## Risk

Low. Closed-port read-only addition, narrow normalization, no IO
beyond what ADR-0370 already does. The most realistic failure mode
is "operator pastes a UNC path and is surprised the leading `\\` is
not collapsed" — addressed in §Non-goals.
