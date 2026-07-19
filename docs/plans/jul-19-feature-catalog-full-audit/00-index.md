# Feature catalog full audit — execution SSOT

Authority snapshot: `9a12f7a855640a8be1e4654472766bbc445696ea`

The campaign audits every catalog claim statically and requires dynamic proof
for features with strong maturity, default-OFF activation, or existing
reachability debt. Generated catalog prose is not evidence by itself.

## Frozen denominator

| Priority | Count | Required proof |
| --- | ---: | --- |
| P0 | 28 | Existing reachability grandfather or missing code evidence; dynamic disposition first |
| P1 | 164 | Remaining default-OFF/CLI-seeded rows; ON efficacy and OFF identity |
| P2 | 551 | Remaining L4/L5 rows; production consumer and efficacy |
| P3 | 285 | Remaining L1-L3 rows; static claim/evidence audit, dynamic on anomaly |
| **Total** | **1028** | One verdict per feature |

P0/P1/P2 are disjoint queue priorities. The current dynamic-proof denominator
is 743. The default-OFF ledger denominator is 176 after adding the two live CLI
seed owners introduced before this snapshot.

## Wave 0 baseline

- `bun fc validate --strict`: 1028 features, all evidence resolved.
- `bun fc lint`: green; orphan Accepted ADR count reduced from 4 to 0.
- `bun fc diff`: green at the authority snapshot before this campaign's YAML edits.
- `default-off-ledger-checker`: `eligible=176 runtime_cli_seeds=30 unknown_surfaces=0 unknown_values=0`.
- Reachability baseline: removed stale `bug-fix-proposal-queue` grandfather;
  `pr-output-sink-redaction` remains because symbol-level dead-API proof still
  reproduces.
- Full-audit snapshot and queue are generated under
  `tools/feature-catalog/full-audit/`.

## Verdicts

`pass`, `conditional`, `seam-only`, `not-activatable`, `proof-gap`,
`stale-claim`, `duplicate`, or `removed`.

A verdict is not complete without the owner seam, entrypoint, activation,
producer, consumer, surface findings, failure posture, and revision-bound
receipts required by the full-audit schema.

## Execution order

1. Close all 28 P0 records.
2. Close P1 by owner seam, keeping default-OFF ON/OFF proof separate.
3. Close P2 by composition root and shared consumer.
4. Sweep P3 statically and promote anomalies to dynamic proof.
5. Independently review every non-pass verdict and run final catalog rails.

Start with [WORKER_START_HERE.md](WORKER_START_HERE.md). Use
[PACKET_TEMPLATE.md](PACKET_TEMPLATE.md) for each collision-free owner packet.
