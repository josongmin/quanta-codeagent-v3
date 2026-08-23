# ADR-0552 — The integration lane: a security authority that works from source and dies in the shipped binary

Status: Accepted (2026-08-24)
Slice: `src/permission/shell/parser.ts` · `src/permission/shell/wasm-assets.d.ts`
Feature: `shell-effect-authority` (extends ADR-0544)
Related: ADR-0544 (the shell effect authority) · §17.5 packet I

## Context

The aug-23 execution plan ends with a serial integration lane — shared barrels, generated-protocol drift, the built CLI / provider / child front door, then the full rails. Its whole reason to exist is that a per-packet green does not prove the *shipped artifact* works.

It found exactly that.

The shell effect authority (ADR-0544) loads a tree-sitter grammar. From source, `node_modules` sits beside the process and everything resolves. The shipped artifact is a single-file binary from `bun build --compile`, where there is no `node_modules` — and `web-tree-sitter` then tries to load its runtime wasm from `/$bunfs/root/web-tree-sitter.wasm`, which is not embedded either.

Measured on `dist/agent`:

```
failed to asynchronously prepare wasm: ENOENT '/$bunfs/root/web-tree-sitter.wasm'
[warn] shell effect parser: grammar load failed
```

So the authority answered `unknown` for **every** command, and the shipping binary silently ran on the regex-only gate the lane was built to replace. Every unit test still passed, because they run from source. `cd / && rm -rf *` was allowed again in the product while being denied in CI.

Two earlier decisions are what made this recoverable rather than invisible:

- the load failure is **attributed**, not swallowed (the silent-failure ratchet forced that) — the warning is the only reason the defect surfaced;
- the gate is **deny-widening only**, so a dead parser degrades to yesterday's behavior instead of failing open past it.

## Decision

Embed both wasm assets with `import … with { type: "file" }`, which bun bundles and hands back a path that resolves in **both** modes — a real path in dev, `/$bunfs/root/…` when compiled — and pass the runtime path to emscripten via `Parser.init({ locateFile })`. The `createRequire`-based grammar-dir lookup is removed: it cannot work in the artifact that matters.

The regression is pinned by a test that **compiles a real binary and runs it**. That is slow, and it is the point: no cheaper assertion can distinguish "works from source" from "works when shipped", which is precisely the distinction that was wrong.

## Consequences

- The compiled front-door matrix now checks all eleven landed packets inside the binary — 18 assertions covering the shell authority, the cache-marker budget, the stop-reason codes, harness provenance, mode parity, the file-observation guard and the config-truth fixes.
- `src/permission/shell/wasm-assets.d.ts` declares the two `.wasm` modules as `string`, since TypeScript has no notion of bun's file-import attribute.
- Generalizable rule this campaign should keep: **any slice that resolves an asset from `node_modules` at runtime is dev-only until proven in a compiled binary.**

### The retrieval code-parser: measured, not presumed

The same class was then measured on `src/retrieval/code-parser`. From source a parse returns `{ok:true}`; in a compiled binary run **outside the repo** it returned `{ok:false, reason:"parse-error"}` — indistinguishable from a genuinely unparseable file.

The exact matrix:

| binary run from | `QUANTA_TREE_SITTER_DIR` | before | after |
| --- | --- | --- | --- |
| the repo (node_modules present) | unset | fails | works |
| anywhere else | unset | fails | still fails |
| anywhere else | set | **fails** | **works** |

Only the 200 KB **runtime** wasm is embedded there. The grammars are ~21 MB across 16 languages and the parser is opt-in behind `QUANTA_INDEX`, so bundling all of them is a product decision, not an integration fix. What the embed buys is that `QUANTA_TREE_SITTER_DIR` — an override that already existed — is **usable for the first time**, because `Parser.init` no longer aborts before any grammar is looked up. The test asserts exactly that row and nothing stronger.
