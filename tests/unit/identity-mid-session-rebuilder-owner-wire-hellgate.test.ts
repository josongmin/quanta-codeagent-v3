/**
 * ★ CONTRACT — ADR-0302 has one canonical prompt-rebuilder owner below the
 * host boundary. Bootstrap must call it and persist its result into the shared
 * SystemSource; an inline duplicate is not an equivalent wire.
 */
import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

// The `bootstrap-session.ts` god-MODULE split moved the rebuilder wire out of the
// entrypoint into `bootstrap-session/session-state-ports.ts`. The pin is unchanged
// — only the path it reads: aggregate the entrypoint + every stage so the contract
// follows the code, and so relocating the wire again cannot silently un-pin it.
const BOOTSTRAP_DIR = resolve(import.meta.dir, "../../src/host/bootstrap")
const bootstrapSource = (): string =>
  [
    resolve(BOOTSTRAP_DIR, "bootstrap-session.ts"),
    ...readdirSync(resolve(BOOTSTRAP_DIR, "bootstrap-session"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => resolve(BOOTSTRAP_DIR, "bootstrap-session", f)),
  ]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n")

const hasCanonicalRebuilderWire = (source: string): boolean =>
  /createSystemPromptRebuilder\s*\(\s*\{/.test(source) &&
  /systemSource\.set\(rebuilder\.rebuild\(\)\)/.test(source)

test("HELL-0302-OWNER-01: bootstrap uses the canonical rebuilder and persists its result", () => {
  expect(hasCanonicalRebuilderWire(bootstrapSource())).toBe(true)
})

test("HELL-0302-OWNER-02: red-on-injection — deleting either live use fails the owner wire", () => {
  const source = bootstrapSource()
  expect(
    hasCanonicalRebuilderWire(
      source.replace(/createSystemPromptRebuilder\s*\(\s*\{/, "removedFactory({"),
    ),
  ).toBe(false)
  expect(
    hasCanonicalRebuilderWire(source.replace("systemSource.set(rebuilder.rebuild())", "noop()")),
  ).toBe(false)
})
