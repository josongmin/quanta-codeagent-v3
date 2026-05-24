# Session closeout audit — 2026-05-25

## ADRs landed this session

ADR-0121 ~ ADR-0169 (~40+ shipped slices, with 5 ADR-number collisions reconciled in-table and 2 additional unresolved collisions on 0167/0168 between file-on-disk vs sibling-agent in-flight code).

## Wire closeout: full surface

- Fully wired: 14 ADRs
- Caller-wired (helper-only): 11 ADRs
- Internal (no slot needed): 4 ADRs
- This round closed 2 (web_search call + read_image_url defaults)

## Hellgate cases sealed: 1100+ (vs ~700 baseline before session)

## Catalog parity

- `docs/10.feature-catalog.md`: ADR inventory section extended from 0136-0166 to 0136-0169 (3 new observability entries: PlanQueue collapse metric / Prometheus recording rules / skipped-slice warning). In-flight section rewritten — sibling-agent code under ADR-0167 (coverage AST) and ADR-0168 (PII redaction) flagged as collision-pending against the ADR files on disk.
- `docs/decisions/README.md`: index extended to 0169. Existing collision audit trail (0155 / 0158 / 0159 / 0160 / 0163) preserved.
- `MEMORY.md`: +5 cluster pointers (wire-closeout-matrix-2026-05-24 + 4 dated 2026-05-25 slices: secret-and-pii / coverage-and-istanbul / subagent-replay / multi-plane-e2e-closeout).

## Outstanding (vendor-deferred / Phase 3)

- Foundry SDK (Anthropic-side ship — ADR-0163 scaffolded watcher)
- Linux Landlock napi-rs binding (Rust toolchain — ADR-0159 has external-binary fallback)
- Apple Virtualization framework FFI (Swift/Bun FFI — ADR-0160 has external-binary Lima/Apple-VZ adapters)
- Subagent conversation-replay continuation (Phase 2.5 shipped via `src/agent/subagent-resume/*`; tool-history replay Phase 3 deferred)

## Drift indicators

- ADR number collisions: **7 file-vs-file collisions** preserved across rounds (0068 + 0109 from prior sessions; 0155 / 0158 / 0159 / 0160 / 0163 added 2026-05-25 — all four ship live in `main` and are tracked in README.md collision audit table). **2 new code-vs-file collisions** on 0167 and 0168 between sibling-agent code in `src/observability/coverage/ast-source.ts` + `src/security/pii-redaction/*` and the ADR files on disk (`0167-plan-queue-collapse-metric.md` + `0168-prometheus-recording-rules.md`). These require renumbering when the sibling ADR files land — flagged in the catalog "In-flight" subsection.
- Catalog drift: 0 (after this round).
- Memory drift: 0.

## Methodology notes

- Pure docs round — no `src/**` or `tests/**` touched.
- Sibling agents on `src/agent/subagent-resume/*` + `src/observability/coverage/*` + `src/security/pii-redaction/*` were respected; their in-flight code is recognized in the catalog but does not have ADR files yet.
- The session brief specified "only 0068 + 0109" collisions; actual count was 7 file-vs-file plus 2 code-vs-file. The audit table in `docs/decisions/README.md` already captures the 7 file-vs-file collisions from the prior 2026-05-25 doc round.
