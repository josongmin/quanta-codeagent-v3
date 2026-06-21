# T-SEL-13 — executable-only early accept

## Goal

Remove static owner/family heuristics from early-accept and loop-stop authority. Clean early stop must require an
executed proof receipt.

## Files

- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/batch/eval/driver.ts`
- `tests/unit/selection-executor.test.ts`
- `tests/unit/runner/verify-select-driver-parity.test.ts`

## Implementation

- Remove static-owner stop authority from early accept:
  - `owners.size > 0`
  - `fullyInsideOwners(...)`
  - implicit `ownerCoverage`-style stop logic
- Keep generation diversity and family ordering intact; only the stop condition changes.
- Clean early accept may fire only when the candidate is admissible and has an executed proof receipt such as:
  - positive validated repro quorum
  - executed clean keep-green witness result according to the clean witness policy
- If executable proof is absent, continue search even when static owner/family evidence is strong.
- Emit explicit early-stop telemetry:
  - `earlyAccept.used`
  - `earlyAccept.reason`
  - `earlyAccept.receiptKind`

## Hellgate

- A candidate fully inside the owner set cannot early-accept without executed proof.
- A static root-owner/lifecycle-owner family hint cannot stop search by itself.
- A candidate with executed proof can early-accept even when static owner confidence is partial or conflicting.
- Early-stop behavior is deterministic across repeated runs on the same executed receipts.

## Done

- No clean early-accept path depends on static owner/family evidence alone.
- Clean loop-stop authority is executable-only.
- Telemetry makes every early stop auditable by receipt type.
