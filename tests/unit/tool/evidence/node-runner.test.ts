/**
 * T-02 — JS runner routing (pure). Pins detection (package.json deps → runner)
 * and the single-process `node --inspect-brk` argv per runner. red-on-injection:
 * change a flag (e.g. drop jest's --runInBand) and the argv assertion fails.
 */
import { describe, expect, test } from "bun:test"
import { detectJsRunner, nodeInspectArgv } from "@/tool/evidence/node-runner"

describe("detectJsRunner", () => {
  test("picks the runner from (dev)dependencies; precedence vitest>jest>mocha", () => {
    expect(detectJsRunner(JSON.stringify({ devDependencies: { jest: "^29" } }))).toBe("jest")
    expect(detectJsRunner(JSON.stringify({ devDependencies: { mocha: "^10" } }))).toBe("mocha")
    expect(detectJsRunner(JSON.stringify({ dependencies: { vitest: "^2" } }))).toBe("vitest")
    expect(detectJsRunner(JSON.stringify({ devDependencies: { vitest: "^2", jest: "^29" } }))).toBe("vitest")
    expect(detectJsRunner(JSON.stringify({ devDependencies: { typescript: "^5" } }))).toBe("node") // none ⇒ node
  })

  test("no / malformed package.json ⇒ node (run the file directly), never throws", () => {
    expect(detectJsRunner(null)).toBe("node")
    expect(() => detectJsRunner("{not json")).not.toThrow()
    expect(detectJsRunner("{not json")).toBe("node")
  })
})

describe("nodeInspectArgv — single-process inspect command per runner", () => {
  const F = "/p/m.test.js"
  test("node:test / plain file runs the file directly", () => {
    expect(nodeInspectArgv("node", "node", F, 9229)).toEqual(["node", "--inspect-brk=9229", F])
  })
  test("jest uses --runInBand (main process, no workers)", () => {
    expect(nodeInspectArgv("jest", "node", F, 9229)).toEqual(["node", "--inspect-brk=9229", "node_modules/.bin/jest", "--runInBand", F])
  })
  test("mocha runs in-process via its bin", () => {
    expect(nodeInspectArgv("mocha", "node", F, 9229)).toEqual(["node", "--inspect-brk=9229", "node_modules/.bin/mocha", F])
  })
  test("vitest ⇒ null (worker pool owns its own inspector — degrade, follow-up)", () => {
    expect(nodeInspectArgv("vitest", "node", F, 9229)).toBeNull()
  })
})
