# AGENT_REFERENCE.md — quick reference for quanta-codeagent-v3 agents

Use this with [AGENTS.md](AGENTS.md), not instead of it.

## Core files

- Guardrails: [AGENTS.md](AGENTS.md)
- Agent core: [AGENT_CORE.md](AGENT_CORE.md)
- Playbook: [AGENT_PLAYBOOK.md](AGENT_PLAYBOOK.md)
- Rule catalog: [AGENT_RULE_CATALOG.md](AGENT_RULE_CATALOG.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- ADR index: [docs/decisions/README.md](docs/decisions/README.md)
- Operator overview: [README.md](README.md)

## Preflight

- `scripts/check-persona-target-policy.sh --expect-agent`
- `scripts/cg-agent-session`
- recovery path:
  `scripts/cg-agent-session --exec -- scripts/check-persona-target-policy.sh --expect-agent`

## Preferred commands

- `bun test <path>`
- `bun run test:unit`
- `bun run test:integration`
- `bun run typecheck`
- `bunx @biomejs/biome check <paths>`
- `bun fc validate`
- `bun fc build`

## Audit / closeout checklist

- trace one real entry or consumer path
- identify the owner boundary
- prove the requested invariant on the exact rail used
- separate implemented vs partial honestly
- keep dirty or non-hermetic proof explicit
