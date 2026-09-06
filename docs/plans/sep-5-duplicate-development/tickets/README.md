# Sep-05 duplicate-development remediation — execution index

**Status:** COMPLETE IN WORKTREE — exact clean CI green; delivery commit pending
**Truth snapshot:** `59ad4f9b3850b89c0417ef3d12d0c27d64917ba1`
**Source audit:** `docs/bugbash/sep-05-duplicate-development.md`

This packet replaces the source audit's draft PR order. The source audit is useful
evidence, but several entries confuse a repeated primitive with a duplicated
contract, propose imports that violate the live slice fence, or prescribe a
source-regex rail that does not prove runtime behavior.

Copy/paste task handoffs are in the
[worker prompt pack](../prompts/README.md). Commit this currently untracked plan
packet before dispatching workers into fresh worktrees.

## Outcome

Close four production risks first:

1. `gh` subprocesses inherit different environment and termination policies.
2. automated PR comments do not all enforce redaction and retry safety.
3. redaction and secret detection disagree on named secret shapes.
4. ChatGPT OAuth refresh and token persistence are not one cross-process
   transaction.

Then remove only duplication with a clear canonical owner. Do not create generic
factories merely because two files contain similar control flow.

## Ticket graph

| ID | Packet | Scope | Depends on |
|---|---|---|---|
| [SEP5-00](../../sep-5-duplicate-audit/tickets/SEP5-00-audit-truth.md) | duplicate-audit | Correct the audit and freeze live facts | — |
| [SEP5-01](../../sep-5-gh-safety/tickets/SEP5-01-gh-execution-authority.md) | gh-safety | One `gh` process-execution authority | SEP5-00 |
| [SEP5-02](../../sep-5-gh-safety/tickets/SEP5-02-pr-comment-outbound-safety.md) | gh-safety | Mandatory outbound body safety; automation idempotency | SEP5-01, SEP5-03 |
| [SEP5-03](../../sep-5-secret-detection/tickets/SEP5-03-secret-detector-parity.md) | secret-detection | Three-plane behavioral corpus and signature coverage | SEP5-00 |
| [SEP5-04A](../../sep-5-oauth-transaction/tickets/SEP5-04A-private-atomic-token-write.md) | oauth-transaction | Unique, durable, private token-file commit | SEP5-00 |
| [SEP5-04B](../../sep-5-oauth-transaction/tickets/SEP5-04B-chatgpt-refresh-transaction.md) | oauth-transaction | Cross-process refresh transaction | SEP5-04A |
| [SEP5-05](../../sep-5-migration-decoder/tickets/SEP5-05-claude-config-decoder.md) | migration-decoder | One pure Claude MCP/hooks decoder | SEP5-00 |
| [SEP5-06](../../sep-5-mcp-naming/tickets/SEP5-06-mcp-naming-authority.md) | mcp-naming | One MCP identifier/name contract | SEP5-00 |
| [SEP5-07](../../sep-5-permission-validation/tickets/SEP5-07-permission-validator-authority.md) | permission-validation | One permission primitive decoder | SEP5-00 |
| [SEP5-08](../../sep-5-jsonrpc-envelope/tickets/SEP5-08-jsonrpc-envelope-core.md) | jsonrpc-envelope | Shared envelope types/guard; framing remains separate | SEP5-00 |
| [SEP5-09](../../sep-5-retrieval-authority/tickets/SEP5-09-retrieval-authority-retirement.md) | retrieval-authority | Retire or adapt the unconsumed legacy stack | SEP5-00 |
| [SEP5-10](../../sep-5-knob-authority/tickets/SEP5-10-knob-owner-burndown.md) | knob-authority | Classify and reduce raw env reads | SEP5-00 |
| [SEP5-11](../../sep-5-duplicate-audit/tickets/SEP5-11-deferred-and-closed-register.md) | duplicate-audit | Deferred and closed findings register | SEP5-00 |
| [SEP5-12](../../sep-5-test-ratchets/tickets/SEP5-12-test-ratchet-campaign.md) | test-ratchets | Non-vacuous RED/mutation/CI enrollment contract for every implementation ticket | SEP5-01…10 |

## Execution order

```text
SEP5-00
├── SEP5-01 ──┐
├── SEP5-03 ──┴─> SEP5-02
├── SEP5-04A ─> SEP5-04B
├── SEP5-05
├── SEP5-06
├── SEP5-07
├── SEP5-08
├── SEP5-09
├── SEP5-10
└── SEP5-12 (closes only after every implemented ticket is enrolled)
```

SEP5-01, SEP5-03, and SEP5-04A have disjoint production write sets and may run
in parallel. SEP5-02 starts after both SEP5-01 and SEP5-03: it touches
`ci-bot.ts` from SEP5-01 and consumes SEP5-03's shared secret corpus.

## Global implementation rules

- Freeze `HEAD`, `origin/main`, dirty paths, and claimed write sets before each
  ticket. The source SHA above is evidence, not permission to reuse stale test
  receipts after HEAD advances.
- Start from an owner-local behavioral RED. A regex that only proves an import,
  identifier, or comment exists is not sufficient.
- Every static inventory test must have a known-item floor and an injected
  negative control that fails for the mutated item.
- Do not add slice-boundary allowlists, god-code allowlist entries, or lint-debt
  ceilings to land these tickets.
- Preserve caller-specific contracts at adapters: result types, error policy,
  timeout, idempotency, and corruption handling are not incidental details.
- Do not delete a legacy path until current callers are zero by both `rg` and
  typecheck, and the replacement integration rail is green.

## Global proof ladder

Run ticket-local rails first, then:

```sh
bun run typecheck
bun run lint
bun run lint:debt
bun test tests/unit/god-code-ratchet.test.ts
git diff --check
bun run test:ci
```

The exact per-ticket test files, mutation controls, population floors, and CI
enrollment checks are frozen in [SEP5-12](../../sep-5-test-ratchets/tickets/SEP5-12-test-ratchet-campaign.md).
No implementation ticket is complete merely because its new test passes in
isolation.

If a ticket changes feature-catalog YAML, also run `bun fc validate`, `bun fc
build`, and commit the rebuilt `docs/10.feature-catalog.md`. None of these
tickets should edit that generated Markdown directly.

## Campaign definition of done

- All P1 runtime risks have a behavioral reproduction and a green production
  wiring test.
- Canonical owners are reachable from every intended consumer; old owners have
  no live caller.
- Full CI completes on the final exact HEAD with an exit/footer receipt.
- SEP5-00 is refreshed to the final code state and does not claim deferred work
  as implemented.

## Situation update — 2026-09-06

The final audit found three narrow defects in already-landed P1 implementations
and repaired them at their authority owners:

- GH abort/deadline termination now has one race-safe terminal latch.
- PR comment policies now enforce a strict final UTF-8 byte cap, including the
  mandatory automation marker.
- OAuth lock mutation is now exact-body CAS; unconditional stale overwrite and
  read-then-delete release are gone.

No new generic framework or parallel authority was introduced. The only
ratchet metadata change is `tools/dev/scan-reach-baseline.json` runner reach
`323 -> 322`, matching the previously deleted
`src/runner/assemble/retrieval.ts`; this lowers a stale floor rather than
relaxing a ceiling.

Owned proof is green: focused SEP5 `273/273`, relevant slice fences `39/39`,
typecheck, lint debt, god-code, feature-catalog validation, and a clean exact
synthetic full-suite receipt (`35/35`, 3850 files). The working-tree changes are
not committed, so the real branch HEAD remains
`54b704d12b91808733709e942593ec5304cb6df3` and must not inherit that synthetic
receipt.

The two repository-wide blockers discovered during closeout were also repaired:
the shared abortable sleep now closes its registration race and cleans both
timer/listener resources through one settle path, and the exact Astropy repo
override forces a cache-independent native editable rebuild after source reset.
The Astropy base+candidate rail passed three consecutive focused runs.

Final clean verification snapshot
`16a9349d22d90fac8a0838354084235ee9e05fb7` passed `bun run test:ci` with all
21 gates green, including full-suite 35/35, real-toolchain 41 pass / 2 visible
capability skips / 0 fail, web frontend 807/807, and contract 13/13. This SHA is
a detached verification commit. The real branch remains uncommitted, so final
delivery still requires committing the owned working-tree changes and rerunning
or reusing only a receipt bound to that resulting real HEAD.
