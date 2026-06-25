/**
 * Epic-2 — pure test-output parsers. Each turns a runner's raw output into the
 * normalized {@link TestRunResult}. Pinned to VERBATIM real output captured from
 * go test -json / cargo test / python -m unittest (see parse.test.ts fixtures).
 * NEVER-throws — a malformed line is skipped, not fatal.
 */
import type { TestFailure, TestRunResult } from "./types"

/** C++ via `ctest --output-on-failure`. ctest surfaces the underlying framework
 *  output; we localize from the two dominant shapes: libc `assert` (VERBATIM-
 *  pinned: `Assertion failed: (COND), function FN, file FILE, line N.`) and
 *  GoogleTest (`FILE:LINE: Failure` + `[  FAILED  ] Suite.Test`). NEVER-throws. */
export const parseCtest = (output: string): TestRunResult => {
  const lines = output.split("\n")
  const failed: TestFailure[] = []

  // libc assert (verbatim) — one failure per assert line, fully localized.
  for (const raw of lines) {
    const am = /^Assertion failed: \((.+)\), function (.+), file (.+), line (\d+)\.?$/.exec(
      raw.trim(),
    )
    if (am !== null)
      failed.push({
        name: am[2]!.trim(),
        file: am[3]!.trim(),
        line: Number(am[4]),
        message: `Assertion failed: (${am[1]})`,
      })
  }

  // GoogleTest: a `[  FAILED  ] Suite.Test (N ms)` marker, preceded (in document
  // order) by its `FILE:LINE: Failure` location(s) + assertion message(s). Bind
  // each marker to the FIRST location/message that accumulated SINCE the prior
  // marker, then reset — so a test with TWO failed assertions takes its own first
  // site, and the NEXT test is never shifted onto the previous test's second
  // location (the flat-index-zip bug).
  if (failed.length === 0) {
    let pendingLocs: { file: string; line: number }[] = []
    let pendingMsgs: string[] = []
    for (const raw of lines) {
      const t = raw.trim()
      const lm = /^(.+?):(\d+): Failure$/.exec(t)
      if (lm !== null) {
        pendingLocs.push({ file: lm[1]!, line: Number(lm[2]) })
        continue
      }
      const em = /^(?:Expected|Actual|Value of|error:)\b.*$/.exec(t)
      if (em !== null) {
        pendingMsgs.push(t)
        continue
      }
      // ONLY the per-test result line carries `(N ms)` — the trailing summary
      // block (`[ FAILED ] 1 test, listed below:` and a bare `[ FAILED ] Name`)
      // has no timing, so requiring `(N ms)` excludes both (verbatim-confirmed
      // against real gtest, which a simpler fixture had hidden).
      const fm = /^\[\s*FAILED\s*\]\s+(.+?)\s+\(\d+\s*ms\)$/.exec(t)
      if (fm !== null) {
        const loc = pendingLocs[0]
        const msg = pendingMsgs[0]
        failed.push({
          name: fm[1]!,
          ...(loc ? { file: loc.file, line: loc.line } : {}),
          ...(msg ? { message: msg } : {}),
        })
        pendingLocs = []
        pendingMsgs = []
      }
    }
  }

  // Pass count: gtest `[  PASSED  ] N tests` or ctest `N% tests passed, M ... failed`.
  let passed = 0
  const gp = /\[\s*PASSED\s*\]\s+(\d+)\s+tests?/.exec(output)
  if (gp !== null) passed = Number(gp[1])
  return { runner: "ctest", passed, failed, ok: failed.length === 0 }
}

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
    if (
      ev.Action === "build-output" &&
      typeof ev.Output === "string" &&
      /:\d+:\d+:/.test(ev.Output)
    )
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
    failed.push({
      name: buildFailed ? "(build failed)" : "(package failed)",
      ...(buildMsg ? { message: buildMsg } : {}),
    })
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
        for (
          let k = i + 1;
          k < lines.length && lines[k]!.trim().length > 0 && !lines[k]!.startsWith("---- ");
          k++
        ) {
          detail.push(lines[k]!.trim())
          if (detail.length >= 4) break
        }
        message = detail.join(" ") || undefined
        break
      }
    }
    return {
      name,
      ...(file ? { file } : {}),
      ...(lineNo ? { line: lineNo } : {}),
      ...(message ? { message } : {}),
    }
  })
  // ok when the summary says ok, or no failures were seen.
  const ok = failed.length === 0 && !/test result: FAILED/.test(output)
  return { runner: "cargo", passed, failed, ok }
}

// ── Node / JS runners (bun test, node --test, jest, vitest, mocha) ───────────
// There is no single JS test-output format, but every V8 runner prints stack
// frames in the SAME shape — `at [name ](FILE:LINE:COL)` (vitest also uses
// `❯ FILE:LINE:COL`). That shared frame is the reliable localization signal; the
// fail-marker + count lines are matched per-runner. Pinned to VERBATIM bun +
// node:test output (see parse-node.test.ts).
const NODE_SRC_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/
/** A frame is USER source (not a runner/stdlib frame) when it has a JS/TS
 *  extension and is neither under node_modules nor a `node:` internal module. */
const isUserSource = (f: string): boolean =>
  NODE_SRC_EXT.test(f) && !f.includes("/node_modules/") && !f.startsWith("node:")

/** Pull a `{file,line}` out of a V8 stack frame or a vitest `❯` location line,
 *  stripping a `file://` URL prefix. Returns null for non-frames / non-user
 *  frames (runner internals, node_modules). */
const extractNodeLoc = (line: string): { file: string; line: number } | null => {
  // V8 STACK FRAME: real frames are INDENTED (`      at <name> (FILE:LINE:COL)`
  // or bare `      at FILE:LINE:COL`). The leading-whitespace anchor excludes
  // node:test's `test at FILE:LINE` DEFINITION annotation (not indented, points
  // at the test() call, not the failure site) — we want the assertion frame.
  // FILE may be a file:// URL (node --test); the path token has no spaces/parens.
  const v8 = /^\s+at\s+(?:.*?\()?(?:file:\/\/)?(\/?[^\s():]+):(\d+):\d+\)?/.exec(line)
  // vitest: `❯ FILE:LINE:COL`.
  const vt = /❯\s+(?:file:\/\/)?([^\s():]+):(\d+):\d+/.exec(line)
  const m = v8 ?? vt
  if (m === null) return null
  const file = m[1]!
  return isUserSource(file) ? { file, line: Number(m[2]) } : null
}

/** Parse a JS/TS runner's output. Extracts failed test NAMES (bun `(fail)`,
 *  node:test `✖`, jest/vitest `✕/×`, TAP `not ok`), and localizes each via the
 *  user-source stack frame + the error message NEAREST its own fail-marker.
 *
 *  Association is by MARKER PROXIMITY, not by a global flat index: each failure
 *  binds the location/message whose line sits closest to ITS marker (without a
 *  different marker in between). This is order-agnostic — bun prints the frame
 *  ABOVE its `(fail)` marker, while node:test/jest/vitest print it BELOW — and,
 *  unlike the old `locs[i]` zip, a failure that emits two user frames (e.g. an
 *  assertion inside a helper) no longer shifts the NEXT failure onto the wrong
 *  file:line. NEVER-throws. */
export const parseNodeTest = (output: string): TestRunResult => {
  const lines = output.split("\n")

  // Each failure record + the line indices of EVERY marker that names it (a
  // doubled marker — node:test prints the inline `✖` and a trailing one — maps
  // to the SAME record, so proximity can use whichever is closer to a frame).
  type FailRec = { name: string; file?: string; line?: number; message?: string }
  const byName = new Map<string, FailRec>()
  const order: FailRec[] = []
  const markers: { idx: number; rec: FailRec }[] = []
  const markAt = (idx: number, n: string): void => {
    const t = n.trim()
    // Skip section headers like `✖ failing tests:` (node:test) — they end with `:`.
    if (t.length === 0 || t.endsWith(":")) return
    let rec = byName.get(t)
    if (rec === undefined) {
      rec = { name: t }
      byName.set(t, rec)
      order.push(rec)
    }
    markers.push({ idx, rec })
  }
  lines.forEach((raw, idx) => {
    const l = raw.trim()
    let m: RegExpExecArray | null
    if ((m = /^\(fail\)\s+(.+?)(?:\s+\[[\d.]+\s*m?s\])?$/.exec(l)) !== null)
      markAt(idx, m[1]!) // bun
    else if ((m = /^[✖✗✕×]\s+(.+?)\s+\([\d.]+\s*ms\)$/.exec(l)) !== null)
      markAt(idx, m[1]!) // node:test / jest / vitest (timed: `✖ name (4 ms)`)
    else if ((m = /^not ok \d+ - (.+)$/.exec(l)) !== null)
      markAt(idx, m[1]!) // TAP
    else if ((m = /^[✕×]\s+(.+)$/.exec(l)) !== null)
      markAt(idx, m[1]!) // jest/vitest without timing (✕ U+2715, NOT node:test's ✖)
    else if ((m = /^●\s+(.+)$/.exec(l)) !== null) markAt(idx, m[1]!) // jest DEFAULT reporter bullet (● U+25CF) — `● Suite › test`
  })
  // mocha uses neither shape — it prints a `N failing` count + numbered `N) name`
  // entries (summary list first, then per-failure detail). Harvest exactly
  // `failing`-many numbered names (the summary list comes first, so we stop
  // before the detail `N) <suite>` headers). Gated on a real failing count so a
  // passing run can't be mis-read.
  if (order.length === 0) {
    const failing = Number(/(\d+)\s+failing\b/.exec(output)?.[1] ?? "0")
    if (failing > 0) {
      for (let idx = 0; idx < lines.length && order.length < failing; idx++) {
        const mm = /^\s*\d+\)\s+(.+?)\s*$/.exec(lines[idx]!)
        if (mm !== null) markAt(idx, mm[1]!)
      }
    }
  }

  // The failure whose marker is NEAREST this line index (ties → the earlier
  // marker, deterministic). Undefined when no marker was found.
  const nearestRec = (idx: number): FailRec | undefined => {
    let best: { idx: number; rec: FailRec } | undefined
    for (const mk of markers) {
      if (best === undefined || Math.abs(mk.idx - idx) < Math.abs(best.idx - idx)) best = mk
    }
    return best?.rec
  }
  // Bind each user-source frame / error message to its nearest marker. Iterating
  // in DOCUMENT ORDER + "first one wins per record" keeps the deepest user frame
  // (printed first) and the first error message — matching the prior single-
  // failure contract.
  lines.forEach((raw, idx) => {
    const loc = extractNodeLoc(raw)
    if (loc !== null) {
      const rec = nearestRec(idx)
      if (rec !== undefined && rec.file === undefined) {
        rec.file = loc.file
        rec.line = loc.line
      }
    }
    const em =
      /^\s*(?:error:\s*(.+)|([A-Za-z_][\w.]*(?:Error|Exception|Failure)(?:\s*\[[^\]]+\])?):\s*(.+))$/.exec(
        raw,
      )
    if (em !== null) {
      const rec = nearestRec(idx)
      if (rec !== undefined && rec.message === undefined)
        rec.message = (em[1] ?? `${em[2]}: ${em[3]}`).trim()
    }
  })

  const failed: TestFailure[] = order.map((r) => ({
    name: r.name,
    ...(r.file ? { file: r.file, line: r.line } : {}),
    ...(r.message ? { message: r.message } : {}),
  }))
  // NB: a markerless failure (unusual formatter, exit≠0 but nothing parsed) is
  // NOT synthesized here — that is the EXIT-CODE safety net's job in `tool.ts`
  // (it has the exit code; this pure parser does not). Synthesizing on
  // loc+message alone would FALSE-RED a passing run that merely logged an
  // "Error:" line next to a stack frame.

  // Pass counts across runners; default 0 when not reported.
  let passed = 0
  const pc =
    /^\s*(\d+)\s+pass\b/m.exec(output) ?? // bun ` 1 pass`
    /ℹ pass (\d+)/.exec(output) ?? // node:test
    /Tests:.*?(\d+)\s+passed/.exec(output) ?? // jest/vitest summary
    null
  if (pc !== null) passed = Number(pc[1])

  return { runner: "node", passed, failed, ok: failed.length === 0 }
}

/** Normalize a pytest test identifier to a stable lookup key: drop a leading
 *  `FILE::` (or `FILE.py:`) path, and collapse the `::` / `.` separators the two
 *  surfaces disagree on (summary uses `Class::method`, the `___ block ___` header
 *  uses `Class.method`) to a single token. Lets a FAILURES/ERRORS block be paired
 *  to its short-summary entry BY NAME — never by array index. */
const pytestNameKey = (id: string): string =>
  id
    .replace(/^.*?\.py(?:::|:)/, "") // strip a leading file path (`test_math.py::` / `test_math.py:`)
    .replace(/::/g, ".") // unify `Class::method` ⇄ `Class.method`
    .trim()

/** `python -m pytest` (text): a `=== FAILURES ===` and/or `=== ERRORS ===` section
 *  with one `___ name ___` block per failing/erroring test (each ending in
 *  `FILE:LINE: ExcType`), and a `short test summary info` listing `FAILED`/`ERROR
 *  FILE::test - message` lines + an `N failed, M passed` total. The summary lists
 *  FAILED-before-ERROR while the sections print ERRORS-before-FAILURES, so blocks
 *  are paired to summary entries BY TEST NAME (not by order/index — a positional
 *  zip mis-localizes the ERROR rows). Pinned to VERBATIM pytest 9.x. NEVER-throws. */
export const parsePytest = (output: string): TestRunResult => {
  const lines = output.split("\n")
  const passed = Number(/(\d+) passed/.exec(output)?.[1] ?? "0")

  // Short summary (authoritative failure list + messages).
  const summary: { testid: string; message?: string }[] = []
  for (const l of lines) {
    const m = /^(?:FAILED|ERROR)\s+(\S+)(?:\s+-\s+(.*))?$/.exec(l.trim())
    if (m !== null) summary.push({ testid: m[1]!, ...(m[2] ? { message: m[2].trim() } : {}) })
  }

  // FAILURES + ERRORS blocks: header `___ name ___`; the LAST `FILE.py:LINE:`
  // inside a block is the assertion / raise site (deepest user frame). Keyed by
  // the block's parsed name so it pairs to the matching summary entry regardless
  // of section vs summary ordering. The ERRORS header carries a prefix
  // (`ERROR at setup of <test>` / `ERROR collecting <file>`) — strip it to the
  // bare test/file id before keying.
  const blockLocByKey = new Map<string, { file: string; line: number }>()
  let inBlocks = false
  let curName: string | undefined
  let cur: { file: string; line: number } | undefined
  const flush = (): void => {
    if (curName !== undefined && cur !== undefined && !blockLocByKey.has(curName)) blockLocByKey.set(curName, cur)
  }
  for (const raw of lines) {
    const t = raw.trim()
    if (/^=+\s*(FAILURES|ERRORS)\s*=+$/.test(t)) {
      flush()
      inBlocks = true
      curName = undefined
      cur = undefined
      continue
    }
    if (!inBlocks) continue
    // End of a blocks section: short summary / totals. (A `=== FAILURES ===` or
    // `=== ERRORS ===` header is handled above and KEEPS scanning the next section.)
    if (/^=+\s*(short test summary|\d+ (failed|passed|error)|warnings summary)\b/.test(t)) {
      flush()
      inBlocks = false
      curName = undefined
      cur = undefined
      continue
    }
    const hm = /^_{3,}\s*(.*?)\s*_{3,}$/.exec(t)
    if (hm !== null) {
      flush()
      // Strip the ERRORS-section prefixes down to the bare test/file id.
      const bare = hm[1]!
        .replace(/^ERROR at (?:setup|teardown|call) of\s+/, "")
        .replace(/^ERROR collecting\s+/, "")
      curName = pytestNameKey(bare)
      cur = undefined
      continue
    }
    const fm = /^(.+\.py):(\d+):\s/.exec(raw)
    if (fm !== null) cur = { file: fm[1]!, line: Number(fm[2]) }
  }
  flush()

  const failed: TestFailure[] = summary.map((s) => {
    const sep = s.testid.indexOf("::")
    const fileFromId = sep === -1 ? undefined : s.testid.slice(0, sep)
    const name = sep === -1 ? s.testid : s.testid.slice(sep + 2)
    const loc = blockLocByKey.get(pytestNameKey(s.testid))
    const file = loc?.file && loc.file.length > 0 ? loc.file : fileFromId
    return {
      name,
      ...(file ? { file } : {}),
      ...(loc && loc.line > 0 ? { line: loc.line } : {}),
      ...(s.message ? { message: s.message } : {}),
    }
  })
  return { runner: "pytest", passed, failed, ok: failed.length === 0 }
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
      j < lines.length &&
      !/^={10,}$/.test(lines[j]!.trim()) &&
      !/^Ran \d+ tests? in /.test(lines[j]!.trim());
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
    failed.push({
      name,
      ...(file ? { file } : {}),
      ...(lineNo ? { line: lineNo } : {}),
      ...(message ? { message } : {}),
    })
  }
  const passed = Math.max(0, ran - failed.length)
  // ok requires: zero failures, the trailing `OK`, AND at least one test ran
  // (a syntax/import error can print "Ran 0 tests ... OK" — not a confident pass).
  const ok = failed.length === 0 && ran > 0 && /\nOK\b/.test(`\n${output}`)
  return { runner: "python-unittest", passed, failed, ok }
}
