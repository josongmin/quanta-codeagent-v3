# quanta GitHub PR bot — setup

quanta can respond to `@quanta` (or `/quanta`) mentions on pull requests. The
**Tier 0** path uses GitHub Actions and ships in this repo as a workflow
template — no external server, no webhook host. (Tier 1, the GitHub App
webhook-host scaffold, is documented in ADR-0312 and lives in a separate
slice; this guide covers Tier 0 only.)

> **Prerequisite (current status).** The workflow template targets the CLI
> runner file `src/apps/cli/from-pr-cmd-runner.ts`. That file is being
> wired in a follow-up sprint (see ADR-0311 "CLI registry option B"). The
> template itself is install-ready — copy + secret + mention all work — but
> until the runner file lands, the `run quanta from-pr` step exits non-zero
> with `module not found` and the workflow posts a one-line failure
> comment via the `report failure to PR` step. Track ADR-0311 follow-up
> for the unblock.

## 1. Install the workflow

Copy the workflow template into your repo:

```sh
mkdir -p .github/workflows
cp .github/workflows/quanta-pr-bot.yml.template .github/workflows/quanta.yml
git add .github/workflows/quanta.yml
git commit -m "ci: add quanta PR bot"
git push
```

The workflow is committed to your default branch; GitHub Actions picks it up
on the next event.

## 2. Add API key as a repo secret

In your repo: **Settings → Secrets and variables → Actions → New repository
secret**. Add ONE of:

- `ANTHROPIC_API_KEY` (Claude provider)
- `OPENAI_API_KEY` (OpenAI provider)

quanta picks the provider via the `LLM_PROVIDER` env var (default: anthropic
when ANTHROPIC_API_KEY is set, openai otherwise).

## 3. Mention the bot

Open a PR, then comment:

> `@quanta please review`

The bot acknowledges within ~30 seconds (Actions cold-start dominated). The
acknowledgement comment includes the PR title, branches, and a short excerpt
of the description — all run through the redaction layer first.

## Customisation

### Trigger phrases

Default: `@quanta` and `/quanta`. Override under the `env:` block of the
`respond` job:

```yaml
env:
  QUANTA_GH_TRIGGER_PHRASES: "@quanta,/quanta,@my-bot"
```

The matcher is case-insensitive and whitespace-collapsing; phrases inside
fenced code blocks (` ``` … ``` `) or 4-space-indented blocks are ignored
(prompt-injection safe).

### Trust scope

Default: `collaborator` — accepts comments from anyone with Triage / Write /
Maintain / Admin. Override:

```yaml
env:
  QUANTA_GH_TRUST_SCOPE: maintainer   # or owner | any-human
```

Use `any-human` only in trusted private repos — it accepts any
non-bot account.

## Security defaults

- **Bots are rejected.** `[bot]` suffix accounts and `user.type === "Bot"` are
  filtered out before any LLM call.
- **Redaction is mandatory.** Every body posted back to the PR is run through
  the secret-detection layer (ADR-0078) — known formats (Anthropic / OpenAI /
  GitHub PAT / AWS / GCP / etc.) are replaced with `[REDACTED:…]`
  placeholders.
- **Idempotency.** Re-running the same workflow on the same comment delivery
  emits zero triggers (the delivery id is dedup'd in-process; the Actions
  runner is one-shot so the dedup window equals the workflow run).
- **No code push.** The workflow uses `contents: read` only. The bot cannot
  write to your repo; it can only comment on PRs.

## Troubleshooting

1. **No reply on a fresh PR comment.** Open the workflow run in the Actions
   tab. If the run never started, your phrase is missing from the cheap
   pre-filter (`if:` block in the template). Edit the comment to include
   `@quanta`.
2. **Run started but skipped immediately.** Check the run logs for the
   `skipped:` event reason. Common reasons: `bot-sender`,
   `trust-scope-rejected`, `mention-in-code-block`.
3. **Run failed with `gh: not authenticated`.** Confirm the workflow's
   `permissions:` block grants `pull-requests: write` and that `GH_TOKEN` is
   set to `${{ secrets.GITHUB_TOKEN }}`.
4. **Run failed with `missing repo slug`.** The workflow injects
   `GITHUB_REPOSITORY` automatically; this error means the env was
   stripped — restore the default `env:` block from the template.
5. **`module not found: src/apps/cli/from-pr-cmd-runner.ts`.** The runner
   composition root has not landed yet (see the Prerequisite note at the
   top of this file). Until that ships, the workflow installs cleanly and
   the failure-reporter step posts a single comment per delivery — that is
   working as designed, the bot is awaiting the entry-point wire-up.
6. **Duplicate comments after a force-push.** The workflow uses
   `concurrency.cancel-in-progress: true`, so a force-push mid-run aborts
   the in-flight handler. If the marker was already stamped before the
   abort, the next run upgrades-in-place via the ADR-0313 PATCH path; no
   second comment is created. If you see two comments on the same delivery
   id, file a regression — the marker collision detector should make this
   impossible.
7. **`@quanta` mentioned but no reaction.** The case-insensitive `contains()`
   pre-filter only sees `@quanta` and `/quanta` by default. Custom phrases
   set via `QUANTA_GH_TRIGGER_PHRASES` are honored by the in-process mention
   filter, NOT by the cheap workflow `if:` — extend the `if:` block too if
   you want the runner to start at all on a custom phrase.

## Related

- ADR-0311 (this Tier 0 design)
- ADR-0312 (Tier 1: GitHub App webhook-host scaffold — separate slice)
- ADR-0313 (PR output sink: mandatory redaction + idempotency marker)
- ADR-0314 (mention filter + trust scope)
