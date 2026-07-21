/**
 * ★ CONTRACT — ADR-0302 has one canonical prompt-rebuilder owner below the
 * host boundary. Bootstrap must call it and persist its result into the shared
 * SystemSource; an inline duplicate is not an equivalent wire.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const bootstrapSource = (): string =>
  readFileSync(resolve(import.meta.dir, "../../src/host/bootstrap/bootstrap-session.ts"), "utf8")

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
