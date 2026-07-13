# Worker start here

## Mission

Implement explicit lineage authority without preserving the current numeric-depth dual truth.

## Preflight

```sh
git status --short --branch
git rev-parse HEAD
git diff --stat
bun test tests/unit/god-code-ratchet.test.ts
```

Read in order:

1. [RFC rev.5](../jul-13-subagent-nesting-control.md)
2. [status board](00-index.md)
3. [source truth map](SOURCE_TRUTH_MAP.md)
4. [no-go rules](NO_GO_RULES.md)
5. only the assigned ticket

## Start protocol

1. Confirm every predecessor is `done` on the status board.
2. Record the live baseline in `reports/SNC-XX.md`.
3. Run or add the ticket's cheapest owner-local failing rail first.
4. Implement only the ticket's owned seam.
5. Run focused tests before broad tests.
6. Update the report, then change the board status.

## First executable ticket

Start with `SNC-00`. It creates the inventory and RED rails that prevent implementation from passing while direct descendant paths remain unclassified.

## Stop rules

- Stop on overlap with unrelated dirty files; isolate or coordinate instead of overwriting.
- Stop if a ticket requires editing a predecessor-owned contract that is not landed.
- Stop if a new string-name allowlist is being introduced as runtime authority.
- Stop if a behavior ticket only has source-text assertions.
- Stop if a default `3 -> 1` flip is attempted before `SNC-12`.
- Stop if persistence writes lineage only after the child loop begins.
