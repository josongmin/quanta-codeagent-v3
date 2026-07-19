# Worker start here

## Claim a feature

```sh
bun fc:audit queue --priority P0 --limit 25
bun fc:audit start <feature-id>
```

Work from the authority snapshot recorded in `snapshot.json`. One worker owns
one result file and one owner seam at a time. Shared composition roots are
coordinator-owned.

## Audit sequence

1. Read the feature YAML, but treat it as the claim under test.
2. Resolve the real owner module and production entrypoint.
3. Trace activation through env/config/preset/port to the composition root.
4. Identify a concrete producer and live consumer.
5. Prove production reachability; an exported type or registry row is not enough.
6. Run the cheapest owner-local proof that observes the claimed effect.
7. For default-OFF rows, prove OFF byte identity separately from ON efficacy.
8. Inspect failure, cleanup, cancellation, security, and observability posture.
9. Close the result with revision-bound receipts and an independent reviewer.

## Stop conditions

- No consumer: stop and classify `seam-only` or `not-activatable`.
- Intentional docs/eval/CI-governance artifact: classify `non-runtime`; do not
  invent a production consumer to obtain `pass`.
- Evidence path is unrelated: classify `stale-claim`; do not launder it with a
  nearby passing test.
- External prerequisite unavailable: classify `conditional` with an exact
  prerequisite and recheck command.
- Duplicate implementation owner: classify `duplicate` and name the canonical
  feature before deleting anything.
- Shared-owner defect: freeze dependent records and repair the owner once.

## Required rails

```sh
bun fc:audit validate
bun fc validate --strict
bun fc lint
bun fc build
bun fc diff
```

Run focused tests cited by the feature. Do not represent compile-only, a
grandfathered reachability result, or a historical receipt as current runtime
proof.
