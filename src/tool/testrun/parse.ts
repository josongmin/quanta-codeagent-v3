/**
 * Epic-2 — pure test-output parsers. Each turns a runner's raw output into the
 * normalized {@link TestRunResult}. Pinned to VERBATIM real output captured from
 * go test -json / cargo test / python -m unittest (see parse.test.ts fixtures).
 * NEVER-throws — a malformed line is skipped, not fatal.
 */
import type { TestFailure, TestRunResult } from "./types"

/** `go test -json`: newline-delimited JSON events. `Action:"pass"|"fail"` with a
 *  `Test` field are per-test verdicts; `Output` lines carry `file.go:line: msg`. */
export const parseGoJson = (stdout: string): TestRunResult => {
  let passed = 0
  const failedNames: string[] = []
  const outputs = new Map<string, string[]>() // test → output lines
  let buildFailed = false
  let buildMsg: string | undefined
  let pkgFailed = false
  for (const line of stdout.split("\n")) {
    const t = line.trim()
    if (t.length === 0) continue
    let ev: { Action?: string; Test?: string; Output?: string }
    try {
      ev = JSON.parse(t)
    } catch {
      continue // non-JSON noise (e.g. a build error before the JSON stream)
    }
    // Build/compile failures (no Test) — a `build-fail` action or a package-level
    // `fail`. MUST surface, else a non-compiling suite reads as green.
    if (ev.Action === "build-fail") buildFailed = true
    if (ev.Action === "build-output" && typeof ev.Output === "string" && /:\d+:\d+:/.test(ev.Output))
      buildMsg = ev.Output.trim()
    if (ev.Test === undefined) {
      if (ev.Action === "fail") pkgFailed = true
      continue // not a per-test event
    }
    // dedupe (a flaky/retried test can emit fail twice)
    if (ev.Action === "pass") passed++
    else if (ev.Action === "fail") {
      if (!failedNames.includes(ev.Test)) failedNames.push(ev.Test)
    } else if (ev.Action === "output" && typeof ev.Output === "string") {
      const arr = outputs.get(ev.Test) ?? []
      arr.push(ev.Output)
      outputs.set(ev.Test, arr)
    }
  }
  const failed: TestFailure[] = failedNames.map((name) => {
    // First output line of the form `   file.go:line: message`.
    for (const o of outputs.get(name) ?? []) {
      const m = /^\s*([\w./-]+\.go):(\d+):\s*(.*)$/.exec(o.replace(/\n$/, ""))
      if (m !== null) return { name, file: m[1]!, line: Number(m[2]), message: m[3]!.trim() }
    }
    return { name }
  })
  // A build failure / package-level fail with no per-test failures is still a
  // FAILED run — synthesize an entry so it is never reported green.
  if ((buildFailed || pkgFailed) && failed.length === 0) {
    failed.push({ name: buildFailed ? "(build failed)" : "(package failed)", ...(buildMsg ? { message: buildMsg } : {}) })
  }
  return { runner: "go", passed, failed, ok: failed.length === 0 }
}

/** `cargo test` (libtest text): `test NAME ... ok|FAILED`, a per-failure
 *  `---- NAME stdout ----` block with `panicked at FILE:LINE:COL:` + message,
 *  and a `test result: ...; N passed; M failed;` summary. */
export const parseCargo = (output: string): TestRunResult => {
  const lines = output.split("\n")
  const failedNames: string[] = []
  for (const line of lines) {
    const m = /^test (\S+) \.\.\. FAILED$/.exec(line.trim())
    if (m !== null) failedNames.push(m[1]!)
  }
  // SUM passed across ALL summary lines — cargo prints one per section (lib /
  // doctests / each integration test), so overwriting would drop earlier counts.
  let passed = 0
  for (const line of lines) {
    const m = /(\d+) passed;/.exec(line)
    if (m !== null) passed += Number(m[1])
  }
  // Per-failure panic location + message from the `---- NAME stdout ----` block.
  const failed: TestFailure[] = failedNames.map((name) => {
    const start = lines.findIndex((l) => l.trim() === `---- ${name} stdout ----`)
    if (start === -1) return { name }
    let file: string | undefined
    let lineNo: number | undefined
    let message: string | undefined
    for (let i = start + 1; i < lines.length && !lines[i]!.startsWith("---- "); i++) {
      const pm = /panicked at ([^\s:]+(?::[^\s:]+)*?):(\d+):\d+:?/.exec(lines[i]!)
      if (pm !== null) {
        file = pm[1]
        lineNo = Number(pm[2])
        // Capture the panic message + a few following detail lines (e.g.
        // `assertion failed` + `left: 4` / `right: 5`) until a blank line.
        const detail: string[] = []
        for (let k = i + 1; k < lines.length && lines[k]!.trim().length > 0 && !lines[k]!.startsWith("---- "); k++) {
          detail.push(lines[k]!.trim())
          if (detail.length >= 4) break
        }
        message = detail.join(" ") || undefined
        break
      }
    }
    return { name, ...(file ? { file } : {}), ...(lineNo ? { line: lineNo } : {}), ...(message ? { message } : {}) }
  })
  // ok when the summary says ok, or no failures were seen.
  const ok = failed.length === 0 && !/test result: FAILED/.test(output)
  return { runner: "cargo", passed, failed, ok }
}

/** `python -m unittest -v` (text): `name (mod.Class) ... ok|FAIL|ERROR`,
 *  `FAIL: name (mod.Class)` blocks with a traceback `File "PATH", line N, in name`
 *  + a trailing exception line, and a `Ran N tests` + `OK`/`FAILED` summary. */
export const parsePythonUnittest = (output: string): TestRunResult => {
  const lines = output.split("\n")
  let ran = 0
  const ranMatch = /Ran (\d+) tests?/.exec(output)
  if (ranMatch !== null) ran = Number(ranMatch[1])

  // Failure/error blocks: `FAIL: name (...)` or `ERROR: name (...)`.
  const failed: TestFailure[] = []
  for (let i = 0; i < lines.length; i++) {
    const hm = /^(?:FAIL|ERROR): (.+)$/.exec(lines[i]!.trim())
    if (hm === null) continue
    const name = hm[1]!.trim()
    let file: string | undefined
    let lineNo: number | undefined
    let message: string | undefined
    // Scan the block body (the `---` underline right after the header is PART
    // of the block; blocks are separated by `===`, and the run ends at `Ran N`).
    for (
      let j = i + 1;
      j < lines.length && !/^={10,}$/.test(lines[j]!.trim()) && !/^Ran \d+ tests? in /.test(lines[j]!.trim());
      j++
    ) {
      const fm = /File "([^"]+)", line (\d+), in /.exec(lines[j]!)
      if (fm !== null) {
        file = fm[1]
        lineNo = Number(fm[2])
      }
      // The exception line is a `SomeError: message` after the traceback.
      const em = /^([A-Za-z_][\w.]*(?:Error|Exception|Failure)): (.*)$/.exec(lines[j]!.trim())
      if (em !== null) message = `${em[1]}: ${em[2]}`
    }
    failed.push({ name, ...(file ? { file } : {}), ...(lineNo ? { line: lineNo } : {}), ...(message ? { message } : {}) })
  }
  const passed = Math.max(0, ran - failed.length)
  // ok requires: zero failures, the trailing `OK`, AND at least one test ran
  // (a syntax/import error can print "Ran 0 tests ... OK" — not a confident pass).
  const ok = failed.length === 0 && ran > 0 && /\nOK\b/.test(`\n${output}`)
  return { runner: "python-unittest", passed, failed, ok }
}
