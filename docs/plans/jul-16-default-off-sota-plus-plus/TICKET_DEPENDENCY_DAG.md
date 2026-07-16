# Ticket dependency DAG

```text
DOF-00 authority ledger ──> DOF-01 catalog parity ──> DOF-20 safe availability
        ├──────────────────────────────────────────> DOF-21 proof repair ──> DOF-22 behavioral A/B
        ├──────────────────────────────────────────> DOF-15 per-tool disposition
        ├──────────────────────────────────────────> DOF-30 seam disposition
        └──────────────────────────────────────────> DOF-40 partial hardening

DOF-05 web security ──> DOF-10 web flow ──> DOF-50 Tauri/platform hold
DOF-06 memory redaction
DOF-11 shipping CLI profile
DOF-12 prompt-suggestion state
DOF-13 read-outline parser
DOF-14 playbook registry

all non-hold leaves ──> DOF-90 closure audit
```

`DOF-05`, `06`, `11`, `12`, `13`, and `14` are independent owner seams and start immediately. Safe CLI flips do not wait for web closeout. Disposition precedes test investment: no W3-style proof bundle may be written for a seam whose keep/wire/hold target is unresolved.

Shared hot files serialize by owner: `surface-compose.ts`, `session-loop.ts`, `runtime-config.ts`, and `agent-arg-builder.ts`. Touching an allowlisted god-module includes the required decomposition work; do not grow the allowlist.
