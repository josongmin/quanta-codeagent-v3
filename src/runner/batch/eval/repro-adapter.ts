/**
 * Polyglot repro adapter (RFC jun-29 docs/plans/jun-29-repro-adapter-polyglot).
 *
 * The repro-test rail was Python/pytest from generation → execution → outcome parsing, so a
 * non-Python instance produced ZERO self-verification signal (measured: Pro misses all
 * `execFailure:"infra_unavailable"` — NodeBB=JS has no runner, qutebrowser missing pytest
 * plugins). This contract makes the language a SEAM: one `ReproAdapter` per language owns the
 * script extension, the artifact basenames (the SSOT the hygiene/strip/anchor filters consume —
 * so a non-Python repro can't drift out of sync with those), the exec argv, the validation
 * command, and the outcome parser.
 *
 * PHASE 1 (this module) = the contract + the Python adapter wrapping today's behavior
 * BYTE-IDENTICALLY (default = python), plus fail-closed resolution for unsupported languages.
 * Phase 2 adds the image backend seam + the runtime policy helper that upgrades Pro Python
 * repros into their prebuilt instance image when the image ref is derivable.
 */
import { dirname } from "node:path"
import { classifyPytest, classifyPytestReportText } from "@/agent/repro-test/execute"
import {
  REPRO_SCAFFOLD_ARTIFACT_PATTERNS,
  reproScriptBasename,
} from "@/agent/repro-test/scaffold-patterns"
import type { ReproTestOutcome } from "@/agent/repro-test/types"
import { gateOn } from "@/shared"
import { reproRunArgv } from "../corpus/dataset"
import { normalizeRepoLanguageWithPythonDefault } from "../repo-language"
import type { Instance } from "../types"
import { reproValidationCmd, shellJoin, shellWord } from "./repro-command"

export type ReproLanguage = "python" | "go" | "js" | "ts"

/** Where a repro executes (RFC Phase 2). `host` = the box's uv/project env (today's default).
 *  `image` = INSIDE the instance's prebuilt Docker image — the env already has the correct
 *  toolchain + ALL test deps + matches the grade env, killing the missing-plugin / wrong-base /
 *  non-Python classes that made host-backend repros `infra_unavailable`. */
export type ReproExecBackend = "host" | "image"

/** Context a repro execution needs, language-agnostic. */
export interface ReproExecCtx {
  readonly repo: string | undefined
  readonly version: string | undefined
  readonly scriptPath: string
  /** Default `host`. `image` requires `imageRef` + `sandboxDir` (else buildExecArgv falls back
   *  to host — a missing image is the caller's resolution concern, fail-closed upstream). */
  readonly execBackend?: ReproExecBackend
  /** Docker image reference for the `image` backend (e.g. `jefzda/sweap-images:<tag>`). */
  readonly imageRef?: string
  /** Sandbox dir bind-mounted into the image at the same path (so absolute script paths resolve). */
  readonly sandboxDir?: string
}

/** Pure `docker run --rm` argv that executes `inner` inside `imageRef`, with the sandbox
 *  bind-mounted at its own path so an absolute `scriptPath` resolves identically in-container.
 *  Single-shot/foreground (`--rm`) — distinct from the detached (`-d`) RemoteRunner
 *  `composeDockerRunArgv`, so NOT a duplicate (different lifecycle). */
export const dockerRunReproArgv = (
  imageRef: string,
  sandboxDir: string,
  inner: readonly string[],
): readonly string[] => [
  "docker",
  "run",
  "--rm",
  "-v",
  `${sandboxDir}:${sandboxDir}`,
  "-w",
  sandboxDir,
  imageRef,
  ...inner,
]

const dockerValidationCmd = (imageRef: string, sandboxDir: string, scriptPath: string): string =>
  sandboxDir.startsWith("/")
    ? shellJoin(dockerRunReproArgv(imageRef, sandboxDir, ["python", "-s", scriptPath]))
    : `docker run --rm -v "$PWD":/work -w /work ${shellWord(imageRef)} python -s ${shellWord(scriptPath)}`

/** Evidence the executor collected from a repro run, fed to the language-specific parser. */
export interface ReproEvidence {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
  /** Raw text of the language's structured report sidecar (pytest-report.json / go-test-json /
   *  …), when one was written. Absent ⇒ the parser falls back to stdout classification. */
  readonly sidecarText?: string
}

/** One language's repro contract. Every `.py`-coupled site (artifact filter, snapshot strip,
 *  hygiene, anchor synth) MUST source its pattern from {@link artifactPatterns} so a polyglot
 *  repro stays in sync with the executor (RFC "blast radius"). */
export interface ReproAdapter {
  readonly language: ReproLanguage
  readonly scriptExt: string
  scriptBasename(seq: number, uuid: string): string
  readonly artifactPatterns: readonly RegExp[]
  buildExecArgv(ctx: ReproExecCtx): readonly string[]
  buildValidationCmd(ctx: ReproExecCtx): string
  parseEvidence(ev: ReproEvidence): ReproTestOutcome
}

/** Python/pytest adapter — wraps the EXISTING SSOT (`reproRunArgv`, `reproValidationCmd`, the
 *  pytest classifiers, the `__repro_*.py` basenames) with ZERO behavior change (RFC Phase 1). */
export const pythonReproAdapter: ReproAdapter = {
  language: "python",
  scriptExt: ".py",
  scriptBasename: reproScriptBasename,
  artifactPatterns: REPRO_SCAFFOLD_ARTIFACT_PATTERNS,
  buildExecArgv: ({ repo, version, scriptPath, execBackend, imageRef, sandboxDir }) => {
    // IMAGE backend: run plain `python -s <script>` INSIDE the instance image — the image
    // already has pytest + every dep (NO `uv run --with pytest`, which is the host env-bootstrap
    // that fails on missing plugins / non-Python trees). Falls back to host if ref/dir absent.
    if (execBackend === "image" && imageRef !== undefined && sandboxDir !== undefined) {
      return dockerRunReproArgv(imageRef, sandboxDir, ["python", "-s", scriptPath])
    }
    // HOST backend (default): `repo === undefined` (non-SWE-bench fixture) ⇒ bare python3
    // (matches reproValidationCmd); else the uv project-env SSOT. BYTE-IDENTICAL to pre-Phase-2.
    return repo === undefined
      ? ["python3", "-s", scriptPath]
      : [...reproRunArgv(repo, version, scriptPath)]
  },
  buildValidationCmd: ({ repo, version, scriptPath, execBackend, imageRef, sandboxDir }) =>
    execBackend === "image" && imageRef !== undefined && sandboxDir !== undefined
      ? dockerValidationCmd(imageRef, sandboxDir, scriptPath)
      : reproValidationCmd({ repo, version, scriptPath }),
  // pytest sidecar is authoritative when present (matches execute.ts precedence); else the
  // stdout-based classifier. Byte-identical to the current verdict path.
  parseEvidence: ({ stdout, stderr, code, sidecarText }) =>
    sidecarText !== undefined
      ? classifyPytestReportText(sidecarText)
      : classifyPytest(stdout, stderr, code),
}

/**
 * Resolve the adapter for an instance from `instance.swebench.repoLanguage`. Python (incl.
 * absent = Verified/Live default) ⇒ {@link pythonReproAdapter}. Any other language ⇒ `null`
 * = UNSUPPORTED, and the caller MUST fail-closed (no repro signal — never a silent pass and
 * never a fake pytest run on a non-Python tree). Go / JS / TS adapters land in later phases.
 */
export const resolveReproAdapter = (instance: Pick<Instance, "swebench">): ReproAdapter | null =>
  normalizeRepoLanguageWithPythonDefault(instance.swebench?.repoLanguage) === "python"
    ? pythonReproAdapter
    : null

/**
 * Docker image reference for the `image` exec backend, when CLEANLY derivable from the instance.
 *
 * **Pro** (`ScaleAI`) images are clean: `jefzda/sweap-images:<dockerhub_tag>` — `dockerhubTag`
 * is carried verbatim on the instance (verified pullable). Returned directly.
 *
 * **Verified/Live** swebench eval images are NOT reconstructed here (RFC Phase 2 RCA): their
 * name is swebench-INTERNAL + mangled (`<ns>/sweb.eval.<arch>.<id-with-__→_1776_>:latest`) —
 * reconstructing it duplicates the harness's encoding + drifts. Those must be DISCOVERED (the
 * harness already pulls them) and injected via `ReproExecCtx.imageRef`, not built here ⇒ `null`.
 */
export const proReproImageRef = (
  instance: Pick<Instance, "swebench">,
  dockerhubUsername = "jefzda",
): string | null => {
  const tag = instance.swebench?.dockerhubTag
  return tag !== undefined && tag !== "" ? `${dockerhubUsername}/sweap-images:${tag}` : null
}

/**
 * Preferred execution runtime for a repro on this instance + script path.
 *
 * Pro Python instances carry a clean, pullable image ref (`dockerhubTag`), so their repros should
 * run INSIDE that image instead of the host uv env. Verified/Live (no derivable image ref) stay on
 * the legacy host path byte-identically.
 */
export const preferredReproExecRuntime = (
  instance: Pick<Instance, "swebench">,
  scriptPath: string,
): Pick<ReproExecCtx, "execBackend" | "imageRef" | "sandboxDir"> => {
  // RFC jun-29-repro-adapter-polyglot Phase 2b is runtime-gated + DEFERRED: the
  // `image` backend's Python parity (does the patched, mounted sandbox actually
  // shadow the image's own pip-installed repo copy, or does `import <project>`
  // resolve to the UNPATCHED image checkout?) is UNPROVEN and must be validated on
  // a box first. Default-OFF ⇒ `{}` ⇒ host backend ⇒ byte-identical (every
  // existing Pro/Live/Verified repro run unchanged); enabling it is the opt-in
  // measurement arm, not a silent posture flip for the next Pro launch.
  if (!gateOn(process.env, "QUANTA_BENCH_REPRO_IMAGE_EXEC")) return {}
  const imageRef = proReproImageRef(instance)
  if (imageRef === null) return {}
  return {
    execBackend: "image",
    imageRef,
    sandboxDir: dirname(scriptPath),
  }
}
