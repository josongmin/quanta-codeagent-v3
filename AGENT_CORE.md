# AGENT_CORE.md — immutable bootstrap core for quanta-codeagent-v3

This file is the thin core companion to [AGENTS.md](AGENTS.md).
If anything conflicts, `AGENTS.md` wins.

## Purpose

- Freeze the non-negotiable execution contract for AI coding agents.
- Keep the mandatory re-anchor short enough for `rr` / `ss` / closeout work.
- Route deeper structural rules to [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
  and decision history to [docs/decisions/README.md](docs/decisions/README.md).

## Authority order

1. [AGENTS.md](AGENTS.md)
2. [AGENT_CORE.md](AGENT_CORE.md)
3. [AGENT_PLAYBOOK.md](AGENT_PLAYBOOK.md)
4. [AGENT_REFERENCE.md](AGENT_REFERENCE.md)
5. [AGENT_RULE_CATALOG.md](AGENT_RULE_CATALOG.md)
6. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
7. [docs/decisions/README.md](docs/decisions/README.md)
8. [README.md](README.md)

## Non-negotiables

- Source, tests, and real call paths are truth. Docs are supporting evidence.
- No grep-only completion or review claims.
- No silent fallback, compatibility shim, or dual-truth closure claim.
- Thin-surface and slice-fence rules from ADR-0303 / Architecture are live
  constraints, not style advice.
- Dirty or non-hermetic evidence must stay explicit in closeout.

## Required proof for implementation claims

Before calling a seam implemented or closed, establish:

- one owning authority boundary
- one real entry or consumer path
- mutate / consume proof or explicit absence proof
- the exact verification rail used
- blocked or missing proof called out literally

If any item is missing, report `partial`, `blocked`, or `unverified`.

## Canonical command front doors

- `bun run typecheck`
- `bun test <path>`
- `bun run test:unit`
- `bun run test:integration`
- `bunx @biomejs/biome check <paths>`
- `bun fc validate`
- `bun fc build`

## Reporting floor

At closeout, include:

- what changed
- what was verified
- what remains
- any blocker or proof limit
