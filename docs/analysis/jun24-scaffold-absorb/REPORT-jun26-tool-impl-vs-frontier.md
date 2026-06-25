# 도구 구현 vs 프론티어(Claude/Codex/Cursor) 어딧 — 8 패밀리 (2026-06-26)

9에이전트 병렬, 양쪽 file:line 실증. 종합단계가 핵심버그 verbatim 재검증.

---

Confirmed. The pytest bug is real: `summary[]` collects both `FAILED` and `ERROR` lines (line 271 regex), but `blockLocs[]` only walks the FAILURES section and `break`s at the ERRORS header (line 290-291), so `summary.map((s,i)=>blockLocs[i])` zips the wrong block to error entries. The sandbox-wire grep returned empty (the audit cited `sandbox-wire.ts:68-69`; the exact lines may have shifted but the per-call linux bug at line 146 is confirmed verbatim). All other spot-checks match the audit. Producing the scorecard.

# Agent Tooling Audit — Frontier Scorecard (8 families)

## 1) Capability × Packaging Matrix

| Family | Capability | wiredStatus | One-line basis (file:line) |
|---|---|---|---|
| **LSP code-nav (10 tools)** | **ABOVE** | **default-OFF** | Real two-hop call-hierarchy `base.ts:725-746`; no frontier agent exposes semantic LSP nav to the model (codex-cli/codex.js=0 hits). Gated `agent-arg-builder.ts:194` (`QUANTA_LSP_TOOLS==='full'` only). |
| **DAP live debugger (`debug_inspect`, 5 langs)** | **ABOVE** | **default-OFF** | Real debugpy launch-deferral handled `inspect-driver.ts:218-229`, 21/0 live e2e vs debugpy 1.8.21. No frontier agent ships a runtime debugger as an LLM tool. Gated `tool/index.ts:767` (`QUANTA_DEBUG_TOOLS`). |
| **Semantic search + embeddings** | **MIXED** (ABOVE vs Claude/Codex, components ≥Cursor) | **default-OFF** | Real Voyage embed `voyage-embedder.ts:53` + rerank-2 + 4 vector stores; but semantic needs `QUANTA_INDEX` (`search-pipeline.ts:304`) and falls back to 64-dim hash-BoW `search-index-backend.ts:94`. Out-of-box = ripgrep+hash, not Cursor-grade. |
| **OS sandbox (Seatbelt/Landlock/bwrap)** | **MIXED** (AT-PAR→ABOVE macOS) | **default-OFF** | Real SBPL compiler `seatbelt.ts:70-111` + Codex-baseline parity fixture + per-call read-only layer Codex lacks. But `QUANTA_SANDBOX` default installs nothing; Codex ships sandbox-ON. |
| **MCP client + connector discovery** | **MIXED** (client AT-PAR→ABOVE; discovery BELOW) | client **default-ON**, discovery **default-OFF** | Client full JSON-RPC + inbound-DoS cap `client.ts:74`, real-spawned `internal.ts:573`. Discovery: REST registry built (`rest-registry.ts`) but unconsumed — only hardcoded 4-entry catalog reachable. Claude live-queries remote registry (`search_mcp_registry`). |
| **Subagent spawn (8 mech / ~31 tools)** | **ABOVE** (capability); packaging BELOW | **default-ON** | Richer than Claude's single Task: per-child model/worktree/fork_turns, real `maxDepth=3` `subagent-runner.ts:96`. But mailbox+team+objective default-ON & engagement-UNVERIFIED (`manifest.ts:228/238/247`). |
| **Edit/patch + test-output parser** | **MIXED** (edit AT-PAR→ABOVE; parser AT-PAR) | **default-OFF** (fuzzy) | 4-rung fuzzy ladder w/ scored strict-max > Codex's 3-rung; but `fuzzy:false` default & no auto-escalate (`edit/index.ts:19`) while Claude/Codex auto-retry whitespace-tolerant. |
| **CDP browser + git-compose + Evidence Packet** | **MIXED** (browser AT-PAR+security edge; Evidence ABOVE) | **default-OFF** | Code-enforced closed CDP allowlist `cdp-allowlist.ts` + out-of-band refs > Cursor's prose-only/DOM-pollution. Evidence Packet (test+LSP+DAP+git fusion) = no frontier equivalent — but all three default-OFF & bench-excluded. |

## 2) "SOTA++ capability, self-hidden by default-OFF / placeholder / sprawl"

These are the real story — built beyond frontier, then shipped dark:

- **LSP call-hierarchy + workspace/document symbol** — genuinely beyond-frontier (no competitor surfaces semantic nav to the model), invisible on every default surface (`QUANTA_LSP_TOOLS!=full`). Caveat: `references` is *measured* intractable on big repos (manifest.ts:897, sympy timeout @15s+60s), so a blanket flip would regress — split the cheap index-backed ops (call-hierarchy/symbols) ON, keep `references`/`implementation` opt-in.
- **DAP live debugger** — a true moat (proven 21/0 e2e), never seen by the model (`QUANTA_DEBUG_TOOLS` off). HITL already governs every call, so default-ON is safe.
- **Evidence Packet** — quanta's most original primitive (one-shot test+LSP+DAP+git fusion, no frontier counterpart) is default-OFF *and bench-excluded*, so the single biggest differentiator is entirely unmeasured.
- **Semantic search SOTA path** — Voyage embed + rerank-2 + Lance/Qdrant all real, but zero defaults route to them; box-fresh experience is ripgrep + 64-dim hash-BoW (not real semantic).
- **Connector discovery** — full REST-registry/marketplace/OAuth-DCR adapters built (`rest-registry.ts`, `connector-marketplace.ts`) with zero production consumers; only a hardcoded 4-entry list is reachable. Self-admitted "wire-up is a follow-up ADR."
- **OS sandbox** — compilers + parity fixtures + degrade plumbing all built and tested; the cheap part (flip the default) is the only gap. Codex ships it ON; we ship the engine cold.
- **Edit fuzzy ladder** — 4-rung ladder richer than Codex's documented 3, but nothing auto-escalates on exact-miss (frontier does it automatically).

## 3) Real robustness bugs (file:line)

1. **`src/tool/testrun/parse.ts:271+290+310` — pytest FAILURES+ERRORS index mispairing (VERIFIED).** `summary[]` collects both `FAILED` and `ERROR` lines, but `blockLocs[]` `break`s at the ERRORS header (line 291), so `summary.map((s,i)=>blockLocs[i])` zips a FAILURES block's `file:line` onto an ERROR entry → confidently-wrong localization. pytest is the SWE-bench primary, so this poisons the Evidence Packet on a common shape. Fix: key blockLocs by parsed test name, not array index. Add a mixed failures+errors fixture (current tests only cover pure-FAILURES / pure-ERRORS).
2. **`src/runtime/os-sandbox/per-call.ts:146` — Linux per-call sandbox always `supported:false` (VERIFIED).** ADR-0295 read-mode bash hard-fails to `sandbox_unavailable` on Linux even when bwrap/landlock are installed; the headline per-call feature is macOS-only — inert on the Linux bench boxes where it matters. Fix: reuse `detectLinuxSandboxBackend` in the factory.
3. **`src/runtime/os-sandbox/landlock-cli.ts` + `sandbox-wire.ts:180` — landlock-cli network deny silently dropped.** `--network-deferred` sentinel is filtered out before spawn; "network denied" policy runs with network UNenforced (degradeReason surfaced, but a real enforcement hole vs Codex's seccomp). Mitigated only because bwrap wins auto-detect when present.
4. **`src/host/runtime/mcp-connector-wire.ts:67` — http connector install writes malformed `.mcp.json`.** http entries (`command:[]`) yield `command:""`, which the stdio/http discriminator misreads. Latent (0 http entries bundled today) but breaks the moment a host injects the documented http catalog. Fix: omit the `command` key on the http branch.
5. **`src/browser/cdp/collect.ts:40` — visibility fail-open.** `visible()` checks the element's own `display/visibility` but not ancestor `display:none`; hidden subtrees get emitted as clickable (Cursor walks parents). Plus `collect.ts:31` accName over-captures 200 chars of descendant textContent on container nodes → snapshot noise.
6. **`src/tool/testrun/parse.ts:235` — parseNodeTest loc/message zip by document order** (acknowledged limitation): name↔frame desync swaps file:line on >1-failure node/jest/vitest runs. Defensible frontier-parity choice; leave.
7. **`src/tool/debug/tool.ts` — advertised Go/dlv goroutine dump is unreachable** through the tool's own `execute()` (no dlv preset, TCP transport never invoked) — capability-claim vs wiring mismatch, not a crash.

## 4) ROI-ranked fixes (almost all wiring/defaults — not new builds)

1. **Fix pytest parser mispairing** (`parse.ts`, ~15 LOC + 1 fixture) — kills confidently-wrong localization in the Evidence Packet on SWE-bench's primary runner. Pure correctness, highest ROI.
2. **Flip OS sandbox default → `workspace-write`** (1-line + byte-identity hellgate update) — closes the single biggest gap to Codex (sandbox-on-by-default); all compilers/plumbing/parity already exist.
3. **Default-ON DAP debugger + Evidence Packet for an agentless-bench A/B** — both proven/built, both dark; HITL already gates the debugger. Measures quanta's two biggest original moats for the first time (respect measure-first: A/B, don't blanket-flip from n=1).
4. **Wire connector discovery to the REST registry** (swap `BUNDLED` for `createRestConnectorRegistry` at the existing `catalog` seam, ~1 wire) — reaches Claude's `search_mcp_registry` parity using already-built parts. Also fix the `toPluginSpec` http-command bug (~3 LOC).
5. **Split LSP nav ON for cheap ops** (call-hierarchy/workspace_symbol/document_symbol via warm-backend), keep `references`/`implementation` opt-in/timeout-fenced — captures above-frontier capability without the measured references-timeout regression.
6. **Auto-escalate edit fuzzy on exact-miss** inside the repair loop (ladder is fail-closed, wrong-edit > no-edit bias) — closes packaging gap vs Claude/Codex auto-retry at near-zero risk.
7. **Promote semantic-search default embedder** from hash-BoW to a real embedder when a key is present, and normalize the in-memory dot→cosine (`search-index-backend.ts:339`, 1 line) — fixes ranking distortion on non-normalized embedders on the most-common enabled path.
8. **Gate coordination trio (mailbox/team/objective, 7 tools) default-OFF on CLI** until an engagement smoke proves the model uses them — frontier delivers multi-agent via ONE Task tool; these are unverified menu-overload. Add one live round-trip smoke before re-enabling.
9. **Make per-call Linux sandbox real** (reuse `detectLinuxSandboxBackend` in `per-call.ts`) — un-inerts ADR-0295 on the OS where bench runs.

## 5) One-line verdict

Our tool **capability** is at or beyond the frontier on every family — and genuinely *above* it on LSP semantic-nav, the live DAP debugger, the test+LSP+DAP+git Evidence Packet, and richer subagent primitives, none of which Claude/Codex/Cursor expose to the model. But the as-shipped **default surface is AT-PAR-or-worse**, because the strongest tools are default-OFF, placeholder-backed (hash-BoW embedder), or sprawled — so the gap to the frontier is almost entirely **packaging (defaults/wiring), not engineering**, plus a short list of real localization/enforcement bugs (pytest mispairing, Linux per-call, landlock net-deny) worth fixing on sight.

Key file:line cross-checks I ran live and confirmed: `agent-arg-builder.ts:194` (LSP gate), `manifest.ts:255-260` (overlap self-admit, default `{}`), `per-call.ts:146` (`linux-not-implemented-per-call`), `parse.ts:271/290-291/310` (pytest FAILURES/ERRORS index zip bug). The audit's `sandbox-wire.ts:68-69` line citation did not resolve at that exact offset (likely line-shifted), but the sandbox-default-OFF conclusion is independently supported by the knob inventory and the per-call bug.
