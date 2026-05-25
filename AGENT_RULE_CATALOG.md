# AGENT_RULE_CATALOG.md — compact rule index for quanta-codeagent-v3 protocols

This file is an index, not a second source of truth.
If anything drifts from [AGENTS.md](AGENTS.md), `AGENTS.md` wins.

## Purpose

- Give protocols like `rr` / `ss` a stable lookup surface.
- Map short rule IDs to the owning repo file.
- Keep the catalog thin so re-anchor stays cheap.

## Authority order

1. [AGENTS.md](AGENTS.md)
2. [AGENT_CORE.md](AGENT_CORE.md)
3. [AGENT_PLAYBOOK.md](AGENT_PLAYBOOK.md)
4. [AGENT_REFERENCE.md](AGENT_REFERENCE.md)
5. [AGENT_RULE_CATALOG.md](AGENT_RULE_CATALOG.md)

## Rule catalog

| Rule ID | Owner | Meaning |
|---|---|---|
| `R-TRUTH-01` | [AGENT_CORE.md](AGENT_CORE.md) | Source, tests, and real call paths are primary truth. |
| `R-TRUTH-02` | [AGENT_CORE.md](AGENT_CORE.md) | No grep-only completion or review claims. |
| `R-TRUTH-03` | [AGENTS.md](AGENTS.md) | Feature catalog YAML is authoritative over generated markdown. |
| `R-ARCH-0303` | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Surfaces stay thin; no new cross-surface runtime imports. |
| `R-SLICE-031` | [AGENTS.md](AGENTS.md) | `@/agent` is the only slice allowed to cross-import lower slices. |
| `R-PROOF-01` | [AGENT_PLAYBOOK.md](AGENT_PLAYBOOK.md) | Verify narrow owner-local rails first, then broader rails. |
| `R-PROOF-02` | [AGENT_CORE.md](AGENT_CORE.md) | Missing proof stays partial, blocked, or unverified. |

## Usage notes

- Follow the owner file for full wording.
- If a protocol needs a new rule ID, extend this file in the same change.
