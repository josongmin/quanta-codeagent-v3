/**
 * ADR-0249 — deterministic stub for tests.
 *
 * Never spawns a real node process. Returns the closed `NodeReplKernel`
 * port with byte-identical-across-runs behaviour so unit suites do not
 * depend on the host having `node` installed AND do not race on subprocess
 * start-up timing.
 *
 * The stub evaluates a tiny safe subset that is sufficient to exercise
 * the slice's contracts:
 *
 *   - integer arithmetic literals    `1+1` → "2"
 *   - variable assignment            `let x = 42` → ""
 *   - bareword reference             `x`        → "42"  (persists across exec calls)
 *   - explicit throws                `throw new Error("boom")` → hadError:true
 *   - syntax errors                  `let = 1`  → hadError:true (classified)
 *
 * Anything outside this subset yields the marker
 * `"<<unsupported in stub>>"` on stdout with `hadError: false` — the
 * hellgate avoids stepping on those inputs.
 *
 * Production callers MUST NOT wire this stub — it exists for tests only.
 */

import { err, ok, type Result } from "@/shared"
import type {
  KernelListing,
  NodeReplExecOptions,
  NodeReplKernel,
  NodeReplSpawnOptions,
} from "./port"
import { mkId, removeKernel, touchKernel, writeKernel } from "./state-store"
import type { ExecResult, KernelError, KernelId, KernelSpec, KernelState } from "./types"

/** Factory options for the headless stub. Lets tests inject a deterministic
 *  clock + a synthetic pid so byte-identical assertions hold. */
export interface HeadlessStubOptions {
  /** Override for `Date.now()`. Default: a monotonic counter starting
   *  at 1_700_000_000_000 (close enough to a real epoch ms for tests
   *  that only check ordering). */
  readonly clock?: () => number
  /** Synthetic pid the stub returns in every spec. Default 0. */
  readonly pid?: number
  /** Filesystem `HOME` for the on-disk handle. When provided, the stub
   *  writes / removes `{id}.json` like the real adapter — lets tests
   *  verify the state-store contract end-to-end. */
  readonly home?: string
}

interface StubKernel {
  spec: KernelSpec
  state: KernelState
  /** Variable bindings — the persistence unit. */
  vars: Map<string, string>
  /** True while an exec is in flight (one-shot, then false on resolve). */
  running: boolean
}

/** Build a deterministic `NodeReplKernel`. The returned object holds a
 *  private kernel map; calling `headlessStub()` twice yields two
 *  independent stubs (tests can isolate fixtures). */
export const headlessStub = (opts: HeadlessStubOptions = {}): NodeReplKernel => {
  const home = opts.home
  const pid = opts.pid ?? 0
  let monotonic = 1_700_000_000_000
  const clock = opts.clock ?? (() => ++monotonic)

  const kernels = new Map<KernelId, StubKernel>()

  const writeIfHome = (spec: KernelSpec): void => {
    if (home !== undefined) writeKernel(spec, home)
  }
  const touchIfHome = (id: KernelId, ms: number): void => {
    if (home !== undefined) touchKernel(id, ms, home)
  }
  const removeIfHome = (id: KernelId): void => {
    if (home !== undefined) removeKernel(id, home)
  }

  return {
    async spawn(spawnOpts: NodeReplSpawnOptions): Promise<Result<KernelSpec, KernelError>> {
      if (spawnOpts.signal?.aborted === true) {
        return err({ kind: "spawn-failed", detail: "aborted before spawn" })
      }
      const idStr = mkId(spawnOpts.id)
      if (idStr === null) {
        return err({ kind: "invalid-id", raw: spawnOpts.id ?? "" })
      }
      const id = idStr as KernelId
      const now = clock()
      const spec: KernelSpec = {
        id,
        pid,
        startedAtMs: now,
        lastUseMs: now,
        sessionId: spawnOpts.sessionId,
      }
      kernels.set(id, {
        spec,
        state: "ready",
        vars: new Map(),
        running: false,
      })
      writeIfHome(spec)
      return ok(spec)
    },

    async exec(
      id: KernelId,
      code: string,
      execOpts?: NodeReplExecOptions,
    ): Promise<Result<ExecResult, KernelError>> {
      const k = kernels.get(id)
      if (k === undefined || k.state === "dead") {
        return err({ kind: "kernel-dead", id })
      }
      if (execOpts?.signal?.aborted === true) {
        k.state = "dead"
        removeIfHome(id)
        return err({ kind: "exec-aborted", id })
      }
      k.state = "running"
      k.running = true
      try {
        const out = evalSubset(code, k.vars)
        const now = clock()
        const next: KernelSpec = { ...k.spec, lastUseMs: now }
        k.spec = next
        touchIfHome(id, now)
        return ok({
          id,
          stdout: out.stdout,
          stderr: out.stderr,
          hadError: out.hadError,
        })
      } finally {
        k.running = false
        // dead-on-abort branch above already short-circuited
        if (k.state === "running") k.state = "idle"
      }
    },

    status(id: KernelId): KernelState {
      const k = kernels.get(id)
      return k?.state ?? "dead"
    },

    async kill(id: KernelId): Promise<void> {
      const k = kernels.get(id)
      if (k === undefined) return
      k.state = "dead"
      k.running = false
      removeIfHome(id)
    },

    list(): ReadonlyArray<KernelListing> {
      const out: KernelListing[] = []
      for (const k of kernels.values()) {
        out.push({
          spec: k.spec,
          state: k.state,
          inUse: k.state === "running",
        })
      }
      return out
    },
  }
}

interface StubEval {
  stdout: string
  stderr: string
  hadError: boolean
}

const ASSIGN_RE = /^\s*(?:let|const|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(.+?)\s*;?\s*$/
const ARITH_RE = /^\s*(-?\d+)\s*([+\-*/])\s*(-?\d+)\s*;?\s*$/
const IDENT_RE = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;?\s*$/
const INT_LITERAL_RE = /^\s*(-?\d+)\s*;?\s*$/
const STRING_LITERAL_RE = /^\s*(['"])(.*)\1\s*;?\s*$/
const THROW_RE = /^\s*throw\s+new\s+Error\s*\(\s*(['"])(.*?)\1\s*\)\s*;?\s*$/
// Surface-level syntax-error sniff. Real node would compile-fail; the
// stub recognises the common shapes the hellgate needs.
const SYNTAX_BAD_RE = /^\s*(?:let|const|var)\s*=/

const ok_ = (stdout: string): StubEval => ({ stdout, stderr: "", hadError: false })
const stubFail = (stderr: string): StubEval => ({ stdout: "", stderr, hadError: true })
const unsupported = (): StubEval => ok_("<<unsupported in stub>>")

const tryThrow = (s: string): StubEval | null => {
  const m = s.match(THROW_RE)
  if (m === null) return null
  return stubFail(`Error: ${m[2] ?? ""}`)
}

const tryAssign = (s: string, vars: Map<string, string>): StubEval | null => {
  const m = s.match(ASSIGN_RE)
  if (m === null) return null
  const name = m[1]
  const rawValue = m[2]
  if (name === undefined || rawValue === undefined) return stubFail("stub: malformed assign")
  const folded = foldRhs(rawValue, vars)
  if (folded === null) return unsupported()
  vars.set(name, folded)
  return ok_("")
}

const tryArith = (s: string): StubEval | null => {
  const m = s.match(ARITH_RE)
  if (m === null) return null
  const lhs = m[1]
  const op = m[2]
  const rhs = m[3]
  if (lhs === undefined || op === undefined || rhs === undefined) return unsupported()
  return ok_(doArith(lhs, op, rhs))
}

const tryLiteral = (s: string): StubEval | null => {
  const intM = s.match(INT_LITERAL_RE)
  if (intM !== null) return ok_(intM[1] ?? "")
  const strM = s.match(STRING_LITERAL_RE)
  if (strM !== null) return ok_(strM[2] ?? "")
  return null
}

const tryIdent = (s: string, vars: Map<string, string>): StubEval | null => {
  const m = s.match(IDENT_RE)
  if (m === null) return null
  const name = m[1] ?? ""
  const v = vars.get(name)
  if (v === undefined) return stubFail(`ReferenceError: ${name} is not defined`)
  return ok_(v)
}

const evalSubset = (code: string, vars: Map<string, string>): StubEval => {
  // Drop blank input — node would just re-prompt.
  const trimmed = code.trim()
  if (trimmed.length === 0) return ok_("")
  if (SYNTAX_BAD_RE.test(trimmed)) return stubFail("SyntaxError: Unexpected token '='")
  return (
    tryThrow(trimmed) ??
    tryAssign(trimmed, vars) ??
    tryArith(trimmed) ??
    tryLiteral(trimmed) ??
    tryIdent(trimmed, vars) ??
    unsupported()
  )
}

/** Fold a literal-only RHS into the canonical string form the stub stores. */
const foldRhs = (raw: string, vars: Map<string, string>): string | null => {
  const trimmed = raw.trim()
  const intLit = trimmed.match(INT_LITERAL_RE)
  if (intLit !== null) return intLit[1] ?? null
  const strLit = trimmed.match(STRING_LITERAL_RE)
  if (strLit !== null) return strLit[2] ?? null
  const arith = trimmed.match(ARITH_RE)
  if (arith !== null) {
    const lhs = arith[1]
    const op = arith[2]
    const rhs = arith[3]
    if (lhs === undefined || op === undefined || rhs === undefined) return null
    return doArith(lhs, op, rhs)
  }
  // Reference to a previously-bound var
  const ident = trimmed.match(IDENT_RE)
  if (ident !== null) {
    const name = ident[1] ?? ""
    return vars.get(name) ?? null
  }
  return null
}

const doArith = (lhsStr: string, op: string, rhsStr: string): string => {
  const lhs = Number(lhsStr)
  const rhs = Number(rhsStr)
  switch (op) {
    case "+":
      return String(lhs + rhs)
    case "-":
      return String(lhs - rhs)
    case "*":
      return String(lhs * rhs)
    case "/":
      return rhs === 0 ? "Infinity" : String(lhs / rhs)
    default:
      return "<<unsupported in stub>>"
  }
}
