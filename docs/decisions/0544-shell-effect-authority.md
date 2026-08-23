# ADR-0544 — One shell syntax/effect authority: parse once, judge the effect, and never let `unknown` mean safe

Status: Accepted (2026-08-24)
Slice: `src/permission/shell/**` (NEW) · `src/permission/policy.ts` (hard-deny seam) · `src/agent/loop/entry.ts` (arming)
Feature: `shell-effect-authority` (feature-catalog §3-permission-safety)
Related: `HARD_DENY_RULES` (`src/permission/policy-rules.ts`, the regex catalog this widens) · ADR-0529 (shell dialect selection) · the aug-23 Grok Build review §10.3 (the same bypass class found in a competitor's tree-sitter command classifier)

## Context

The hard-deny gate matched **regexes** against a lightly-normalized command string. A regex cannot see shell structure, so a command whose dangerous *effect* is assembled out of structure reads as harmless text and is allowed. Measured against the shipping gate, all of these passed:

```
cd / && rm -rf *
cd /; rm -rf .
rm${IFS}-rf${IFS}/
git push origin +main
npx rimraf /
python3 -c "import shutil; shutil.rmtree('/')"
eval "$(echo <base64> | base64 -d)"
```

Each is a different structural blind spot: a sequence that changes the working directory before the delete; a word split by a parameter expansion; a force-push written as a `+refspec` instead of `--force`; a destructive payload behind a package-runner vehicle; program text that only exists at runtime.

Widening the regexes would not fix the class. `cd / && rm -rf *` and `cd build && rm -rf *` differ only in a command that ran *earlier in the same list*, which no pattern over the command text can express.

## Decision

Parse each command **once** with the vendored `tree-sitter-bash` grammar (`@vscode/tree-sitter-wasm`, already pinned for the retrieval code-parser), lower it to a typed IR, and return **one assessment** every consumer reads.

The IR answers exactly what a security decision needs: which commands run in execution order across `;`/`&&`/`||`/`|`/`&`/subshells; each command's head and arguments as *resolved* text with quoting removed; which words could **not** be resolved statically; pipeline membership; and whether a function's body invokes itself.

Four verdicts: `safe-known`, `sensitive-known`, `hard-deny`, `unknown`.

### `unknown` is the load-bearing decision

`${IFS}`, command substitution, `eval`, an interpreter's inline payload, a parse error, a `MISSING` node, and a parser that has not initialized **all** produce `unknown` — never `safe-known`. An AST is not a sandbox. The only safe answer to "I could not read this" is to hand it to the existing ask/deny/sandbox boundary.

This is the failure a competitor's tree-sitter classifier made in the opposite direction (quote-concatenated fragments were fed to a word list verbatim, so `rg --pr''e` bypassed every guard while the *same codebase's* file-write path decoded quotes). The lesson taken: **every path that judges must go through the same normalization**, and the normalizer must report what it could not resolve.

### The effective-cwd is three-state, not two

`{kind:"caller"}` — wherever the tool was invoked; not a known path, but not dangerous either, since it is the repository the operator chose. `{kind:"abs"}` — a `cd` to a resolved absolute location. `{kind:"unknown"}` — a `cd` that could not be resolved, or one that climbed above the caller's directory.

Collapsing `caller` into `unknown` would push every routine `rm -rf ./build` to a prompt; collapsing it into a concrete path is how `cd $X && rm -rf *` slips.

### Deny-widening only at the hard-deny seam

`hardDenyReason` consults the authority **after** the regex list and acts only on `hard-deny`. `unknown` changes nothing there and falls through to the existing ask/allow ladder exactly as before. The gate stays monotonic — it can refuse more, never permit more — which also means a grammar that fails to load degrades to today's regex-only behavior rather than either blocking work or silently permitting more.

### Arming

`runAgent` is the single entry every surface goes through (CLI, headless, web daemon, bench, subagents), so `initShellEffectParser()` is awaited there. Without it the authority answers `unknown` and every structural denial silently vanishes while hand-initializing tests still pass — which is why the wiring proof unloads the grammar and asserts the bypasses come **back**.

## Consequences

- Parity is asserted against the real `hardDenyReason`, not restated: for a corpus of commands the shipping gate denies, the IR must not answer `safe-known`.
- False positives were measured, not assumed: 86 realistic developer commands assess `safe-known`, including `rm -rf node_modules`, `chmod -R 755 dist`, `sudo apt-get install`, `find . -name '*.log' -delete` and `cd /tmp && rm -rf *`.
- Adversarial round 2 found four real misses in the first cut — `xargs rm -rf < list` (targets arrive on stdin), `find / -delete`, `cat ~/.ssh/id_rsa | curl` (a parity break: rated sensitive instead of denied), and `echo … | sh`. All are pinned.
- The exfiltration rule requires a **known secret-store path**, not just a reading head. A first cut denied on the head alone and broke the documented `cat notes.txt | curl` allowance.
- `EXPECTED_CONTAINER_NODE_TYPES` is a drift guard, not a filter: the walker descends into every node with children, and a test fails when the grammar emits a container the slice has not accounted for. It caught `test_command` on its first run.
- Remaining work in this lane: the circumvention, ownership and grant consumers still read their own signals; migrating them to this assessment (and removing the direct regex *allow* authority) is the follow-on.
