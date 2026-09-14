# quanta GitHub PR bot — setup

quanta can respond to `@quanta` (or `/quanta`) mentions on pull requests. The
**Tier 0** path uses GitHub Actions and ships in this repo as a workflow
template — no external server, no webhook host. (Tier 1, the GitHub App
webhook-host scaffold, is documented in ADR-0312 and lives in a separate
slice; this guide covers Tier 0 only.)

> **Status.** Runner file `src/apps/cli/from-pr-cmd-runner.ts` has landed.
> Workflow is install-ready end-to-end. The current ack-only round posts a
> Tier 0 acknowledgement; agent-loop wire-up (the actual review/fix
> response) is a follow-up sprint. `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
> in the workflow `env:` block are placeholders for that future wire and
> are NOT read by the current `from-pr-cmd-runner.ts` — only `GH_TOKEN`
> (auto-supplied by `${{ secrets.GITHUB_TOKEN }}`) is required today.

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

## 2. Add API key as a repo secret (forward-compat — not required today)

In your repo: **Settings → Secrets and variables → Actions → New repository
secret**. Add ONE of:

- `ANTHROPIC_API_KEY` (Claude provider)
- `OPENAI_API_KEY` (OpenAI provider)

The current ack-only round does NOT call an LLM, so these are unused right
now. They wire in when the agent-loop downstream lands. `GITHUB_TOKEN` is
auto-provided by GitHub Actions and is the only secret the bot reads today.

## 3. Mention the bot

Open a PR, then comment:

> `@quanta please review`

The bot acknowledges within ~30 seconds (Actions cold-start dominated). The
acknowledgement comment includes the PR title, branches, and a short excerpt
of the description — all run through the redaction layer first.

## Customisation

### Trigger phrases

Default: `@quanta` and `/quanta`. Override by adding flags to the `run:` line of
the `run quanta from-pr` step. These are CLI flags, not environment variables:

```yaml
- name: run quanta from-pr
  run: bun run src/apps/cli/from-pr-cmd-runner.ts --trigger-phrase "@quanta" --trigger-phrase "@my-bot"
```

`--trigger-phrase` is repeatable. The step runs the runner file directly: there is
no `quanta from-pr` subcommand in the installed CLI, and an earlier version of
this page that said so gave a command that exits 64.

The matcher is case-insensitive and whitespace-collapsing; phrases inside
fenced code blocks (` ``` … ``` `) or 4-space-indented blocks are ignored
(prompt-injection safe).

### Trust scope

Default: `collaborator`. Override with `--trust-scope`; the runner accepts exactly
`collaborator`, `member`, `owner` and `public` and exits 64 on anything else:

```yaml
- name: run quanta from-pr
  run: bun run src/apps/cli/from-pr-cmd-runner.ts --trust-scope owner
```

What each admits today (`src/integrations/github/mention-filter.ts`):

| scope | admits |
|---|---|
| `owner` | the repository owner (`author_association: OWNER`) |
| `member` | organization members (`MEMBER`) and the owner |
| `collaborator` | collaborators (`COLLABORATOR`), members and the owner |
| `public` | any non-bot account — use only in trusted private repos |

The sender's scope comes from the comment's `author_association`, and only when the
comment's author IS the sender. On an `edited` or `deleted` event someone else may be
acting on the comment, and anyone with write access can edit comments, so another
account's association never lends its rank. Before
2026-09-14 OWNER and MEMBER were folded into "collaborator" first, so `owner` and
`member` admitted nobody on a real comment; the table above is what the code does
now, and `tests/unit/integrations/github/mention-filter-trust-scope-hellgate.test.ts`
drives it through real payloads.

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
   passed with `--trigger-phrase` are honored by the in-process mention
   filter, NOT by the cheap workflow `if:` — extend the `if:` block too if
   you want the runner to start at all on a custom phrase.

## Local testing (without GitHub Actions)

You can drive the runner locally against a fixture event JSON. Bun auto-loads
`.env` from the current working directory, so put your token there:

```sh
# .env  (cwd of `bun run`)
GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# optional — only the agent-loop wire reads these
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
```

Then write a fake event JSON and run:

```sh
cat > /tmp/event.json <<'EOF'
{
  "action": "created",
  "issue": {
    "number": 42,
    "pull_request": { "html_url": "https://github.com/<you>/<repo>/pull/42" }
  },
  "repository": { "owner": { "login": "<you>" }, "name": "<repo>" },
  "sender": { "login": "<you>", "type": "User" },
  "comment": {
    "body": "@quanta please review",
    "author_association": "OWNER"
  }
}
EOF

QUANTA_GH_ACTIONS_TRIGGER=1 \
GITHUB_REPOSITORY="<you>/<repo>" \
GITHUB_EVENT_PATH=/tmp/event.json \
GITHUB_EVENT_NAME=issue_comment \
GITHUB_DELIVERY=local-dev-1 \
bun run src/apps/cli/from-pr-cmd-runner.ts --dry-run
```

`--dry-run` emits the redacted body to stdout instead of calling `gh pr
comment`. Drop the flag to post for real (requires `gh` authenticated against
the target repo).

CLI flags: `--repo`, `--pr`, `--trust-scope`, `--trigger-phrase` (repeatable),
`--allow-bots`, `--dry-run`. Run with `--help` for the full list.

## Related

- ADR-0311 (this Tier 0 design)
- ADR-0312 (Tier 1: GitHub App webhook-host scaffold — separate slice)
- ADR-0313 (PR output sink: mandatory redaction + idempotency marker)
- ADR-0314 (mention filter + trust scope)
