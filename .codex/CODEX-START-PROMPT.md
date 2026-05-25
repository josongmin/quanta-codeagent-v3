# CODEX-START-PROMPT.md — session bootstrap for quanta-codeagent-v3

Use this when context is thin.

## Bootstrap

1. Read [AGENTS.md](../AGENTS.md).
2. Read [AGENT_CORE.md](../AGENT_CORE.md).
3. Read [AGENT_RULE_CATALOG.md](../AGENT_RULE_CATALOG.md).
4. Read [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).
5. Run `scripts/check-persona-target-policy.sh --expect-agent`.
6. Run `scripts/cg-agent-session`.
7. If direct-shell bootstrap is suspect, run
   `scripts/cg-agent-session --exec -- scripts/check-persona-target-policy.sh --expect-agent`.

## Freeze before patching

Capture:

```text
request:
class:
authority:
invariants:
must_not_regress:
proof_rails:
```

## Execution defaults

- trace one real path
- patch the smallest owner-local seam
- verify narrow first, broad second
- fail closed on missing proof

## Closeout defaults

- changed
- verified
- remaining
- blockers or uncertainty
