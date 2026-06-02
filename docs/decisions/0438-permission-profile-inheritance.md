# ADR-0438 — Permission-profile inheritance (`extends` + cycle detection + Managed tagging)

- Status: Accepted
- Date: 2026-06-02
- RFC: `docs/plans/jun-2-misc/05-permission-profile-inheritance.md`
- Slice: `src/permission/profile-inheritance.ts` (new leaf), `src/permission/index.ts` (barrel), `src/permission/profile-list-select.ts` (`NETWORK_RANK` now exported for reuse)
- Absorbs: Codex `extends` chain + "permissions profile inheritance cycle detected" + `TaggedPermissionProfile::Managed/::External` (`.extracted_source/codex/_codex-rs-0.135-symbols.txt`)

## Context

The named-profile registry (ADR-0135 / `named-profiles.ts`) holds three frozen
built-ins — `restricted` < `default` < `trusted` — and the disk-loader
(ADR-0434 / `profile-list-select.ts`) admits user-authored `<name>.json`
profiles, but `parseUserProfile` requires **all five pillars** to be present.
There is no way to say "*`trusted` but with network locked down*" without
copy-pasting the entire `trusted` struct and editing one axis — zero reuse,
drift risk when the built-in changes, and no expression of "lay this base down,
then narrow one axis".

This is **distinct** from `profile-layer-merge.ts` (`mergeProfileLayers`), which
answers a different question: given per-user / per-repo / team-admin SLOT layers,
which SOURCE wins each field (source-precedence or most-restrictive). That is
*lateral* composition across provenance slots. This ADR is *vertical*
composition along an `extends` graph: a derived profile refines a named base.

## Decision

Add a new pure leaf `profile-inheritance.ts`:

- **`ProfileDefinition`** — a declarative profile where every pillar is
  *partial* and may carry `extends?: string | string[]` plus a provenance
  `tag?: "managed" | "external"` (unspecified ⇒ `external`).
- **`resolveProfileInheritance(name, registry, opts?)`** → a complete
  `PermissionProfile`. It folds the `extends` chain base → derived with
  **monotone-narrowing**: a derived profile may only ever NARROW a base, never
  widen it. "trusted but network deny-all" (narrowing) works; "restricted but
  network allow-all" (widening) is silently dropped (base value kept).
- The three built-ins keep working byte-identically: a name with no registry
  entry falls back to `builtins` (default `NAMED_PROFILES`) and is returned
  verbatim (same frozen reference). `resolveProfileByName` is **unchanged** —
  this is an additive, composable resolver, a separate entry point.

### Per-axis merge policy (the core)

Each axis combines `base` ⊓ `derived` by picking the **more restrictive** side
(LOWER permissiveness). Derived omitting an axis inherits the base.

| axis | field | rule |
|---|---|---|
| network | mode | MRW — narrower of `deny-all<allow-list<allow-all` (reuses `NETWORK_RANK`) |
| network | allowHosts | intersection (derived may only drop hosts); one-sided list wins |
| network | perRequestApproval | OR |
| approval | mode | MRW — stricter of `auto<once<session<always` |
| approval | promptUser | OR (suppressing a prompt is a widen) |
| fileSystem | type | MRW — `restricted<managed` (managed stronger) |
| fileSystem | entries | intersection — a derived entry survives only if a base entry COVERS it (path ancestor + access cover); omitted ⇒ inherit base; `[]` ⇒ deny all |
| sandbox | osSandbox | MRW — `none<active` (a host runs one; concrete kinds equal) |
| sandbox | readOnly | OR |
| sandbox | workspaceWrite | AND |
| sandbox | networkIsolated | OR |
| control | managedBy | MRW — `user<team<admin` |
| control | auditRequired | OR |

**Invariant (sealed by HELL-PI-11):** `resolve(child)` is never wider than
`resolve(base)` on any of the 13 axes — derived is always a SUBSET of base.

### Cycle / self-extend / unknown-base — fail-closed THROW

Resolution carries a call-local `visiting` path stack. A cycle (`A→B→A`),
self-extend (`A extends A`), or an `extends` naming a profile in neither the
registry nor `builtins` throws a typed **`ProfileInheritanceError`** with a
machine-readable `kind` (`cycle` / `self-extend` / `unknown-base` /
`managed-widen`). Never a silent permissive fallback. A call-local `cache`
memoizes resolved bases so diamonds / deep chains compute each base once.

### Managed ceiling (Codex `TaggedPermissionProfile`)

A base (or the definition itself) tagged `managed` imposes a CEILING the derived
result cannot exceed. A managed base does **not** participate in the establishing
fold — it contributes only its resolved profile as a ceiling (the meet of all
managed ancestors). After the result is built from the non-managed bases + own
fields, it is checked against the ceiling: `onManagedWiden: "clamp"` (default —
fail-safe, narrow the breaching axes back to the ceiling) or `"throw"` (strict
org mode — reject). This makes a widen of an org-imposed limit detectable rather
than silently absorbed by the merge.

### Config / knob — how a profile declares + selects `extends`

- **Struct field:** a `ProfileDefinition` declares `extends` (and optional
  `tag`) alongside any subset of the five pillars. A user-authored definition is
  a JSON object of the same shape (a future `parseUserProfileDefinition` partial
  parser, sibling to the strict `parseUserProfile`, would admit these from
  disk — left as a follow-up; the resolver itself is config-agnostic and
  consumes an in-memory `ProfileDefinitionRegistry` the caller builds).
- **Selection:** the caller assembles a `ProfileDefinitionRegistry` (built-in
  names resolve via `builtins`; definitions add `extends` graphs), then calls
  `resolveProfileInheritance(name, registry)` to obtain the concrete
  `PermissionProfile`. The resulting struct flows into the existing Apply path
  (`TwoLayerManager.setPermissionProfile`) unchanged.

## Alternatives considered

- **Union-merge (widen-friendly).** Rejected: a derived profile widening its
  base is a privilege-escalation vector. Monotone-narrowing only.
- **Inject the special-path resolver for entries intersection.** Rejected: the
  resolver carries IO ports, breaking purity. The intersection uses a
  resolver-FREE conservative comparison (same special `kind`, or literal
  absolute path ancestry; mixed special/path ⇒ drop the derived entry — always
  the safe, narrowing direction).
- **Reuse `mergeProfileLayers` / `PROFILE_RESTRICTIVENESS`.** Rejected for the
  fold: that engine answers source-precedence and deliberately leaves
  `fileSystem.entries` to source-precedence (no scalar safety order). Inheritance
  needs base entries preserved + intersected. We REUSE the shared `NETWORK_RANK`
  ordering and the same OS-sandbox equal-concrete-kinds decision, but implement
  the per-axis fold independently. The two modules are orthogonal and additive —
  no shared mutable state, no behavioral overlap.
- **Make `extends` mandatory on the envelope wire.** Rejected: backward-compat —
  `extends`/`tag` are optional additive fields; old sessions decode unchanged.

## Consequences

- **Default-OFF / byte-identical:** the three built-ins resolve to the same
  frozen `NAMED_PROFILES` structs (HELL-PI-14 asserts reference identity);
  `resolveProfileByName` is untouched; unknown names still fail-closed.
- **Pure / total / fail-closed:** no IO, no `Date.now`/`Math.random`, no global
  state; every input returns a complete profile or throws.
- **Slice-fenced:** leaf depending only on `permission-profile.ts`,
  `named-profiles.ts`, and the shared `NETWORK_RANK` const. No store / gate / IO.
- Sealed by a 17-case hellgate
  (`tests/unit/permission/profile-inheritance-hellgate.test.ts`): per-axis MRW
  both directions, entries intersection + access narrowing, cycle / self-extend /
  unknown-base throws, managed ceiling clamp + throw, the monotone-narrowing
  invariant over all 13 axes × 3 built-in bases, deep chain (N=20), diamond
  determinism, and byte-identical built-in regression.
