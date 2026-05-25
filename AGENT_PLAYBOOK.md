# AGENT_PLAYBOOK.md — execution playbook for quanta-codeagent-v3

This file is the step-by-step companion to [AGENT_CORE.md](AGENT_CORE.md).
If anything drifts from [AGENTS.md](AGENTS.md), follow `AGENTS.md`.

## Startup

1. Re-read [AGENTS.md](AGENTS.md).
2. Run `scripts/check-persona-target-policy.sh --expect-agent`.
3. Run `scripts/cg-agent-session`.
4. If direct-shell bootstrap looks suspect, validate via
   `scripts/cg-agent-session --exec -- scripts/check-persona-target-policy.sh --expect-agent`.
5. Freeze the authority boundary before patching.

## Work posture

- Probe first.
- Structure first.
- Test last.
- Fail closed.
- No silent fallback.

## Edit policy

- Preserve owner boundaries.
- Avoid unrelated refactors during fix work.
- Prefer thin routers and SSOT over duplicate helpers.
- Do not grow cross-surface runtime imports under `src/apps/**`.

## Verification order

1. narrow owner-local rail
2. touched-file formatting / lint rail
3. type rail
4. broader integration rail

If a broader rail is blocked by unrelated residue, say so explicitly and keep
the local proof separate.

## Progress ledger

For non-trivial work, keep:

- `prev`
- `curr`
- `next`
- `visited`
- `subprogress`
- `code_progress`
- `closeout_progress`

## Canonical references

- Guardrails: [AGENTS.md](AGENTS.md)
- Immutable core: [AGENT_CORE.md](AGENT_CORE.md)
- Quick commands: [AGENT_REFERENCE.md](AGENT_REFERENCE.md)
- Rule index: [AGENT_RULE_CATALOG.md](AGENT_RULE_CATALOG.md)
- Structural rules: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- ADR index: [docs/decisions/README.md](docs/decisions/README.md)
