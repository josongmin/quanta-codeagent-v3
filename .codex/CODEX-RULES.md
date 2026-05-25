# CODEX-RULES.md — Codex-local execution rules for quanta-codeagent-v3

This file specializes Codex behavior for this repo.
If it conflicts with [AGENTS.md](../AGENTS.md), `AGENTS.md` wins.

## Core rules

- Treat source, tests, and real call paths as primary truth.
- Use `apply_patch` for manual edits.
- Prefer `rg` / `rg --files` for search.
- Prefer `bun` repo front doors for verification.
- Respect thin-surface and slice-fence rules from
  [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).
- Do not edit generated feature-catalog markdown directly; edit YAML and rebuild.
- Do not hide unresolved behavior behind fallback wording.

## Reporting

- Be explicit about proof rails and proof limits.
- If a seam is only narrowed, call it `partial`.
- If verification is local-only or non-hermetic, say that explicitly.

## Startup links

- [AGENT_CORE.md](../AGENT_CORE.md)
- [AGENT_PLAYBOOK.md](../AGENT_PLAYBOOK.md)
- [AGENT_REFERENCE.md](../AGENT_REFERENCE.md)
- [AGENT_RULE_CATALOG.md](../AGENT_RULE_CATALOG.md)
