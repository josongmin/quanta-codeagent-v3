# quanta · GitHub integration

The `@/integrations/github` slice + `from-pr` CLI entry let a repo respond
to `@quanta` mentions on PRs without running any external service.

## Start here

- [SETUP.md](./SETUP.md) — 3-step install (copy workflow, add secret, mention).

## Architecture

- [ADR-0311](../../decisions/0311-github-actions-trigger-adapter.md) — Tier 0
  Actions adapter (this slice).
- [ADR-0312](../../decisions/0312-self-hosted-webhook-responder.md) — Tier 1
  webhook responder (future, separate slice).
- [ADR-0313](../../decisions/0313-polling-fallback-trigger.md) — Tier 2
  polling fallback.
- [ADR-0314](../../decisions/0314-mention-filter-trust-scope.md) — mention
  filter, trust-scope ladder, code-block injection guard.

## Slice files

- `src/integrations/github/types.ts` — closed-port types.
- `src/integrations/github/event-source-actions.ts` — GITHUB_EVENT_PATH
  reader + mention filter.
- `src/integrations/github/pr-context-loader.ts` — `gh pr view` wrapper.
- `src/integrations/github/pr-output-sink.ts` — `gh pr comment` wrapper.
- `src/integrations/github/index.ts` — barrel.

## CLI entry

- `src/apps/cli/from-pr-cmd.ts` — `runFromPrCmd` library entry (every IO
  injected; unit-testable without `gh`).
- `src/apps/cli/from-pr-cmd-adapters.ts` — production adapters
  (`node:fs/promises`, `Bun.spawn`, `@/security`).

## Workflow

- `.github/workflows/quanta-pr-bot.yml.template` — drop-in workflow file
  for end-user repos.

## Tests

- `tests/unit/apps/cli/from-pr-cmd.test.ts` — 15 cases covering default-OFF,
  happy path, redaction, idempotency, trust scope, code-block injection,
  abort.
- `tests/unit/apps/cli/from-pr-cmd-adapters.test.ts` — adapter thin-shape
  coverage (gh-CLI test skipped when `gh` is absent).
