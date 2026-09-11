/**
 * HELLGATE — the determinism scanner is STRUCTURAL, not a grep (TVH-15 items 1-3).
 *
 * Every case here is a shape a text search gets wrong, in one direction or the
 * other. They are the reason this walks a TypeScript AST with a scope chain
 * instead of matching lines:
 *
 *   - `test("no fixture is drawn from Math.random()")` — a guard that FORBIDS
 *     the call has to spell it out. A grep marks the guard as the violation.
 *   - `const t0 = Date.now()` … `expect(elapsed).toBeLessThan(50)` — the link is
 *     three lines and one scope away.
 *   - `runCodeCell({ …, now })` — a clock passed INTO a call does not make the
 *     result a duration. Over-tainting here made a BYTE CAP
 *     (`expect(r.output.length).toBeLessThan(256)`) read as a wall assertion in
 *     two files; that is measured, not hypothetical.
 *   - `setTimeout(fn, 50)` vs `setTimeout(50)` put the number in different
 *     argument slots.
 */

import { describe, expect, test } from "bun:test"
import { scanTestSource } from "../../../tools/dev/test-determinism-scan"

const scan = (source: string) => scanTestSource("fixture.test.ts", source)

describe("wall-clock assertions: found by position, linked by scope", () => {
  test("a clock call INSIDE the expect argument is time-call evidence", () => {
    const result = scan(`
const t0 = Date.now()
expect(Date.now() - t0).toBeLessThan(50)
`)
    expect(result.wall).toHaveLength(1)
    expect(result.wall[0]?.evidence).toBe("time-call")
    expect(result.wall[0]?.bound).toBe("50")
    expect(result.wall[0]?.line).toBe(3)
  })

  test("a binding initialised from a clock is resolved through the SCOPE chain", () => {
    const result = scan(`
test("x", () => {
  const start = performance.now()
  doWork()
  const elapsed = performance.now() - start
  expect(elapsed).toBeLessThanOrEqual(200)
})
`)
    expect(result.wall).toHaveLength(1)
    expect(result.wall[0]?.evidence).toBe("time-binding")
    expect(result.wall[0]?.matcher).toBe("toBeLessThanOrEqual")
  })

  test("PAIRED CONTROL: a clock passed INTO a call does not taint the result", () => {
    // The measured false positive this closes: `r` is a code-cell outcome, and
    // `r.output.length` is a byte cap.
    const result = scan(`
const now = () => performance.now()
test("x", async () => {
  const r = await runCodeCell({ code: "a", now })
  expect(r.output.length).toBeLessThanOrEqual(256)
})
`)
    expect(result.wall).toHaveLength(0)
  })

  test("PAIRED CONTROL: a clock CALL inside call arguments still taints", () => {
    // `Number(process.hrtime.bigint() - start) / 1e6` is a real duration
    // (`plan-mode-stress-100k-ops.test.ts` writes exactly this), so the
    // over-taint fix must not have thrown it away. The binding is named
    // `spread` on purpose: it does NOT match the duration-name fallback, so the
    // only way this site can be found is the clock call inside `Number(...)`.
    const result = scan(`
const start = process.hrtime.bigint()
const spread = Number(process.hrtime.bigint() - start) / 1_000_000
expect(spread).toBeLessThan(5000)
`)
    expect(result.wall).toHaveLength(1)
    expect(result.wall[0]?.evidence).toBe("time-binding")
  })

  test("PAIRED CONTROL: with no clock anywhere, the same shape is invisible", () => {
    // Identical syntax, no clock call: proves the case above is found BECAUSE
    // of the taint and not because of the `Number(...) / 1_000_000` shape.
    const result = scan(`
const start = counter()
const spread = Number(counter() - start) / 1_000_000
expect(spread).toBeLessThan(5000)
`)
    expect(result.wall).toHaveLength(0)
  })

  test("a duration-NAMED member with no local clock is found as weaker evidence", () => {
    const result = scan(`expect(result.durationMs).toBeLessThan(200)`)
    expect(result.wall).toHaveLength(1)
    expect(result.wall[0]?.evidence).toBe("duration-member")
  })

  test("LOWER bounds are not collected — only the direction that judges throughput", () => {
    const result = scan(`
const t0 = Date.now()
expect(Date.now() - t0).toBeGreaterThan(5)
`)
    expect(result.wall).toHaveLength(0)
  })

  test("a non-time upper bound is not collected", () => {
    expect(scan(`expect(rows.length).toBeLessThan(10)`).wall).toHaveLength(0)
  })

  test("a clock mentioned only in a COMMENT or a STRING is invisible", () => {
    const result = scan(`
// expect(Date.now() - t0).toBeLessThan(20)
test("expect(Date.now()).toBeLessThan(20) is banned", () => {
  expect("Date.now()").toBeTruthy()
})
`)
    expect(result.wall).toHaveLength(0)
  })
})

describe("randomness: classified by what the VALUE can reach", () => {
  const roles = (source: string): readonly string[] => scan(source).random.map((site) => site.role)

  test("a comparator, a sort key or a delay is outcome-relevant", () => {
    expect(roles(`const keep = Math.random() > 0.5 ? i : -1`)).toEqual(["outcome-relevant"])
    expect(roles(`order.sort(() => Math.random() - 0.5)`)).toEqual(["outcome-relevant"])
    expect(roles(`const delayMs = Math.random() * 4`)).toEqual(["outcome-relevant"])
    expect(roles(`const pid = Math.floor(Math.random() * 1_000_000)`)).toEqual(["outcome-relevant"])
  })

  test("a value that can only become a STRING is id-shaped", () => {
    // Written as a template with escaped `\${` so the FIXTURE contains a real
    // interpolation while this file contains no string-literal placeholder.
    expect(roles(`const p = join(dir, \`\${Math.random().toString(36).slice(2)}.jsonl\`)`)).toEqual(
      ["id-shaped"],
    )
    expect(roles(`const id = \`s-\${Math.random()}\``)).toEqual(["id-shaped"])
  })

  test("a comparison against a constant outside [0,1) is a provably dead branch", () => {
    expect(roles(`if (Math.random() < 0) yield { type: "text_delta" }`)).toEqual([
      "unreachable-guard",
    ])
    expect(roles(`if (Math.random() < -1) yield { type: "message_stop" }`)).toEqual([
      "unreachable-guard",
    ])
  })

  test("a call named only in a comment, a string or a test TITLE is not a site", () => {
    const result = scan(`
// Determinism: no Date.now() / Math.random().
test("no fixture is drawn from Math.random()", () => {
  expect("Math.random()").toBeTruthy()
})
`)
    expect(result.random).toHaveLength(0)
  })
})

describe("awaited fixed sleeps are summed per file, from the right argument slot", () => {
  test("the callback form puts the number SECOND", () => {
    const result = scan(`await new Promise((r) => setTimeout(r, 250))`)
    expect(result.sleepTotalMs).toBe(250)
  })

  test("the promise form puts it FIRST", () => {
    expect(scan(`await Bun.sleep(120)`).sleepTotalMs).toBe(120)
    expect(scan(`await sleep(30)`).sleepTotalMs).toBe(30)
  })

  test("numeric separators are read, and several sleeps add up", () => {
    const result = scan(`
await Bun.sleep(1_000)
await new Promise((r) => setTimeout(r, 500))
await sleep(50)
`)
    expect(result.sleepTotalMs).toBe(1_550)
    expect(result.sleep).toHaveLength(3)
  })

  test("an UNawaited timer is not a fixed wait — it is a scheduled callback", () => {
    expect(scan(`setTimeout(() => ac.abort(), 1500)`).sleepTotalMs).toBe(0)
  })

  test("a non-literal duration is not counted (there is no fixed number to ratchet)", () => {
    expect(scan(`await Bun.sleep(budgetMs)`).sleepTotalMs).toBe(0)
  })
})
