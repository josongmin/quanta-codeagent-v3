# Authoring a new tool

The blessed path for adding a tool to quanta. Follow these steps in order — each one has a code anchor.

## 0. Prereqs

- Confirm the tool is not already covered by a generic primitive (`read` / `grep` / `glob` / `bash`). The LLM is the workflow engine; we add a tool only when **mechanical capture/validation** is needed (RFC §1.2 anti-bloat).
- If the tool touches a shell command or filesystem path: read [docs/decisions/0027-anti-signals-policy-injection-hardening.md](decisions/0027-anti-signals-policy-injection-hardening.md) and [docs/decisions/0091-git-write-protection.md](decisions/0091-git-write-protection.md) first — the security passthroughs you'll declare in step 2 plug into those gates.

## 1. Read the canonical template

`src/tool/factory.ts:5-32` — the doc-block on `defineTool` is the spec. Read it once before touching anything else. Quote (truncated):

> CANONICAL TEMPLATE: this is the blessed way to construct a tool. The representative built-ins `grep`, `glob`, `read`, and `write` are defined through it … A tool defined with NONE of the optional members is byte-identical to a hand-written `Tool` literal.

If you're tempted to write a hand-written `Tool` literal instead: don't. The factory copies only present fields (`exactOptionalPropertyTypes`-safe), so there is no overhead for a minimal tool. The hand-written literals that still exist predate the factory and are kept only because migration carries no behavior win.

## 2. Copy a reference

Pick the reference closest to the read/write profile of your tool and clone its `index.ts`:

| your tool's behavior | clone | why |
|---|---|---|
| pure filesystem read by content | `src/tool/grep/index.ts` | shows ripgrep wrapping, structured-output schema, redaction discipline |
| pure filesystem read by name | `src/tool/glob/index.ts` | shows path classification (`classifySource`) |
| reads a single file | `src/tool/read/index.ts` | shows `hitlTier` and `classifySource` for path-touching tools |
| writes / mutates | `src/tool/write/index.ts` | shows `hitlTier` + per-tier HITL prompt seam |

Do **not** copy a hand-written literal — those are legacy.

## 3. Declare security passthroughs (if applicable)

The registry and dispatch redaction/HITL gates read these spec members directly. **If your tool touches a path or shell command, declaring the relevant one is mandatory, not optional.**

| field | when required | reads it |
|---|---|---|
| `hitlTier` | tool can mutate fs / state / network | HITL 4-tier gate (ADR-0020 / ADR-0047) |
| `extractShellCommand` | tool shells out (even via a sandboxed runner) | matcher hooks (ADR-0055), AWF deny rules |
| `classifySource` | tool returns content that originates outside the workspace | content-plane redaction (ADR-0078) |

Cross-reference: [docs/runbooks/agent-loop-reference.md §3](runbooks/agent-loop-reference.md) `gate` row — that's the runtime side that consumes these.

## 4. Register in `buildTooling`

Add the tool to the registry at `src/apps/cli/internal.ts#buildTooling` (around line 519).

> ⚠️ `src/apps/cli/internal.ts` is frequently user-modified. Before editing, check `git status` — if it's M, coordinate with the user before adding your registration block to avoid a merge conflict.

Convention: env-gate any new tool behind a `QUANTA_*` flag with **default OFF** unless it's a strict superset of an existing built-in. Document the flag in [README.md §옵션 환경변수](../README.md).

## 5. Write a `*-hellgate.test.ts`

Under `tests/unit/<your-tool-name>-hellgate.test.ts`. Include the standard contract header:

```ts
/**
 * ★ CONTRACT — <ADR or claim number>: <one-sentence claim>
 *
 * Pins: <list the specific behaviors this test locks in>
 */
```

See [docs/test-naming.md](test-naming.md) for the suffix taxonomy (`hellgate` vs `hell-e2e` vs `e2e`). If your tool participates in the assembled loop in a non-trivial way (e.g. recovery, dispatch capture, hook channel), add a `*-hell-e2e.test.ts` under `tests/integration/` too.

## 6. Catalog the feature

```bash
bun fc add <section> <slug>
```

Fill in the scaffolded YAML — at minimum: `id`, `title`, `evidence` (test files from step 5), `adr` (if any). Then:

```bash
bun fc validate     # zod + id-unique + evidence file existence + ADR existence
bun fc build        # regenerate docs/10.feature-catalog.md
```

See [AGENTS.md §bun fc](../AGENTS.md) for the full workflow.

## 7. Cross-links

- [docs/decisions/0060-tool-output-schema-factory.md](decisions/0060-tool-output-schema-factory.md) — the ADR that introduced `defineTool`.
- [docs/decisions/0026-admissibility-gate-ssot.md](decisions/0026-admissibility-gate-ssot.md) — the gate every tool call passes through.
- [docs/runbooks/agent-loop-reference.md](runbooks/agent-loop-reference.md) §3 — tool-call lifecycle phases.
- [docs/test-naming.md](test-naming.md) — what suffix to use on your test.
