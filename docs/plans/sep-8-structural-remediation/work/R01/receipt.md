# R01 receipt — F-07 / SEP7-D-11

package: R01 (W1-A)
finding IDs: F-07 (P1), SEP7-D-11 (P2)
source HEAD: `f5f4875799141068af73e604129c8b9a09f76007`
owner: W1-A worker R01
status: red-confirmed → implemented (not verified)

## Owner files changed

- `src/security/command-shape.ts` (new extract) — basename, compound `-c` clusters, pipeline/redirect/prefix split
- `src/security/sensitivity-classifier.ts` — command-shape owner uses the extract; interpreter eval calls `classifyCodeShape` (shared `CODE_ENV_ACCESS`)
- `src/stream/adapters/stdout.ts` — `tool_progress` and `renderInProgress` use `oneLine(redactStr(...))`

## Tests

- `tests/unit/security/sensitivity-classifier.test.ts` (existing)
- `tests/unit/stdout.test.ts` (existing)
- `tests/unit/sep8-remediation/r01/f07-command-shape-bypass.test.ts`
- `tests/unit/sep8-remediation/r01/f07-command-shape-ratchet.test.ts`
- `tests/unit/sep8-remediation/r01/d11-progress-redact-before-oneline.test.ts`
- `tests/integration/sep8-remediation/r01/f07-classify-redact-path.test.ts`

## Removed path

- Raw first-token head lookup (`/bin/bash` never matched `bash`)
- Exact-only `-c`/`-lc` flag set (compound `-xc` bypass)
- Interpreter `includes("process.env")` duplicate (missed `process["env"]`)
- Unsanitized `oneLine(event.message)` on `tool_progress` and `in_progress`

## Commands run

```
bun test tests/unit/sep8-remediation/r01/ \
  tests/unit/security/sensitivity-classifier.test.ts \
  tests/unit/stdout.test.ts \
  tests/integration/sep8-remediation/r01/
# RED: 10 fail / 58 pass (plus 1 error importing @/tool/bash — no worktree node_modules)
# GREEN: 75 pass / 0 fail

bunx @biomejs/biome check <owner + test files>
# PASS (complexity split so classifySimpleCommand stays under 15)

bun docs/plans/sep-8-structural-remediation/verify-waves.mjs --group R01 <all written paths>
# PASS
```

Environment: isolated worktree `/Users/songmin/quanta-codeagent-v3-w1-r01` (no local `node_modules`). Product tests that do not import `zod`/`typescript` ran under bun.

## RED cause

At HEAD, `classifyCommandShape` returned `public` for all six audit families:

- `/bin/bash -c printenv`
- `zsh -c printenv`
- `bash -xc printenv`
- `bash -c "printenv 2>&1"`
- `bash -c "printenv | cat"`
- `node -e 'console.log(process["env"])'`

`bash -c printenv` and `node -e 'console.log(process.env)'` were already `secret`. Layer-2 format regex left synthetic `SYNTH_ENV_NOT_A_FORMAT_SECRET_9f3a` intact.

Stdout `tool_progress` / `in_progress` rendered `ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345` verbatim. The D-11.4 checker reported both progress sites using `oneLine(` without `redactStr(`.

## GREEN result

All six families + nested wrapper/prefix/redirect classify `secret`. Benign controls stay `public`: `bash -c echo hi`, `env FOO=1`, `printenv HOME`, `bash script.sh`.

F-07.4 **on integrated `main`:** live `makeBashTool().classifySource` → `dispatchTool` preview replaces the dump with `[REDACTED:source_class_secret]`; synth `SYNTH_ENV_NOT_A_FORMAT_SECRET_9f3a` is absent. Rail: `tests/integration/sep8-remediation/r01/f07-classify-redact-path.test.ts`. Layer-2-only pass keeps the synth. Worker-local worktree originally scanned `src/tool/bash/index.ts` (`classifyCommandShape(input.command`) because `zod` import failed; that scan is no longer the completion evidence.

Follow-up unwraps (same owner, same HEAD): utility prefixes (`eval`/`command`/`builtin`/`nice`/`nohup`/`time`/`sudo`/`xargs`/`watch`/`busybox`/`timeout`/`stdbuf`), `ruby -e` + `ENV`, command substitution (`$(printenv)`, backticks) on the **raw cmd**, `perl -e` / `php -r` / `deno eval`. Unknown `-c` unwraps only if the payload classifies secret (`dash -c printenv` secret; `gcc -c foo.c` public). PHP `-r` is not in the global interpreter-eval flag set (`node -r` is require).

Stdout progress: raw ghp_ token absent, `***REDACTED***` present, tool name / thinking / 40% / benign path still render.

## Mutation result

- F-07 ratchet: anti-vacuum ≥3 hits (zsh wrapper set, `executableBasename(`, `classifyCodeShape(`). Clone dropping `"zsh"` or restoring `includes("process.env")` fails. Mutation is not applied to live files.
- SEP7-D-11.4: anti-vacuum ≥2 progress sites. Live file requires `oneLine(redactStr(` on each. Clone dropping `redactStr(` from one site, or replacing it with a bare `/* redactStr */` identifier, fails the checker.

## Remaining proof gap

- W7 `verified` is not claimed. Global `prepush` is not a W1 closeout.
- JSONL disk persist of a spawned bash dump is not a closeout rail; dispatch `preview`/`block.content` is the proven model-facing sink.
- Nested `$()` uses first `)`. Unlisted language REPLs stay inventory-out.
- `response_queued` hint is still `oneLine` without `redactStr` (out of SEP7-D-11 finding scope: the two progress fields only).
- Supported shells are `bash|sh|zsh` only. Not a POSIX parser.

## Integration-delta

none
