# Execution Checklist

Use this file before, during, and after each ticket.

## Before starting a ticket

- read the target ticket fully
- read [NO_GO_RULES.md](./NO_GO_RULES.md)
- read [SOURCE_TRUTH_MAP.md](./SOURCE_TRUTH_MAP.md)
- capture current drift:

```sh
git status --short
git diff --stat
```

- capture the ticket baseline:

```sh
bun run typecheck
```

- run the ticket's baseline proof rails before editing when cheap enough
- create or prepare the matching closeout report file under `reports/`

## During implementation

- keep changes owner-local to the ticket's declared seam
- do not edit already-dirty surrounding files unless the ticket explicitly owns them
- do not replace structure work with new sync/parity tests
- if you need a new helper, decide first:
  - surface-only helper -> `src/apps/bench/**`
  - reusable runtime/helper -> below `src/apps/**`

## Before claiming done

- run every proof rail listed in the ticket
- record exact command results in the report
- capture remaining unrelated red separately
- verify that the ticket's "Definition of done" bullets are all met

## Closeout format

Use [reports/TEMPLATE.md](./reports/TEMPLATE.md).

## When to mark blocked

Mark the ticket `blocked` only if one of these is true:

- current surrounding drift makes the owner seam unsafe to edit without coordination
- required proof depends on unavailable external state or credentials
- the ticket's seam cannot be completed without first completing a missing earlier ticket

Otherwise, keep working or downgrade the claim to `partial`.
