/**
 * G1 — the jailed scaffold adapter (RFC jun-6-appgen-appshot §4.1, Phase 1).
 *
 * Turns an {@link AppSpec} into a single-file `index.html` and writes it through
 * the SAME FS-jail chokepoint the authoring tools use (`@/storage`
 * `resolveJailed` — NOT a bespoke `path.resolve` + `startsWith`). This is the
 * `scaffold` arrow of the verify loop; the composition root binds it into the
 * real {@link AppshotPort} alongside the browser render/screenshot + LLM-judge.
 *
 * Slice posture (RFC §3.1): imports ONLY `node:path` + `@/storage` (mirrors
 * `src/tool/document/authoring/jailed-write.ts`). No `@/browser`, `@/agent`,
 * `@/llm`. A `../` escape in the requested dir is rejected by `resolveJailed`
 * (a typed throw the loop boundary catches → `scaffold_failed`, never an escape).
 *
 * Phase-1 scope (RFC §7): single-file HTML only. The spec prompt + accumulated
 * verify feedback are embedded as an HTML comment + a visible `<pre>` so the
 * render reflects the spec AND the critique the loop is iterating on. A real
 * codegen scaffold (a model-authored body) is a Phase-2 concern; this adapter is
 * the deterministic, jail-safe write path the loop depends on. The composition
 * root MAY swap a richer scaffold that still writes through this same helper.
 */

import { join } from "node:path"
import { FsJailError, resolveJailed } from "@/storage"
import type { AppSpec, ScaffoldResult } from "./port"

/** Entry filename the loop navigates to. */
const ENTRY_FILE = "index.html"
const ENTRY_MEDIA_TYPE = "text/html"

/** Escape `<`, `>`, `&` so a hostile spec/feedback string can NOT inject markup
 *  into the scaffolded page (it renders as text inside the `<pre>` body). */
const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Render the deterministic single-file HTML for a spec. The prompt + feedback
 *  are escaped + embedded so the render visibly reflects what the loop is
 *  verifying against. PURE. */
export const renderScaffoldHtml = (spec: AppSpec): string => {
  const feedback =
    spec.feedback.length > 0
      ? `\n<section id="appshot-feedback"><h2>Revision notes</h2><ul>${spec.feedback
          .map((f) => `<li>${escapeHtml(f)}</li>`)
          .join("")}</ul></section>`
      : ""
  return (
    `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8">` +
    `<title>appshot</title></head>\n<body>` +
    `\n<main id="appshot-spec"><h1>Spec</h1><pre>${escapeHtml(spec.prompt)}</pre></main>` +
    `${feedback}\n</body>\n</html>\n`
  )
}

/** Injected write seam — default writes raw text through `Bun.write` (creates
 *  the parent dir). A test double records in memory. */
export interface ScaffoldWritePort {
  writeText(abs: string, text: string): Promise<void>
}

const defaultScaffoldWritePort: ScaffoldWritePort = {
  async writeText(abs: string, text: string): Promise<void> {
    await Bun.write(abs, text)
  },
}

/**
 * Build a jailed scaffold function for {@link AppshotPort.scaffold}. The returned
 * function resolves `<outDir>/index.html` against `cwd` THROUGH the FS jail, then
 * writes the rendered HTML. A jail escape (a `../` outDir, an absolute path
 * outside `cwd`, a NUL byte) throws {@link FsJailError} — the loop boundary maps
 * it to a typed `scaffold_failed` (no escape ever lands on disk).
 *
 * `cwd` is the jail root (the composition root passes `ctx.cwd`). `writePort` is
 * injectable for tests.
 */
export const makeJailedScaffold = (
  cwd: string,
  writePort: ScaffoldWritePort = defaultScaffoldWritePort,
): ((spec: AppSpec, outDir: string, signal?: AbortSignal) => Promise<ScaffoldResult>) => {
  return async (spec, outDir): Promise<ScaffoldResult> => {
    if (outDir.includes("\0")) {
      throw new FsJailError("appshot: NUL byte in out dir is not allowed")
    }
    // Resolve the ENTRY FILE (not just the dir) through the jail so the final
    // write target is confined — a `../` in outDir throws FsJailError here.
    const rel = join(outDir, ENTRY_FILE)
    const abs = resolveJailed(rel, cwd) as string
    const html = renderScaffoldHtml(spec)
    await writePort.writeText(abs, html)
    return {
      entryUrl: `file://${abs}`,
      entryPath: abs,
      mediaType: ENTRY_MEDIA_TYPE,
    }
  }
}
