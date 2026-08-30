# aug-30 repo-wide structural audit (duplication · wiring · SOLID · janky · inefficiency)

Two-wave audit over all of `src/` (3,351 non-test files): 11 region auditors (static-scan seeded) → 6 adversarial verifiers attacking every finding. 157 raw findings → **156 verified survivors** (1 refuted as stale, 33 retiered, 0 fabricated evidence). 175 seed clusters explicitly refuted during audit (do NOT re-audit those — reasons recorded per group in the wave-1 outputs).

- `findings-final.json` — the verified findings, sorted by final severity (HIGH 10 / MED 95 / LOW 51). Each carries `verdict` + `verifierNote` from the adversarial pass.
- `value-cycles.json` — comment-stripped, `import type`-excluded (i.e. runtime-real) import cycles. NOTE: the naive scan's giant SCCs (tool/ 169-file, agent/ 173-file) were artifacts of matching imports inside doc comments; real value cycles are small (largest: skill/system-skills 20, agent/loop+tier1 17 — closed by 2 back-edges with existing DI seams).

## Final HIGH set (10)
| id | what |
|---|---|
| G7-01 | 4 Anthropic transport adapters (bedrock/vertex/mantle/foundry) pass a fresh usage accumulator per event → `inputTokens: 0`, cache buckets dropped → cost undercount on every non-public transport |
| G3-02/G5-01 | spawn-helper clone family: only `runner/batch/eval/exec.ts` got the jun-26 tree-kill fix + C9 secret-scrub; 5 copies still bare `proc.kill()` and two pass full `process.env` to bench children |
| G6-01 | aug-23 exfil hardening (`classifySource` Layer-1 substitution) landed on csv_read only; yaml/ndjson/pdf/xlsx/docx/pptx readers (BASE, always-on) bypass redaction |
| G8-04 | live sandbox path: `assertSandboxEnforced` exempts `workspace-write-net`, so full degradation (no sandbox-exec/bwrap) runs commands with no FS fence, witnessed only by a startup warn |
| G9-04 | indexer re-reads+re-sha1s+re-chunks (and tree-sitter re-parses) the whole corpus every 5s tick; delta-tracker's promised mtime fast-path never implemented |
| G7-02 | ADR-0163 provider router (`CLAUDE_CODE_USE_*` quartet + conflict policy) built-but-never-wired; production uses `registry.resolveProvider` |
| G2b-01 | ADR-0493 thin-client route: frontmatter tag parsed + knob registered, but `resolveThinClientRoute` has zero callers — silent no-op even gate-ON |
| G5-02 | `ci-bot-policy.ts` dead parallel wiring with divergent CI env allowlist (3 allowlists total); unit test pins the dead copy |
| G3-01 | runner SCC#4 (46 files): knob framework value-imports `deriveKnob` from batch eval kernel; moving it + decoupling `Instance` drops knobs out of the cycle |

## Dominant defect classes (by volume)
1. **Built-but-never-wired** (37 wiring + much of dead-code): whole ADR slices parsed/typed/tested but no composition root calls them — error-routing (0217), obs metrics wiring (0222), git-directives (0220), retrieval axis family (0159), media/voice (0202), coverage adapters, os-sandbox port stack, skybridge, ipc.v1, oidc-federation, message-batches, localization, evidence, identity-pool, n-phase, streaming-boomerang, todo-readback, thread-tools. Verifiers confirmed: no hidden gate/dynamic-import/registry rescues any of them.
2. **Divergence drift** (12 HIGH+MED duplication): copy got hardened, sibling didn't — spawn exec, document readers, windows-vs-landlock fail-open, throttle-swallow guard (OpenAI yes / Anthropic no), `__proto__` frontmatter guard (skill yes / rules no), skill-resolver logger.warn, SessionBootstrapDeps stubs ×3.
3. **Type-only mega-cycles** — mechanical `import type` repointing; runtime cycles are tiny and have named cuts (see findings G1-01/02/03, G4-01, G10-10, G8-05/06).

Scanner false-positive lessons (for future audits): naive import regex matches doc comments (inflated SCCs); dead-export census must count same-file usage and string-keyed registries; `tools/dev/.scratch/d3/pristine/` (132MB gitignored src copy) poisons any repo-wide grep — delete it.
