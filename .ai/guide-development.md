# guide-development.md — development guide router for quanta-codeagent-v3

This file is intentionally thin.
It exists so tools that expect `.ai/guide-development.md` can re-anchor
without inventing repo policy.

## Read in this order

1. [AGENTS.md](../AGENTS.md)
2. [AGENT_CORE.md](../AGENT_CORE.md)
3. [AGENT_PLAYBOOK.md](../AGENT_PLAYBOOK.md)
4. [AGENT_REFERENCE.md](../AGENT_REFERENCE.md)
5. [AGENT_RULE_CATALOG.md](../AGENT_RULE_CATALOG.md)
6. [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
7. [docs/decisions/README.md](../docs/decisions/README.md)
8. [README.md](../README.md)

## Default development flow

- run `scripts/check-persona-target-policy.sh --expect-agent`
- run `scripts/cg-agent-session`
- when validating bootstrap recovery, run
  `scripts/cg-agent-session --exec -- scripts/check-persona-target-policy.sh --expect-agent`
- trace one production path
- patch one owner-local seam
- verify with `bun test`, `bun run typecheck`, and `bunx @biomejs/biome check`

## Notes

- `AGENTS.md` is the truth for AI-agent behavior.
- `docs/ARCHITECTURE.md` is the truth for slice and surface placement.
