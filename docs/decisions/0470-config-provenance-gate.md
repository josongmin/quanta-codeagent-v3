# ADR-0470 — Config-provenance gate (repo-controllable config may only narrow)

Status: Accepted (slice landed default-ON; merge-seam wiring held for human)
Date: 2026-06-03
Security: 🔴 privilege-escalation / supply-chain

## Context

`src/permission/policy-layers/index.ts` is the layered config merge engine. It
ranks sources `team-admin > per-repo > per-user > default` and, under the
`source-precedence` strategy, the most-authoritative source that SETS a field
wins it. That ranking is correct for ADMIN policy (an org admin SHOULD out-rank
a user) but it is a **privilege-escalation / supply-chain hole** for
REPO-controllable sources.

A `per-repo` layer is anything an attacker can check into a repository: a
`.quanta` / `.cursor` policy file, or an agent/skill **frontmatter** block.
Because `per-repo` out-ranks `per-user`, a clone of a hostile repo can silently
out-vote the user's own config on a **grant-capable** field — e.g. grant itself
`approval.mode:"auto"` (AFK auto-approve), widen the network egress / allow-list,
or strip the OS sandbox. The user never consented to any of this; merely opening
the repo applies it.

Defense-in-depth from a repo is fine — a repo making the posture MORE
restrictive is always safe. The asymmetry we need is exactly the one
`exceedsCeiling` (`profile-list-select.ts`) already encodes for disk-loaded
profiles: **a low-trust source may only narrow, never widen, the safe baseline.**

## Decision

Add a PURE pre-merge filter `guardProvenance` (new file
`src/permission/policy-layers/provenance-guard.ts`) that runs BEFORE
`mergeLayered`. For each repo-controllable layer (`per-repo` / `frontmatter`), it
DROPS any contribution to a grant-capable pillar that would WIDEN that axis
relative to the **trusted baseline** (the widest value any `per-user` /
`team-admin` / `default` layer sets for the field; absent a trusted setter, the
narrowest-possible value for the field — a repo cannot bootstrap a grant from
nothing). Repo contributions that match or narrow are KEPT.

- **Closed grant-capable set**: `approval`, `network`, `sandbox`. `fileSystem`
  (governed by the entry-coverage ceiling) and `control` are not GRANT axes.
- **Polarity reuse (no magic literal)**: the "what is a widen" per axis reuses
  the SSOT polarities `NETWORK_RANK` / `APPROVAL_RANK` (and the osSandbox
  presence polarity) from `profile-list-select.ts`. `approval.mode:"auto"` is the
  AFK auto-approve and is the widest; `promptUser:false` is an independent
  loosening axis; network `allowHosts` set-append is a separate widen the scalar
  rank cannot see (`allow-list-widen`).
- **Typed telemetry, returned not emitted**: one `ProvenanceDropRecord`
  `{kind, field, source, detail}` per dropped contribution. The guard returns
  them; the composition root owns the sink (port inversion).
- **Security defaults ON**: a security control that ships OFF protects nobody.
  The ONLY disable path is an EXPLICIT typed `acknowledgedRisk:true` opt-out
  (mirrors the ADR-0078 redaction opt-out) — never an env var (a hostile repo
  could also set env). With the guard ON and no widens present, the output layer
  list is the SAME array reference as the input ⇒ the downstream merge is
  byte-identical to today.

## Negative invariants

1. A `per-repo` / `frontmatter` widen on `approval` / `network` / `sandbox` is
   ALWAYS dropped (auto-mode, approval loosening, prompt suppression, egress
   widen, allow-list host append, sandbox loosening).
2. A `per-user` / `team-admin` / `default` grant is NEVER dropped (full grant
   authority retained).
3. A `per-repo` MORE-restrictive contribution is NEVER dropped
   (defense-in-depth is safe).
4. The guard is PURE: no IO, no env read, no throw, deterministic.
5. `acknowledgedRisk:true` is the only disable; absent/false ⇒ ON.
6. Nothing-to-drop ⇒ reference-identical output ⇒ byte-identical merge.

## Integration (held for human — fenced files)

Wired at the merge seam in `src/permission/policy-layers/index.ts` (call the
guard on the layer list before `mergeLayered`) and the telemetry sink. Exact
edits in the implementation report `integrationTodos`.

## Alternatives rejected

- **Re-rank `per-repo` below `per-user` globally**: breaks the legitimate
  most-restrictive merge (a repo SHOULD be able to tighten) and admin intent.
  The asymmetry must be field-polarity-aware, not a flat rank swap.
- **Env-gate the guard**: a security default that ships OFF is useless and an
  env var is itself attacker-settable in CI.
