# quanta GitHub PR bot — setup

quanta can respond to `@quanta` (or `/quanta`) mentions on pull requests. The
**Tier 0** path uses GitHub Actions and ships in this repo as a workflow
template — no external server, no webhook host. (Tier 1, a self-hosted
webhook responder, is documented in ADR-0312 and lives in a separate slice;
this guide covers Tier 0 only.)

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

## Related

- ADR-0311 (this Tier 0 design)
- ADR-0312 (Tier 1: self-hosted webhook — separate slice)
- ADR-0313 (Tier 2: polling fallback)
- ADR-0314 (mention filter + trust scope)
