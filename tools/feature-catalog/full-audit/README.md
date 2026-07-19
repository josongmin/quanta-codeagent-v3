# Feature catalog full audit

This directory is the executable ledger for the 2026-07-19 full audit of the
feature catalog. It keeps a frozen catalog snapshot separate from incremental,
per-feature audit results so parallel workers do not contend on one large YAML.

## Commands

```sh
bun fc:audit validate
bun fc:audit status
bun fc:audit queue --priority P0 --limit 25
bun fc:audit queue --section 3 --limit 25
bun fc:audit start <feature-id>
```

`snapshot.json` is frozen at the campaign authority HEAD. Do not regenerate it
to make a drift failure disappear. A new feature added during the campaign must
be explicitly incorporated by the campaign coordinator.

Audit result files live under `results/<catalog-directory>/<feature-id>.yaml`.
No file means `pending`; an `in-progress` file claims the feature for one worker;
a `closed` file must satisfy the strict schema in `schema.ts`.

## Proof rules

- A `pass` needs a live consumer, production reachability, and passing ON
  efficacy proof.
- A default-OFF `pass` also needs a separate passing OFF identity proof.
- `conditional` needs a concrete blocker or prerequisite.
- `seam-only` and `not-activatable` cannot claim production reachability.
- Every closed verdict carries source/test/runtime receipts tied to a revision.

The catalog YAML remains the feature-claim SSOT. This directory records whether
that claim survived the full audit at the frozen revision.
