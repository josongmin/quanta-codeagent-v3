# ADR-0495: line-shift-tolerant lint delta

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - `src/agent/edit-repair-loop/lint-delta.ts` (`computeLintDeltaTolerant`)
  - `src/agent/edit-repair-loop/index.ts` (barrel)
  - Tests: `tests/unit/lint-delta-tolerant-hellgate.test.ts`
  - Extends: ADR-0472 (edit-repair-loop, `computeLintDelta`)
  - Absorbs: Claude Code 2.1.167 diagnostics line-tolerance (docs/plans/jun-7-draft-ide-integration-spec-claude.md §5)

## Context

ADR-0472 already ships per-edit diagnostic delta: `computeLintDelta(pre, post)` reports the diagnostics an
edit INTRODUCED (post − pre as a count multiset), keyed on `(file, line, code, message)` — column and
severity excluded so a column shift is not a false "new" lint. But LINE is part of the key: an edit that
inserts/removes lines renumbers every later diagnostic, so a pre-existing lint at L10→L11 fails the
exact-line match and is FALSELY reported as introduced. Claude Code guards this with a line-tolerance
window = |Δ lines in file|.

## Decision

Add a pure `computeLintDeltaTolerant(pre, post, lineShift)` alongside the existing function. Identity for
matching is `(file, code, message)` WITHOUT line; a `post` diagnostic is pre-existing iff an UNCONSUMED
`pre` diagnostic in the same group sits within `|lineShift|` lines (nearest-first, count-aware 1-for-1).
`lineShift` is the edit's net line delta (post total lines − pre total lines), supplied by the caller.

Property: `lineShift === 0` reproduces `computeLintDelta` exactly (line must match) — a strict SUPERSET,
safe to adopt behind a gate. NO-THROW: a non-finite / negative / fractional `lineShift` coerces to a
non-negative integer tolerance (`|trunc|`, NaN ⇒ 0).

## Default posture

Additive pure function — no behavior change to existing callers (they keep calling `computeLintDelta`).
Adopting the tolerant matcher in the live dispatch bracket is a gated one-line swap that also plumbs the
edit's line delta through the diagnostics adapter — the documented follow-up wire. Default-OFF until then.

## Correctness invariants (hellgate-proven)

1. PARITY: `lineShift=0` ≡ `computeLintDelta` (including the legacy line-move-is-new behavior).
2. The false-positive class is FIXED: a pre-existing lint shifted by the edit's line delta is NOT new.
3. A shift BEYOND the window IS reported (no over-suppression).
4. A genuinely new diagnostic (new message) IS reported even within the window.
5. Multiset 1-for-1 within the window; nearest-match consumes the closest pre.
6. NO-THROW on garbage `lineShift` (NaN / negative / float).

## ROI / tradeoff

Kills a real false-positive class (every edit that changes line count currently mis-blames the model for
pre-existing lints). Small, pure, fully proven; the live adoption is a low-risk gated swap.
