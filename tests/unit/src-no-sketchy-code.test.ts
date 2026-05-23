/**
 * Anti-regression scanner — pins the "no silent fallback / no heuristic"
 * contract across the WHOLE `src/` tree (not just `src/apps/eval/`).
 *
 * The rules below encode the structural invariants the 3-round audit pinned:
 *
 *   - **No string-substring error classification.** Retry / fallback / policy
 *     decisions read `LLMError.kind`/`statusCode`. Anything that does
 *     `e.message.includes(...)` to make a routing decision is a regression.
 *   - **No `process.env` reads outside `runtime-config.ts`.** Every env
 *     variable goes through the frozen `runtimeConfig()` so a garbage value
 *     can't silently flip behavior.
 *   - **No `Math.random()`.** Use `node:crypto.randomBytes` (or `randomUUID`)
 *     for any id/token mint — the collision space matters under parallelism.
 *   - **No empty `catch {}` blocks.** Either log via `@/shared.logger`,
 *     rethrow, or destructure the error into a typed `surface()` event.
 *   - **No `as JailedPath` casts outside `storage/service.ts`.** The brand
 *     is unforgeable BY DESIGN — the only legitimate constructor is
 *     `resolveJailed`.
 *   - **No `as LogLevel` / `as HITLTier` etc. on raw env / unknown.** Use
 *     the validators in `runtime-config.ts` / explicit guards.
 *   - **No magic `setTimeout(..., 5_000 / 30_000 / 60_000 / 120_000 / 180_000)`
 *     literals outside a named `UPPER_SNAKE_CASE` const.**
 *
 * Adding a new file under `src/`? The scan runs against it automatically.
 * If a banned pattern is legitimately required, document why and add the
 * file path to the rule's `allowlist` — that is the audit trail.
 *
 * The rules apply ONLY under `src/`. Test files exercise the violations on
 * purpose; the scanner intentionally does not look at `tests/`.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative } from "node:path"

const SRC = join(__dirname, "..", "..", "src")

interface Rule {
  id: string
  pattern: RegExp
  why: string
  allowlist?: Record<string, string>
}

const RULES: readonly Rule[] = [
  {
    id: "no-process-env-outside-config",
    // Any direct `process.env` access outside the single owner.
    pattern: /\bprocess\.env\b/,
    why: "All env reads must go through `runtimeConfig()` (src/shared/runtime-config.ts) so garbage values are validated + logged at startup.",
    allowlist: {
      "shared/runtime-config.ts": "the single legitimate process.env owner — validates + freezes",
      "apps/cli/dotenv.ts":
        "user-facing dotenv loader writes into process.env BEFORE any module reads runtimeConfig()",
      "apps/cli/index.ts": "CLI bootstraps the same loader before module-level reads",
      "apps/agent/index.ts":
        "unified agent CLI entry — same bootstrap posture as apps/cli/index.ts: loadEnvFiles() runs before the API-key reads in buildLLM/resolveProvider (provider selection is a launch-time decision, not a feature read).",
      "apps/cli/internal.ts":
        "CLI feature-flag bootstrap — threads typed values via AgentConfig; downstream modules never read env directly. TODO(S5): migrate to runtimeConfig progressively.",
      "apps/bench/index.ts": "bench CLI has its own dotenv shim; same bootstrap posture as the CLI",
      "apps/bench/eval/driver.ts":
        "LSP-nav opt-in probe (`QUANTA_LSP_TOOLS=full`) — same gate as CLI; tools register harmlessly without a server. Same posture as the bench CLI's env reads.",
      "apps/eval/index.ts": "eval CLI bootstraps env BEFORE other modules read it (mirrors bench)",
      "apps/probe/index.ts":
        "probe CLI bootstraps env before module loads (same posture as other CLI entries)",
      "tool/git/runner.ts":
        "ENV PROPAGATION (not config read) — copies a hardcoded ALLOWED_ENV set INTO the spawned git child; this is intentional pass-through, not a feature read.",
      "mcp/client.ts":
        "ENV PROPAGATION — passes the parent's PATH so the MCP stdio child can find its binary; not a feature-flag read.",
      "apps/bench/corpus/dataset.ts":
        "ENV PROPAGATION — bench shells out to git/python; child env is intentionally the parent's.",
      "apps/bench/python-swebench.ts":
        "ENV PROPAGATION — same posture as swebench-dataset.ts; the Python harness inherits parent env.",
      "apps/bench/harness/prepare.ts":
        "ENV PROPAGATION — the Python prepare_images subprocess inherits parent env (Docker socket, PATH, HOME for conda).",
      "apps/bench/harness/images.ts":
        "ENV PROPAGATION — Bun.spawn `docker images` inherits parent env (DOCKER_HOST, PATH); not a feature-flag read.",
      "runtime/shell.ts":
        "ENV PROPAGATION — `inheritEnv:true` lets the spawned child see the parent's env directly (used by bench/agent shells); not a feature read.",
      "runtime/sandbox.ts":
        "ENV PROPAGATION — docker sandbox forwards named env vars (a hardcoded ALLOWLIST) to the container; pass-through, not a feature flag.",
      "subagent/handlers-6.ts":
        "ENV PROPAGATION — subagent child-process spawn forwards parent env (merged with `input.env`); same posture as runtime/shell.ts and tool/git/runner.ts — pass-through, not a feature read.",
      "apps/cli/shell-stream-painter.ts":
        "NO_COLOR is the cross-tool no-color.org convention read at the TTY paint boundary (alongside stderr.isTTY); a presentation-layer signal, not a validated feature flag — routing it through runtimeConfig would be over-centralization.",
    },
  },
  {
    id: "no-math-random",
    pattern: /Math\.random\(/,
    why: "Use `node:crypto.randomBytes`/`randomUUID` — Math.random's collision space is too small under parallel runs.",
    allowlist: {
      "agent/retry.ts": "documented non-security jitter; centralized helper, no cross-use",
    },
  },
  {
    id: "no-empty-catch",
    pattern: /catch\s*\(?[\s\S]{0,40}?\)?\s*\{\s*\}/,
    why: "Empty catch swallows errors — log via `@/shared.logger`, rethrow, or surface a typed error event.",
    allowlist: {
      "stream/adapters/jsonl-recorder.ts":
        "explicit best-effort recording of a degraded line — the file already documents the fallthrough",
      "session/store.ts": "ENOENT-style file delete cleanup; absence is the success state",
      "storage/service.ts":
        "realResolve climbs ancestors when a parent doesn't exist (expected, not an error)",
      "runtime/sandbox.ts":
        "kill-after-exited is a benign no-op (audit S6 flagged the wider catch — fix is tracked separately)",
    },
  },
  {
    id: "no-jailed-path-cast",
    pattern: /\bas\s+JailedPath\b/,
    why: "`JailedPath` is brand-typed; the only legitimate constructor is `resolveJailed` in storage/service.ts.",
    allowlist: {
      "storage/service.ts": "the storage seam IS the canonical constructor",
    },
  },
  {
    id: "no-log-level-cast",
    pattern: /\bas\s+LogLevel\b/,
    why: "`as LogLevel` on raw input lets `undefined` flow through `ORDER[...]` and silently drop every log. Use the validator in `runtime-config.ts`.",
    allowlist: {
      "shared/runtime-config.ts":
        "the validator narrows after checking the value is in LOG_LEVEL_SET",
    },
  },
  {
    id: "no-error-message-includes-routing",
    // `e.message.includes(` / `error.message.includes(` / `msg.includes(` —
    // pattern most often used for retry/fallback policy. The fix is to read
    // `LLMError.kind` / `statusCode` instead. Allow `e.message` access for
    // log formatting (most common); this catches the `.includes(` form only.
    pattern: /\b\w*[Mm]essage\.toLowerCase\(\)?\.includes\(|\.\bmessage\.includes\(/,
    why: "Don't route on `e.message.includes(...)` — set `LLMError.kind` at the adapter boundary and branch on the structured field. See `src/shared/errors.ts`.",
  },
  {
    id: "no-undocumented-magic-timeout",
    // Standalone literal that isn't on the right-hand side of a
    // `UPPER_SNAKE_CASE` const declaration.
    pattern:
      /(?<!const\s+[A-Z][A-Z_0-9]*\s*=\s*)(?<![A-Z_0-9])(?:5_000|30_000|60_000|120_000|180_000|240_000)(?!\d)/,
    why: "Wall-clock magic numbers must be bound to a named UPPER_SNAKE_CASE `const` with a comment explaining the choice.",
    allowlist: {
      "agent/loop.ts": "documented session-tuning ladder lives here as inline named constants",
      "agent/compaction.ts": "DEFAULT_THRESHOLD ladder uses inline literals for the ladder",
      "lsp/adapters/base.ts":
        "LSP_REQUEST_TIMEOUT_MS et al. are declared as named consts elsewhere",
    },
  },
  {
    id: "no-locale-compare",
    // `.localeCompare(` — locale/ICU-dependent ordering.
    pattern: /\.localeCompare\(/,
    why: "localeCompare is locale/ICU-dependent → sorted output varies across machines, breaking the byte-identical replay + prompt-cache invariant. Use `byteCompare` from `src/shared/byte-compare.ts`.",
    // No allowlist: all src/ localeCompare call sites were migrated to
    // byteCompare (R6 structural). The whole class is now actively guarded —
    // a new localeCompare anywhere under src/ trips the scan.
  },
  {
    id: "no-raw-number-env",
    // `Number(... process.env ...)` / `parseInt(process.env...)` on one line.
    pattern: /(?:Number|parseInt|parseFloat)\s*\([^)]*process\.env/,
    why: "Parsing process.env with raw Number()/parseInt() yields NaN on garbage input, silently disabling caps/limits. Route through the validated parsers in `runtime-config.ts`. (Currently zero violations — keep it so.)",
  },
  {
    id: "no-date-now-in-domain",
    // `Date.now(` / `new Date(` inside domain layers (agent + permission).
    // Determinism: anything reaching the model-facing prompt or persisted/replayed
    // output must use an injected clock (`opts.now ?? Date.now`); telemetry
    // timestamps are infrastructure and excluded by scope.
    pattern: /\bDate\.now\(|\bnew Date\(/,
    scope: /^(agent|permission)\//,
    why: "Domain layers must inject the clock (`opts.now ?? Date.now`) so model-facing/persisted output is replay-stable. See `src/agent/admissibility-gate.ts` / `src/memory/consolidate/writer.ts` for the established pattern.",
    allowlist: {
      // BURN-DOWN — every entry below uses Date.now()/new Date() in a way
      // that currently reaches a deterministic-replay boundary (or is a default
      // factory the injection pattern delegates to). Each should migrate to
      // `(opts.now ?? Date.now)()` and drop from this allowlist.
      "agent/admissibility-gate.ts": "BURN-DOWN: pre-existing decided-at timestamps",
      "agent/branch-search/isolate.ts": "BURN-DOWN: worktree slug suffix (telemetry-ish, low priority)",
      "agent/branch-search/propose.ts": "BURN-DOWN: candidate proposal timing",
      "agent/branch-search/search.ts": "BURN-DOWN: search round timing",
      "agent/branch-search/verify.ts": "BURN-DOWN: verifier wall-clock",
      "agent/conversation-action.ts": "BURN-DOWN: action timestamp",
      "agent/conversation-summary-archive.ts": "BURN-DOWN: archive entry timestamp",
      "agent/dispatch-dedup.ts": "BURN-DOWN: dedup window default clock",
      "agent/hitl-tier.ts": "BURN-DOWN: HITL override timestamp",
      "agent/ide-context.ts": "BURN-DOWN: ide context default clock",
      "agent/loop.ts": "BURN-DOWN: turnId/startedAt default clock (telemetry — lowest priority)",
      "agent/memory-tools.ts":
        "BURN-DOWN: W6 injected clock+uuid; `Date.now` here is the default-factory fallback",
      "agent/plan-exit-flow.ts": "BURN-DOWN: plan-exit timestamp",
      "agent/prompt.ts":
        "BURN-DOWN: W6 injected `todayDateLine(now)`; the literal `new Date` is the default fallback",
      "agent/repo-rules.ts": "BURN-DOWN: rule freshness timestamp",
      "agent/side-conversation/run.ts": "BURN-DOWN: side-conversation wall-clock",
      "agent/steering.ts": "BURN-DOWN: steering timestamp default",
      "agent/streaming-dispatch.ts": "BURN-DOWN: in-progress indicator timestamp fallback",
      "agent/subagent-runner.ts": "BURN-DOWN: child run timestamp",
      "agent/submission.ts": "BURN-DOWN: W6 injected; default-fallback path uses Date.now",
      "agent/turn-kind.ts": "BURN-DOWN: turn-kind timestamp default",
      "permission/gate-pattern-wire.ts": "BURN-DOWN: pattern gate decidedAt default",
      "permission/post-denial.ts": "BURN-DOWN: post-denial timestamp default",
    },
  },
  {
    id: "no-getDefaultPermissionStore-outside-composition",
    // `getDefaultPermissionStore(` — the singleton accessor. Use ONLY in
    // composition roots (apps/) and in the canonical re-export. Internal
    // code must accept `store: PermissionStore` from the caller.
    pattern: /\bgetDefaultPermissionStore\s*\(/,
    why: "Service-locator: the singleton store must be wired at the composition root (`src/apps/**`) — internal `@/permission` callers and the loop must accept an injected `PermissionStore`. The fallback creates hidden coupling and breaks test isolation.",
    allowlist: {
      "permission/permission-store.ts": "the canonical definition site",
      "permission/index.ts": "barrel re-export",
      "agent/admissibility-gate.ts":
        "composition-adjacent layer; transitional fallback when AgentConfig doesn't thread a store. Remove once apps wire `AgentConfig.permissionStore` explicitly.",
    },
  },
]

const isAllowed = (rule: Rule, relativePath: string): boolean =>
  rule.allowlist !== undefined && Object.hasOwn(rule.allowlist, relativePath)

const walk = (dir: string): readonly string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const s = statSync(full)
    if (s.isDirectory()) out.push(...walk(full))
    else if (extname(name) === ".ts") out.push(full)
  }
  return out
}

interface Violation {
  rule: Rule
  lineNo: number
  line: string
}

const scanFile = (path: string): readonly Violation[] => {
  const text = readFileSync(path, "utf8")
  const lines = text.split("\n")
  const violations: Violation[] = []
  const relPath = relative(SRC, path)
  for (const rule of RULES) {
    if (isAllowed(rule, relPath)) continue
    // Scope: when set, only files whose `relPath` matches the regex are scanned
    // by this rule. Lets a rule target a single slice (e.g. domain layers)
    // without polluting its allowlist with every other slice's legitimate uses.
    if (rule.scope !== undefined && !rule.scope.test(relPath)) continue
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      const trimmed = line.trim()
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue
      if (rule.pattern.test(line)) {
        violations.push({ rule, lineNo: i + 1, line: trimmed })
      }
    }
  }
  return violations
}

describe("src/: anti-regression scan (root-cause invariants)", () => {
  const files = walk(SRC)

  test("every TS file scans clean against the lazy-pattern allowlist", () => {
    const failures: string[] = []
    for (const f of files) {
      const v = scanFile(f)
      for (const { rule, lineNo, line } of v) {
        failures.push(`${relative(SRC, f)}:${lineNo}  [${rule.id}]  ${line}\n    → ${rule.why}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Anti-regression scan tripped ${failures.length} violation(s) under src/:\n\n${failures.join("\n\n")}`,
      )
    }
    expect(failures.length).toBe(0)
  })

  test("scan covers a non-empty file set (smoke)", () => {
    expect(files.length).toBeGreaterThan(80)
  })
})
