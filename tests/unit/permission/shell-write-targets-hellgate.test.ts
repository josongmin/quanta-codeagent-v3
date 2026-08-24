/**
 * HELLGATE — B convergence: the write-effect extractor reads the IR, not regexes
 * (§17.5 packet B, remaining consumers).
 *
 * `extractShellWritePaths` answers "which paths does this command WRITE?" for
 * two DENY authorities: the circumvention detector and the ownership fence. It
 * answers with six regexes over the raw command string, and its own callers
 * concede the limit — `ownership-policy.ts` says "BEST-EFFORT … matches only
 * LITERAL redirect/tee/sed/cp/dd/open targets".
 *
 * That understates it. Measured against the shipped extractor, three classes of
 * defect, not one:
 *
 *   1. VEHICLE HEAD — a complete MISS, which in a deny authority is FAIL-OPEN.
 *        sudo cp evil /etc/passwd    -> []
 *        env X=1 cp evil /etc/passwd -> []
 *        timeout 5 mv evil /etc/hosts-> []
 *      `copyMoveDests` only matches a segment that STARTS with `cp`/`mv`.
 *
 *   2. EFFECTIVE CWD — a confidently WRONG path, which is worse than a miss
 *      because the fence then checks something that was never written.
 *        cd /etc && tee passwd  -> ["/repo/passwd"]   (the write is /etc/passwd)
 *
 *   3. LAST-TOKEN sed — the redirect displaces the real target.
 *        sed -i s/a/b/ conf.txt > /dev/null -> ["/dev/null"]  (conf.txt invisible)
 *
 * These are the SAME structural blind spots the shell effect authority already
 * closed for hard-deny. The fix is convergence, not a seventh regex: the IR
 * already has resolved argv, redirect targets, and effective-cwd threading.
 *
 * POSTURE THAT MUST SURVIVE. Circumvention is deliberately conservative —
 * "FALSE NEGATIVES over FALSE POSITIVES" — because a false write-effect blocks
 * legitimate work. So the paired-control corpus is load-bearing here: finding
 * MORE writes is only an improvement if it finds no writes that are not there.
 *
 * FAIL-OPEN IS NOT ACCEPTABLE. Unlike hard-deny (deny-widening only, where a
 * dead parser safely degrades), losing detection here means a deny authority
 * stops denying. So when the parser is not ready the regex set remains as the
 * floor; the IR only ever ADDS to what the regexes already found.
 */

import { describe, expect, test } from "bun:test"
import { extractShellWritePaths } from "@/permission"
import { initShellEffectParser } from "@/permission/shell"

const CWD = "/repo"
const paths = (cmd: string): readonly string[] => [...extractShellWritePaths(cmd, CWD)].sort()

describe("B-W1 vehicle heads — a deny authority must not fail open", () => {
  test.each([
    ["sudo cp evil /etc/passwd", "/etc/passwd"],
    ["env X=1 cp evil /etc/passwd", "/etc/passwd"],
    ["timeout 5 mv evil /etc/hosts", "/etc/hosts"],
    ["nohup cp evil /etc/motd &", "/etc/motd"],
  ])("%s writes %s", async (cmd, target) => {
    await initShellEffectParser()
    expect({ cmd, found: paths(cmd) }).toEqual({ cmd, found: [target] })
  })
})

describe("B-W2 effective cwd — a relative target resolves against the cd, not the caller", () => {
  test.each([
    ["cd /etc && tee passwd", "/etc/passwd"],
    ["cd /etc; sed -i s/a/b/ hosts", "/etc/hosts"],
    ["cd /etc && echo x > motd", "/etc/motd"],
  ])("%s writes %s", async (cmd, target) => {
    await initShellEffectParser()
    expect({ cmd, found: paths(cmd) }).toEqual({ cmd, found: [target] })
  })
})

describe("B-W3 sed -i — the edit target is the operand, not the last token", () => {
  test("a trailing redirect does not displace the in-place target", async () => {
    await initShellEffectParser()
    // BOTH are writes: the in-place edit AND the redirect destination.
    expect(paths("sed -i s/a/b/ conf.txt > /dev/null")).toEqual(["/dev/null", "/repo/conf.txt"])
  })
})

describe("B-W4 PAIRED CONTROL — everything the regexes already got, unchanged", () => {
  // The load-bearing half. A "fix" that reported a write for every command would
  // satisfy W1–W3 and make the circumvention detector useless, which is exactly
  // the FN>FP posture this module is built on.
  test.each([
    ["echo hi > out.txt", ["/repo/out.txt"]],
    ["tee log.txt", ["/repo/log.txt"]],
    ["cp a b", ["/repo/b"]],
    ["sed -i s/x/y/ f.ts", ["/repo/f.ts"]],
    ["dd if=/dev/zero of=/tmp/z", ["/tmp/z"]],
    ["cat file.txt", []],
    ["ls -la", []],
    ["grep -rn TODO src/", []],
    ["git status", []],
    ["bun test tests/unit", []],
    ["echo hello", []],
    ["cat a.txt | grep x", []],
    ["diff -u a.txt b.txt", []],
    ["rm -rf ./build", []],
  ])("%s -> %j", async (cmd, expected) => {
    await initShellEffectParser()
    expect({ cmd, found: paths(cmd) }).toEqual({ cmd, found: expected })
  })

  test("a computed / $VAR target is still an accepted false-negative", async () => {
    await initShellEffectParser()
    // `isLiteralPathToken` rejects `$`/glob/`~` forms on purpose: a guessed path
    // produces a WRONG signature, which is worse than none.
    expect(paths("echo x > $TARGET")).toEqual([])
    expect(paths("cp a $DEST")).toEqual([])
  })

  test("an fd-dup is not a file write", async () => {
    await initShellEffectParser()
    // `2>&1` redirects to a DESCRIPTOR. Guarded by skipping any redirect that
    // carries a dup operator.
    expect(paths("cmd 2>&1")).toEqual([])
  })

  test("`>&FILE` sends BOTH streams to a file — that is a write", async () => {
    await initShellEffectParser()
    // Whether a redirect names a FILE or a DESCRIPTOR is decided by the OPERAND,
    // not the operator: `>&1` dups, `>&out.log` writes. Both the old regexes and
    // an operator-level skip missed this one — a silent false negative in a deny
    // authority. Found by auditing why an operator skip was unfalsifiable.
    expect(paths("cmd >&out.log")).toEqual(["/repo/out.log"])
    expect(paths("cmd &>out.log")).toEqual(["/repo/out.log"])
  })

  test("an fd-PREFIXED file redirect names the file, never the descriptor", async () => {
    await initShellEffectParser()
    // `cmd 2>err.log` lowers to `file_descriptor "2" / > / word "err.log"`.
    // The descriptor is a sibling of the target, so an operand filter that only
    // skipped OPERATORS would emit `2` as a path — a fabricated write effect.
    // This is what the positive target-type allowlist prevents, and the dup-
    // operator skip above does NOT cover it (there is no dup operator here).
    expect(paths("cmd 2>err.log")).toEqual(["/repo/err.log"])
  })
})

describe("B-W5 FLOOR — an unarmed parser never loses what the regexes found", () => {
  test("the regex-detected set survives with the parser unavailable", async () => {
    const { __resetShellEffectParserForTest } = await import("@/permission/shell")
    __resetShellEffectParserForTest()
    try {
      // Unlike hard-deny (deny-widening only), this feeds a DENY authority:
      // losing detection would stop the fence from fencing. The IR may only ADD.
      expect(paths("echo hi > out.txt")).toEqual(["/repo/out.txt"])
      expect(paths("cp a b")).toEqual(["/repo/b"])
      expect(paths("dd if=/dev/zero of=/tmp/z")).toEqual(["/tmp/z"])
    } finally {
      await initShellEffectParser()
    }
  })
})
