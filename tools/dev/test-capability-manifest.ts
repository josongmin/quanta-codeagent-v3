/**
 * `tools/dev/test-capability-manifest` — the SSOT for which tests need a REAL
 * external capability, which capability, and where that capability is allowed
 * to be required.
 *
 * # Why this file exists
 *
 * The repo already had a capability LANE (`*-real-e2e.test.ts` +
 * `QUANTA_REAL_TOOLCHAIN_E2E`, run by `test:real-toolchain`), but it existed
 * only as a filename suffix and an env var. Nothing anywhere said WHICH tools a
 * given file needs, whether a merge is allowed to block on it, or how many
 * files/cases must actually EXECUTE before the lane's green means anything.
 *
 * Three measured consequences of that gap, all at HEAD:
 *
 *   1. All 17 lane files were ALSO in ordinary `pr`/`full` membership, so a
 *      campaign paid their module load twice — once env-gated to skip inside
 *      the ordinary suite, once for real in the capability gate. Measured:
 *      `--tier=prepush`, `--tier=pr` and `--tier=full` produced the IDENTICAL
 *      digest, i.e. the lane split was a command, never a membership.
 *   2. `package.json`'s `test:real-toolchain` is `bun test $(find tests/unit
 *      -name '*-real-e2e.test.ts') --parallel=1` — one serial blob mixing a
 *      600s upstream astropy clone/build and a live-Ollama inference with
 *      bounded, deterministic LSP probes. One `PASS` line covers all of it, and
 *      a host with none of the tools prints the same line.
 *   3. There was no floor on EXECUTION. A job where every arm skipped is
 *      indistinguishable from one where every arm ran.
 *
 * # What a group is
 *
 * A group is (exact member file ids) × (the external tools/daemons it needs) ×
 * (the lane it may block) × (a minimum EXECUTED floor). `lane` answers "may a
 * merge block on this?"; `minExecuted*` answers "did the thing actually run?".
 *
 * # membershipAuthority — why declaring is not the same as moving
 *
 * Declaring a file here is a statement about the WORLD (it needs docker). Moving
 * a file out of the ordinary tiers is a statement about the RUNNER, and it is
 * only safe when the file itself refuses to do its expensive work in the
 * ordinary lane. So membership authority is explicit per group:
 *
 *   - `lane-gated`          the members carry this repo's own lane contract —
 *                           the `-real-e2e.test.ts` suffix AND the
 *                           `QUANTA_REAL_TOOLCHAIN_E2E` env gate, which
 *                           `package.json` and `gate-manifest.ts` both already
 *                           treat as the lane. Reading that contract is what
 *                           licenses removing them from ordinary membership.
 *                           `assertCapabilityManifest` PROVES both halves from
 *                           source, so the manifest cannot quietly lane-gate an
 *                           ungated file.
 *   - `declared-pending-gate` the members genuinely need the capability but do
 *                           NOT yet carry a lane gate (they spawn at module
 *                           load today). Removing them from ordinary membership
 *                           would drop coverage silently, so tier membership is
 *                           UNCHANGED until their owner lands the gate. The
 *                           `owner` field names who.
 *   - `out-of-band`         the members are not in any shard-runner suite root
 *                           (`tests/contract`, `tests/e2e-pty`), so there is no
 *                           tier membership to change. Declared so CI fan-out
 *                           and the capability fingerprint still see them.
 *
 * Only `lane-gated` groups change tier membership. That is the whole reason the
 * field exists: an honest manifest that is ahead of the runner, rather than a
 * runner change that silently deletes coverage.
 */

import {
  DAEMON_STATE_PROBES,
  EXTERNAL_TOOLS,
  PYTHON_CAPABILITY_MODULES,
} from "./external-toolchain"
import { requiredProducerIds } from "./verification-required-producers"

/**
 * The aggregator's closed set of producer ids. Read, never re-declared.
 *
 * LAZY, and that is load-bearing: this module and
 * `verification-required-producers.ts` now reference each other — the
 * producers derive their floors from these groups, and this file validates its
 * `producer` fields against their ids. Evaluated at module scope, whichever
 * module loaded second saw the other half-initialized. MEASURED, both
 * directions: importing the producers first threw "Cannot access
 * 'requiredProducerIds' before initialization"; importing this file first threw
 * inside `capabilityFloorFor`. `typecheck` reports neither.
 */
let requiredProducerIdSet: ReadonlySet<string> | undefined
const requiredProducerIdsCached = (): ReadonlySet<string> => {
  requiredProducerIdSet ??= new Set(requiredProducerIds())
  return requiredProducerIdSet
}

/** Where a group's failure is allowed to block. */
export type CapabilityLane =
  /** Deterministic once its tools are provisioned; a PR may block on it. */
  | "pr-required-deterministic"
  /** Network, live model, upstream clone, or a wall-clock budget in minutes. */
  | "nightly-heavy"

export type MembershipAuthority = "lane-gated" | "declared-pending-gate" | "out-of-band"

/**
 * A capability requirement. `kind` says what "present" MEANS, because a
 * binary's inode is not a live daemon: `binary` is satisfied by PATH
 * resolution, `daemon` needs the service to actually answer.
 */
export interface CapabilityNeed {
  readonly id: string
  readonly kind: "binary" | "module" | "daemon" | "platform"
  /** How a runner obtains it. Empty means "cannot be provisioned here". */
  readonly provision: string
}

export interface CapabilityGroup {
  readonly id: string
  readonly lane: CapabilityLane
  readonly membershipAuthority: MembershipAuthority
  /** Who owns closing the gap when authority is `declared-pending-gate`. */
  readonly owner: string
  /** One line: what this group proves that nothing else does. */
  readonly why: string
  /**
   * Which EXISTING required-producer this group's executed counts roll up into.
   *
   * NOT a second artifact schema. `tools/dev/capability-result.ts` already
   * reduces a lane's JUnit into `quanta.capability-result.v1`, and
   * `tools/dev/verification-required-producers.ts` already validates a
   * `CapabilityFloor` against it — for three COARSE producers (`pty`,
   * `toolchain`, `contract`) whose floor is 1 file / 1 case. This field makes
   * each group a refinement of one of those, so the fan-out can publish
   * per-group artifacts without the aggregator learning a new vocabulary.
   *
   * `full-suite` is the honest answer for a `declared-pending-gate` group: its
   * members still execute inside the ordinary suite, and `full-suite` carries
   * NO capability floor — i.e. their execution is currently unprovable, which
   * is the gap the authority field exists to make visible.
   */
  readonly producer: string
  /** The env var that selects the lane, for `lane-gated` groups. */
  readonly envGate?: string
  readonly needs: readonly CapabilityNeed[]
  /** EXACT member file ids, repo-relative. Never a glob. */
  readonly members: readonly string[]
  /** Fewest member FILES that must report `executed` for the group to pass. */
  readonly minExecutedFiles: number
  /** Fewest test CASES that must report `executed`. */
  readonly minExecutedCases: number
  /**
   * Fields the group's receipt must carry beyond the tool fingerprint, because
   * the same tool at the same version can still produce a different run (an
   * upstream commit moved, a wheel was rebuilt against a new ABI).
   */
  readonly receiptFields: readonly string[]
}

const bin = (id: string, provision: string): CapabilityNeed => ({
  id,
  kind: "binary",
  provision,
})

/**
 * The groups.
 *
 * Harvested from the 17 files' OWN skip predicates, not guessed: every `needs`
 * entry below is a binary/daemon one of that group's members actually resolves
 * before deciding to run.
 */
export const CAPABILITY_GROUPS: readonly CapabilityGroup[] = [
  // ── PR-required deterministic ────────────────────────────────────────────
  {
    id: "lsp-rust",
    lane: "pr-required-deterministic",
    membershipAuthority: "lane-gated",
    producer: "toolchain",
    owner: "verification-rail",
    why: "the PRODUCTION evidenceLspStatic port against a REAL rust-analyzer; the replay test proves the fusion, not that a live server answers",
    envGate: "QUANTA_REAL_TOOLCHAIN_E2E",
    needs: [
      bin("cargo", "rustup toolchain install stable"),
      bin("rust-analyzer", "rustup component add rust-analyzer"),
    ],
    members: [
      "tests/unit/evidence-lsp-bridge-real-e2e.test.ts",
      "tests/unit/lsp/rust-analyzer-real-e2e.test.ts",
      "tests/unit/tool/evidence/keystone-real-e2e.test.ts",
    ],
    minExecutedFiles: 3,
    minExecutedCases: 4,
    receiptFields: ["rustAnalyzerVersion", "cargoVersion"],
  },
  {
    id: "lsp-go",
    lane: "pr-required-deterministic",
    membershipAuthority: "lane-gated",
    producer: "toolchain",
    owner: "verification-rail",
    why: "the `.go` → GoplsAdapter wiring driving a real gopls at a failure site",
    envGate: "QUANTA_REAL_TOOLCHAIN_E2E",
    needs: [bin("go", "actions/setup-go"), bin("gopls", "go install golang.org/x/tools/gopls")],
    members: ["tests/unit/evidence-lsp-bridge-go-real-e2e.test.ts"],
    minExecutedFiles: 1,
    minExecutedCases: 2,
    receiptFields: ["goVersion", "goplsVersion"],
  },
  {
    id: "lsp-pyright",
    lane: "pr-required-deterministic",
    membershipAuthority: "lane-gated",
    producer: "toolchain",
    owner: "verification-rail",
    why: "a real pyright must SERVE a per-instance sandbox; every other pyright test injects a fake client, so an inert-at-the-sandbox regression passes the whole default suite",
    envGate: "QUANTA_REAL_TOOLCHAIN_E2E",
    needs: [bin("pyright-langserver", "npm i -g pyright"), bin("python3", "actions/setup-python")],
    members: ["tests/unit/evidence-lsp-bridge-pyright-real-e2e.test.ts"],
    minExecutedFiles: 1,
    minExecutedCases: 1,
    receiptFields: ["pyrightVersion", "pythonVersion"],
  },
  {
    id: "lsp-typescript",
    lane: "pr-required-deterministic",
    membershipAuthority: "lane-gated",
    producer: "toolchain",
    owner: "verification-rail",
    why: "a real bun-test failure localized by parseNodeTest, then enriched by a real typescript-language-server — the JS/TS half of the evidence keystone",
    envGate: "QUANTA_REAL_TOOLCHAIN_E2E",
    needs: [
      bin("bun", "oven-sh/setup-bun"),
      bin("typescript-language-server", "npm i -g typescript-language-server typescript"),
    ],
    members: ["tests/unit/evidence-node-failure-static-real-e2e.test.ts"],
    minExecutedFiles: 1,
    minExecutedCases: 1,
    receiptFields: ["typescriptLanguageServerVersion", "bunVersion"],
  },
  {
    id: "node-runtime-cdp",
    lane: "pr-required-deterministic",
    membershipAuthority: "lane-gated",
    producer: "toolchain",
    owner: "verification-rail",
    why: "the only NON-DAP runtime carrier — node speaks CDP, so this is the one arm that proves the carrier abstraction is real",
    envGate: "QUANTA_REAL_TOOLCHAIN_E2E",
    needs: [bin("node", "actions/setup-node")],
    members: ["tests/unit/tool/evidence/runtime-node-real-e2e.test.ts"],
    minExecutedFiles: 1,
    minExecutedCases: 1,
    receiptFields: ["nodeVersion"],
  },
  {
    id: "js-test-runner",
    lane: "pr-required-deterministic",
    membershipAuthority: "lane-gated",
    producer: "toolchain",
    owner: "verification-rail",
    why: "jest (transformed ⇒ runtime degrades to null) and mocha (in-proc ⇒ runtime captures) are the two halves of the honest JS runner-routing contract",
    envGate: "QUANTA_REAL_TOOLCHAIN_E2E",
    needs: [bin("node", "actions/setup-node"), bin("npm", "actions/setup-node")],
    members: [
      "tests/unit/tool/evidence/runtime-jest-real-e2e.test.ts",
      "tests/unit/tool/evidence/runtime-mocha-real-e2e.test.ts",
    ],
    minExecutedFiles: 2,
    minExecutedCases: 2,
    // The install is PINNED and bounded (see JS_RUNNER_FIXTURES); the receipt
    // has to carry the exact version or "jest passed" names no artifact.
    receiptFields: ["nodeVersion", "npmVersion", "jestVersion", "mochaVersion"],
  },
  {
    id: "language-test-matrix",
    lane: "pr-required-deterministic",
    membershipAuthority: "lane-gated",
    producer: "toolchain",
    owner: "verification-rail",
    why: "the normalized {passed, failed:[{name,file,line}]} shape over three REAL runners; a parser that stops matching returns an empty failure list and every fake-backed test still passes",
    envGate: "QUANTA_REAL_TOOLCHAIN_E2E",
    needs: [
      bin("go", "actions/setup-go"),
      bin("cargo", "rustup toolchain install stable"),
      bin("python3", "actions/setup-python"),
    ],
    members: ["tests/unit/tool/testrun/run-tests-real-e2e.test.ts"],
    minExecutedFiles: 1,
    minExecutedCases: 3,
    receiptFields: ["goVersion", "cargoVersion", "pythonVersion"],
  },

  // ── nightly-heavy ────────────────────────────────────────────────────────
  {
    id: "native-debugger",
    lane: "nightly-heavy",
    membershipAuthority: "lane-gated",
    producer: "toolchain",
    owner: "verification-rail",
    why: "debugpy / lldb-dap / dlv / clangd runtime capture. ubuntu-latest ships NONE of clangd, lldb-dap, dlv or debugpy, so a PR-required arm here would be a permanent visible skip pretending to be a gate",
    envGate: "QUANTA_REAL_TOOLCHAIN_E2E",
    needs: [
      bin("python3", "actions/setup-python"),
      { id: "debugpy", kind: "module", provision: "pip install debugpy" },
      bin("lldb-dap", "apt-get install lldb"),
      bin("clang++", "apt-get install clang"),
      bin("clangd", "apt-get install clangd"),
      bin("dlv", "go install github.com/go-delve/delve/cmd/dlv"),
      bin("cargo", "rustup toolchain install stable"),
      bin("go", "actions/setup-go"),
    ],
    members: [
      "tests/unit/tool/debug/debugpy-real-e2e.test.ts",
      "tests/unit/tool/evidence/runtime-cpp-real-e2e.test.ts",
      "tests/unit/tool/evidence/runtime-real-e2e.test.ts",
      "tests/unit/tool/evidence/runtime-rust-real-e2e.test.ts",
    ],
    minExecutedFiles: 4,
    minExecutedCases: 6,
    receiptFields: ["debugpyVersion", "lldbDapVersion", "dlvVersion", "clangVersion"],
  },
  {
    id: "python-native-build",
    lane: "nightly-heavy",
    membershipAuthority: "lane-gated",
    producer: "toolchain",
    owner: "verification-rail",
    why: "the astropy repro/proof rail on a REAL upstream base commit — a network clone plus a local C-extension compile, measured in minutes, with a 600s per-command budget",
    envGate: "QUANTA_REAL_TOOLCHAIN_E2E",
    needs: [
      bin("git", "preinstalled"),
      bin("uv", "astral-sh/setup-uv"),
      bin("python3", "actions/setup-python"),
      bin("clang++", "apt-get install clang"),
    ],
    members: ["tests/unit/project-env-astropy-real-e2e.test.ts"],
    minExecutedFiles: 1,
    minExecutedCases: 1,
    // The tool fingerprint cannot see any of these, and each one changes what
    // the build actually compiles.
    receiptFields: [
      "upstreamRepo",
      "upstreamBaseCommit",
      "pythonVersion",
      "uvVersion",
      "compilerAbi",
      "dependencyLockSha256",
    ],
  },
  {
    id: "python-uv-build",
    lane: "nightly-heavy",
    membershipAuthority: "lane-gated",
    producer: "toolchain",
    owner: "verification-rail",
    why: "five real `uv` editable builds proving the project-env materialization (build deps + dep_util source shim) actually changes a build outcome; each arm has a 240s budget and resolves packages from the network",
    envGate: "QUANTA_REAL_TOOLCHAIN_E2E",
    needs: [bin("uv", "astral-sh/setup-uv"), bin("python3", "actions/setup-python")],
    members: ["tests/unit/project-env-sandbox-real-e2e.test.ts"],
    minExecutedFiles: 1,
    minExecutedCases: 5,
    receiptFields: ["uvVersion", "pythonVersion", "dependencyLockSha256"],
  },
  {
    id: "local-model",
    lane: "nightly-heavy",
    membershipAuthority: "lane-gated",
    producer: "toolchain",
    owner: "verification-rail",
    why: "a REAL local LLM inference through the production OpenAIAdapter. Its cost is unbounded relative to machine load (measured 7.4s idle → 151.4s under the integration suite), so no merge may block on it",
    envGate: "QUANTA_REAL_TOOLCHAIN_E2E",
    needs: [
      {
        id: "ollama-daemon",
        kind: "daemon",
        provision: "ollama serve + ollama pull llama3.1:8b",
      },
    ],
    members: ["tests/unit/llm/local-preset-live-real-e2e.test.ts"],
    minExecutedFiles: 1,
    minExecutedCases: 1,
    receiptFields: ["ollamaBaseUrl", "ollamaModel"],
  },

  // ── declared, not yet lane-gated (tier membership UNCHANGED) ─────────────
  {
    id: "browser",
    lane: "nightly-heavy",
    membershipAuthority: "declared-pending-gate",
    producer: "full-suite",
    owner: "TVH-03 browser lane (tests/integration/browser-*)",
    why: "real system Chrome over CDP. These files spawn at MODULE LOAD with no lane env gate, so the runner cannot move them until that gate exists — declaring them here is what makes the gap visible instead of invisible",
    needs: [
      bin("google-chrome", "browser-actions/setup-chrome"),
      bin("google-chrome-stable", "browser-actions/setup-chrome"),
      bin("chromium", "apt-get install chromium"),
      bin("chromium-browser", "apt-get install chromium-browser"),
    ],
    members: [
      "tests/integration/browser-agent-loop-e2e.test.ts",
      "tests/integration/browser-real-chrome-adversarial-e2e.test.ts",
      "tests/integration/browser-real-chrome-e2e.test.ts",
    ],
    minExecutedFiles: 3,
    minExecutedCases: 3,
    receiptFields: ["chromeBinary", "chromeVersion"],
  },
  {
    id: "os-sandbox-bwrap",
    lane: "nightly-heavy",
    membershipAuthority: "declared-pending-gate",
    producer: "full-suite",
    owner: "TVH-03 sandbox lane",
    why: "the bubblewrap fence proven by REAL execution (a write into /etc fails, a workspace read succeeds). Linux-only, so the macOS dev host can only ever report not-selected",
    needs: [
      { id: "linux", kind: "platform", provision: "ubuntu-latest runner" },
      bin("bwrap", "apt-get install bubblewrap"),
    ],
    members: ["tests/integration/os-sandbox-bwrap-real-exec-e2e.test.ts"],
    minExecutedFiles: 1,
    minExecutedCases: 1,
    receiptFields: ["platform", "bwrapVersion"],
  },
  {
    id: "docker-lima",
    lane: "nightly-heavy",
    membershipAuthority: "declared-pending-gate",
    producer: "full-suite",
    owner: "TVH-03 container lane",
    why: "a real container runtime. `docker` on PATH is NOT a running daemon and `limactl` on PATH is NOT a booted VM — the difference decides whether these execute or skip, and the binary fingerprint cannot see it",
    needs: [
      { id: "docker-daemon", kind: "daemon", provision: "docker desktop / dockerd" },
      { id: "lima-vm", kind: "daemon", provision: "limactl start" },
    ],
    members: ["tests/integration/docker-sandbox-e2e.test.ts"],
    minExecutedFiles: 1,
    minExecutedCases: 1,
    receiptFields: ["dockerServerVersion", "limaInstance"],
  },

  // ── out-of-band (no shard-runner tier membership exists) ─────────────────
  {
    id: "contract-docker",
    lane: "pr-required-deterministic",
    membershipAuthority: "out-of-band",
    producer: "contract",
    owner: "contract lane",
    why: "the contract suite's docker arms, which the required CI job runs with REQUIRE_CONTRACT=1 so an absent dependency is a hard fail. nightly has no such job today, which is how the same gate can skip its way to green",
    needs: [{ id: "docker-daemon", kind: "daemon", provision: "docker desktop / dockerd" }],
    members: ["tests/contract/remote-cli-docker.test.ts", "tests/contract/sandbox-docker.test.ts"],
    minExecutedFiles: 2,
    minExecutedCases: 2,
    receiptFields: ["dockerServerVersion", "requireContract"],
  },
  {
    id: "contract-lsp-lance",
    lane: "pr-required-deterministic",
    membershipAuthority: "out-of-band",
    producer: "contract",
    owner: "contract lane",
    why: "per-file serial probes of TypeScript/Pyright/Lance today; the group exists so the probe happens ONCE per job and the files consume its receipt",
    needs: [
      bin("typescript-language-server", "npm i -g typescript-language-server typescript"),
      bin("pyright-langserver", "npm i -g pyright"),
      bin("python3", "actions/setup-python"),
    ],
    members: [
      "tests/contract/lance-real-wire.test.ts",
      "tests/contract/lsp-pyright.test.ts",
      "tests/contract/lsp-typescript.test.ts",
    ],
    minExecutedFiles: 3,
    minExecutedCases: 3,
    receiptFields: ["typescriptLanguageServerVersion", "pyrightVersion", "lancedbVersion"],
  },
  {
    id: "pty",
    lane: "pr-required-deterministic",
    membershipAuthority: "out-of-band",
    producer: "pty",
    owner: "pty lane",
    why: "raw-mode interactive CLI e2e over a real pty. The required job can succeed today with PTY_AVAILABLE=false across all 8 files — a visible skip with no executed floor",
    needs: [{ id: "pty", kind: "platform", provision: "openpty via FFI on the runner" }],
    members: [
      "tests/e2e-pty/cli-approval-preflight-prefix-e2e.test.ts",
      "tests/e2e-pty/cli-goal-pursuit-e2e.test.ts",
      "tests/e2e-pty/cli-hunk-approval-e2e.test.ts",
      "tests/e2e-pty/cli-input-layer-e2e.test.ts",
      "tests/e2e-pty/cli-model-persistence-e2e.test.ts",
      "tests/e2e-pty/cli-stale-read-guard-e2e.test.ts",
      "tests/e2e-pty/cli-turn-layer-e2e.test.ts",
      "tests/e2e-pty/cli-usage-accounting-resume-e2e.test.ts",
    ],
    minExecutedFiles: 8,
    minExecutedCases: 8,
    receiptFields: ["ptyAvailable", "platform"],
  },
]

/**
 * Pinned fixture versions for the two groups that used to `npm i <name>` with
 * no version and no timeout, at MODULE LOAD.
 *
 * "jest passed" names no artifact unless the version is written down: the two
 * tests pin OPPOSITE contracts (jest's transform defeats a file:line CDP
 * breakpoint ⇒ runtime null; mocha runs in-proc ⇒ runtime captures), and a
 * major bump can flip either one. A floating install turns that into a
 * mystery rather than a red with a version in it.
 */
export const JS_RUNNER_FIXTURES = {
  jest: "29.7.0",
  mocha: "10.8.2",
} as const

/** Hard ceiling on a fixture install. An install with no timeout is not a test
 *  step, it is a hang with a PASS printed after it. */
export const FIXTURE_INSTALL_TIMEOUT_MS = 180_000

/**
 * Per-group floors in the EXACT shape `verification-required-producers.ts`
 * already validates (`CapabilityFloor`), so the fan-out reuses the existing
 * `quanta.capability-result.v1` rail rather than growing a second one.
 *
 * Today three coarse producers (`pty`, `toolchain`, `contract`) carry a
 * `ZERO_EXECUTION_FLOOR` of 1 file / 1 case. That is enough to catch "the job
 * executed literally nothing" and nothing else: a `toolchain` job where 16 of
 * 17 files skipped and one ran clears it. These are the per-group numbers the
 * fanned-out jobs should carry instead.
 */
export interface CapabilityProducerFloor {
  readonly id: string
  /** The coarse required-producer this group refines. */
  readonly producer: string
  readonly lane: CapabilityLane
  readonly minimumExecutedFiles: number
  readonly minimumExecutedCases: number
}

export const capabilityProducerFloors = (
  groups: readonly CapabilityGroup[] = CAPABILITY_GROUPS,
): readonly CapabilityProducerFloor[] =>
  groups.map((group) => ({
    id: group.id,
    producer: group.producer,
    lane: group.lane,
    minimumExecutedFiles: group.minExecutedFiles,
    minimumExecutedCases: group.minExecutedCases,
  }))

export const capabilityGroup = (id: string): CapabilityGroup | undefined =>
  CAPABILITY_GROUPS.find((group) => group.id === id)

/** Groups whose membership the shard runner is allowed to act on. */
export const laneGatedGroups = (): readonly CapabilityGroup[] =>
  CAPABILITY_GROUPS.filter((group) => group.membershipAuthority === "lane-gated")

export interface CapabilityMembership {
  readonly groupId: string
  readonly lane: CapabilityLane
  readonly envGate: string
}

const membershipIndex = (): ReadonlyMap<string, CapabilityMembership> => {
  const index = new Map<string, CapabilityMembership>()
  for (const group of laneGatedGroups()) {
    for (const member of group.members) {
      index.set(member, {
        groupId: group.id,
        lane: group.lane,
        envGate: group.envGate ?? "",
      })
    }
  }
  return index
}

let cachedMembership: ReadonlyMap<string, CapabilityMembership> | undefined

/** The lane-gated group a test id belongs to, or undefined. */
export const capabilityMembershipFor = (id: string): CapabilityMembership | undefined => {
  cachedMembership ??= membershipIndex()
  return cachedMembership.get(id)
}

/** Every lane-gated member id, sorted. */
export const laneGatedMemberIds = (): readonly string[] =>
  [...membershipIndex().keys()].sort((left, right) => left.localeCompare(right))

/**
 * A stable fingerprint of one group's CONTRACT — its lane, its declared needs,
 * its members and its executed floors.
 *
 * Consumed by the receipt layer: dropping a tool from `needs` makes a job that
 * no longer provisions it look identical to one that did, so the fingerprint
 * has to move when the declaration moves.
 */
export const capabilityGroupFingerprint = (group: CapabilityGroup): string =>
  new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        id: group.id,
        lane: group.lane,
        membershipAuthority: group.membershipAuthority,
        producer: group.producer,
        envGate: group.envGate ?? null,
        needs: group.needs.map((need) => `${need.kind}:${need.id}`),
        members: [...group.members].sort((left, right) => left.localeCompare(right)),
        minExecutedFiles: group.minExecutedFiles,
        minExecutedCases: group.minExecutedCases,
        receiptFields: [...group.receiptFields].sort((left, right) => left.localeCompare(right)),
      }),
    )
    .digest("hex")

/** Every binary the manifest declares, for the toolchain-fingerprint drift guard. */
export const declaredCapabilityBinaries = (): readonly string[] =>
  [
    ...new Set(
      CAPABILITY_GROUPS.flatMap((group) =>
        group.needs.filter((need) => need.kind === "binary").map((need) => need.id),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right))

export interface CapabilityManifestProblem {
  readonly groupId: string
  readonly message: string
}

/**
 * Structural validation of the manifest itself, with NO filesystem access, so
 * it can run anywhere. The source-level checks (does the member actually carry
 * the env gate?) live in the test, which has the repo.
 */
interface ManifestUniverses {
  readonly binaries: ReadonlySet<string>
  readonly modules: ReadonlySet<string>
  readonly daemons: ReadonlySet<string>
}

const needProblems = (
  group: CapabilityGroup,
  need: CapabilityNeed,
  known: ManifestUniverses,
): readonly CapabilityManifestProblem[] => {
  const problems: CapabilityManifestProblem[] = []
  if (need.provision.trim() === "") {
    problems.push({ groupId: group.id, message: `need ${need.id} has no provisioning path` })
  }
  if (need.kind === "binary" && !known.binaries.has(need.id)) {
    problems.push({
      groupId: group.id,
      message:
        `declared binary \`${need.id}\` is absent from EXTERNAL_TOOLS, so gaining or ` +
        "losing it leaves an exact verification receipt reusable",
    })
  }
  if (need.kind === "module" && !known.modules.has(need.id)) {
    problems.push({
      groupId: group.id,
      message:
        `declared interpreter module \`${need.id}\` is absent from ` +
        "PYTHON_CAPABILITY_MODULES, so nothing probes it",
    })
  }
  if (need.kind === "daemon" && !known.daemons.has(need.id)) {
    problems.push({
      groupId: group.id,
      message:
        `declared daemon \`${need.id}\` has no entry in DAEMON_STATE_PROBES — a binary's ` +
        "inode is not a live daemon, so without a state probe this need is unobservable",
    })
  }
  return problems
}

const shapeProblems = (group: CapabilityGroup): readonly CapabilityManifestProblem[] => {
  const problems: CapabilityManifestProblem[] = []
  const push = (message: string): void => {
    problems.push({ groupId: group.id, message })
  }
  if (group.why.trim() === "" || group.owner.trim() === "") {
    push("group needs both an owner and a why")
  }
  if (group.needs.length === 0) {
    push("a capability group with no declared needs is not a capability group")
  }
  if (group.members.length === 0) {
    push("a group with zero members can never fail, so it can never be evidence")
  }
  if (group.minExecutedFiles < 1 || group.minExecutedCases < 1) {
    push("executed floors must be at least 1; a zero floor is a job that proves nothing")
  }
  if (group.minExecutedFiles > group.members.length) {
    push(`minExecutedFiles ${group.minExecutedFiles} exceeds ${group.members.length} members`)
  }
  if (group.receiptFields.length === 0) push("no receipt fields declared")
  if (!requiredProducerIdsCached().has(group.producer)) {
    push(
      `producer "${group.producer}" is not a required-producer id — the fan-out would publish a ` +
        "quanta.capability-result.v1 artifact nothing aggregates",
    )
  }
  // A group whose members were REMOVED from the ordinary tiers, or that lives
  // out of band, has no other place to be counted: its producer must be one
  // that actually carries a floor. `full-suite` has none, so claiming it here
  // would be claiming a proof that does not exist.
  if (group.membershipAuthority !== "declared-pending-gate" && group.producer === "full-suite") {
    push(
      "a lane-gated or out-of-band group cannot roll up into `full-suite`: that producer has no " +
        "capability floor, so nothing would ever check that this group executed",
    )
  }
  if (group.membershipAuthority === "lane-gated" && (group.envGate ?? "") === "") {
    push("lane-gated membership requires the env gate that selects the lane")
  }
  return problems
}

/**
 * Structural validation of the manifest itself, with NO filesystem access, so
 * it can run anywhere. The source-level checks (does the member actually carry
 * the env gate?) live in the test, which has the repo.
 */
export const validateCapabilityManifest = (
  groups: readonly CapabilityGroup[] = CAPABILITY_GROUPS,
): readonly CapabilityManifestProblem[] => {
  if (groups.length === 0) {
    return [{ groupId: "<manifest>", message: "no capability groups declared" }]
  }
  const known: ManifestUniverses = {
    binaries: new Set<string>(EXTERNAL_TOOLS),
    modules: new Set<string>(PYTHON_CAPABILITY_MODULES),
    daemons: new Set(DAEMON_STATE_PROBES.map((probe) => probe.id)),
  }
  const problems: CapabilityManifestProblem[] = []
  const seenGroup = new Set<string>()
  const seenMember = new Map<string, string>()
  for (const group of groups) {
    if (seenGroup.has(group.id)) {
      problems.push({ groupId: group.id, message: "duplicate group id" })
    }
    seenGroup.add(group.id)
    problems.push(...shapeProblems(group))
    for (const need of group.needs) problems.push(...needProblems(group, need, known))
    for (const member of group.members) {
      const owner = seenMember.get(member)
      if (owner !== undefined) {
        problems.push({
          groupId: group.id,
          message: `${member} is already a member of ${owner}; membership must be exactly one group`,
        })
      }
      seenMember.set(member, group.id)
    }
  }
  return problems
}

export const assertCapabilityManifest = (
  groups: readonly CapabilityGroup[] = CAPABILITY_GROUPS,
): void => {
  const problems = validateCapabilityManifest(groups)
  if (problems.length === 0) return
  throw new Error(
    `[capability-manifest] ${problems.length} problem(s):\n` +
      problems.map((row) => `  ${row.groupId}: ${row.message}`).join("\n"),
  )
}
