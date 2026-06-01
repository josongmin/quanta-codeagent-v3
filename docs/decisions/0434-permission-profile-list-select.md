# ADR-0434 — PermissionProfile List + Select + user-defined profiles from disk

- Status: Accepted
- Date: 2026-06-02
- Slice: `src/permission/profile-list-select.ts` (leaf), `src/permission/index.ts` (barrel)
- Absorbs: Codex `PermissionProfile{List/Select/Apply/Resolve}`

## Context

ADR-0135 introduced the layered permission model and a named-profile registry
(`src/permission/named-profiles.ts`) holding three hard-coded built-ins —
`restricted` < `default` < `trusted`. That registry already covers two of the
four Codex profile verbs:

- **Resolve** — `resolveProfileByName(name)` maps a built-in name → its frozen
  `PermissionProfile` struct.
- **Apply** — `TwoLayerManager.setPermissionProfileByName(threadId, name)`
  registers a resolved profile for a thread (jun-02 wired this to the CLI flag
  + `QUANTA_PERMISSION_PROFILE` env).

Missing, relative to Codex's surface:

1. **List** — no verb to *enumerate* the available profiles (built-in or
   otherwise) with provenance + a human summary.
2. **Select** as a first-class verb — Resolve only handles the three built-in
   names and throws on anything else; there is no single entry point that
   accepts "any selectable name" (built-in OR user-defined).
3. **User-defined named profiles** — an operator could not author a bespoke
   named profile and have it discovered by name.

## Decision

Add a new leaf `profile-list-select.ts` that composes with — and never mutates
— the existing registry:

- **`listPermissionProfiles(opts?)`** → `ReadonlyArray<{name, source, summary}>`.
  Always returns the three built-ins (`source: "builtin"`); additionally
  enumerates user-defined `<name>.json` profiles discovered under a profiles
  dir, each `source: "user"`.
- **`selectPermissionProfile(name, opts?)`** → `Promise<PermissionProfile>`.
  A built-in name resolves byte-identically through `resolveProfileByName`
  (no disk IO). A user name loads + validates `<name>.json`. An unknown name
  throws the typed **`ProfileSelectError`** (carrying the available names) —
  never a permissive fallback.
- **Disk loading** — the profiles dir is the explicit `profilesDir` option,
  else `QUANTA_PROFILES_DIR`, else **none** (default-OFF: built-ins only, no
  disk IO, byte-identical to a bare registry enumeration). Each file is parsed
  by a strict structural validator (`parseUserProfile`) that rebuilds the
  struct field-by-field from validated primitives — malformed JSON, a missing
  pillar, a bogus enum, or unknown keys are **rejected** with the typed
  **`ProfileValidationError`** (never crashes, never applies a partial struct).

### Safety ceiling

A disk-loaded user profile is the **lowest-trust** source of policy in the
system (anyone who can drop a `.json` into `QUANTA_PROFILES_DIR`). It may
therefore be at most as permissive as the locked-down **`default`** built-in on
every security-relevant axis (network egress rank, workspace-write / read-only
exposure, network-isolation removal, prompt suppression). A profile that widens
past that ceiling is rejected (`ProfileValidationError`) **unless** the caller
opts in with `allowWiden: true`. The permissive `trusted` posture (network
allow-all + workspace write + no prompt) is thus never something a stray
on-disk file can grant itself; it remains an explicit operator decision.

### Built-in precedence

A built-in name is authoritative. A user file named `trusted.json` cannot
shadow the `trusted` built-in: Select returns the built-in, and List de-dupes
in favor of the built-in (with `onError: "throw"` it surfaces a collision
error). This prevents an on-disk file from silently overriding the canonical
profile semantics.

### List resilience

`onError` controls per-file failure handling during List: `"skip"` (default)
drops the offending file so valid siblings + built-ins still enumerate;
`"throw"` surfaces the first `ProfileValidationError` for strict callers.

## Alternatives considered

- **Ceiling = `trusted`** (the most-permissive built-in). Rejected: that would
  let an on-disk file grant network allow-all + workspace write with no prompt,
  which is exactly the high-trust posture we want to gate behind an explicit
  opt-in. `default` is the conservative, fail-toward-rejection choice.
- **Let user files shadow built-ins.** Rejected: a built-in profile is a
  security contract; allowing a disk file to redefine `trusted` is a trivial
  privilege-escalation vector.
- **Extend `named-profiles.ts` in place.** Rejected: that leaf is a pure,
  frozen, IO-free registry. Disk loading + a validator belong in a separate
  leaf so the registry's zero-IO invariant + slice fence stay intact.

## Consequences

- Default-OFF: absent `QUANTA_PROFILES_DIR` there is zero behavior change and
  zero disk IO — backward compatible.
- The new verbs compose with the existing Apply path: a caller can
  `selectPermissionProfile(name)` then hand the struct to
  `TwoLayerManager.setPermissionProfile`, or continue using the by-name Apply
  sugar for built-ins.
- Sealed by a 17-case hellgate
  (`__tests__/profile-list-select.hellgate.test.ts`) covering list/select,
  user-defined loading, typed errors, malformed-JSON rejection, the safety
  ceiling (default-reject + `allowWiden` admit), and byte-identical built-ins.
