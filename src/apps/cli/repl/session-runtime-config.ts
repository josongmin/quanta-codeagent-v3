import { type Provider, resolveBootSelection } from "@/llm"
import {
  ALL_PERMISSION_MODES,
  isPermissionMode,
  type PermissionMode,
  type ReviewerSandboxProfile,
} from "@/permission"
import { logger } from "@/shared"
import { CLI_KNOBS } from "../cli-knobs"
import {
  argvImages,
  argvPrompt,
  env,
  newSessionFlag,
  observeDir,
  playbookTriggerFlag,
  resolveMcpConfigPath,
  titleFlag,
} from "../internal"
import { parseCliReviewerSandboxProfile } from "./reviewer-policy"

export interface SessionRuntimeConfig {
  readonly env: NodeJS.ProcessEnv
  readonly stdinIsTTY: boolean | undefined
  readonly stdoutIsTTY: boolean | undefined
  /** `process.stderr.isTTY` — the bit the welcome banner + human startup logs
   *  gate on (both target stderr). Threaded into bootstrap so the redundant
   *  "quanta ready" / "session:" lines are suppressed exactly when the banner
   *  renders (interactive TTY), and kept verbatim otherwise (pipe / one-shot). */
  readonly stderrIsTTY: boolean | undefined
  readonly cwd: string
  readonly homeDir: string
  readonly provider: Provider
  readonly model: string
  /** aug-28 — true when `QUANTA_MODEL` (the `--model` surface) named the model for
   *  this invocation, so the surface skips the persisted sticky pick. */
  readonly modelPinnedExplicitly: boolean
  readonly mode: PermissionMode
  readonly sandboxProfile: ReviewerSandboxProfile
  readonly maxTurns: number
  readonly mcpConfigPath: string | undefined
  readonly spinnerIntervalMs: string
  readonly observeDir: string | undefined
  readonly argPrompt: string | undefined
  readonly pendingImagePaths: readonly string[]
  readonly newSession: boolean
  readonly title: string | undefined
  readonly idleSuppressOn: boolean
  readonly idleMs: number
  readonly snoozeDefaultMs: number
  readonly rejectLimit: number
  /** ADR-0301 — `--playbook-trigger` CLI flag echo. `true` when the flag is
   *  present on argv. Threaded into `bootstrapSession` → `setupSession` →
   *  `runSessionLoop` so `maybeStartPlaybookTriggerWire({ cliFlag })` honours
   *  the operator's CLI opt-in. Default-OFF: absent flag ⇒ `false` ⇒ slot
   *  omitted further downstream (RFC §1.2 byte-identical). */
  readonly playbookTriggerFlag: boolean
}

/** Consolidate the session surface's process/env/argv reads into one typed
 *  config object so bootstrap and host wiring consume plain data. */
/**
 * A positive-int knob, with the declared fallback and a warning on garbage.
 *
 * `Number(env(key, "40"))` was the shape at four call sites below, and it accepted
 * both an EMPTY value and non-numeric text. `env(k, d)` is `process.env[k] ?? d`, and
 * `??` does not catch `""` — so `export QUANTA_MAX_TURNS=` (a bare export, or an unset
 * variable in a shell script) produced `Number("") === 0`, and the turn loop
 * (`for (turn = 1; turn <= cfg.maxTurns; …)`) never ran a single iteration while the
 * session reported `finish("max_turns", 0)`. Measured: `""` and `"  "` both give 0,
 * `"abc"` gives NaN, and NaN fails the same comparison. A session that silently does
 * nothing and reports a plausible reason is the worst debuggability in this file.
 *
 * `allowZero` is for `QUANTA_REJECT_LIMIT`, where `0` is the DOCUMENTED off-switch
 * (`reject-counter.ts`: "threshold = Infinity ⇒ shouldAutoExit() is always false.
 * That's how QUANTA_REJECT_LIMIT=0 disables the mechanism").
 */
const intKnob = (key: string, fallback: number, allowZero = false): number => {
  const raw = env(key, "").trim()
  if (raw === "") return fallback
  const n = Number(raw)
  const ok = Number.isFinite(n) && n >= 0 && (allowZero || n > 0)
  if (!ok) {
    logger.warn(
      `${key}='${raw}' is not a ${allowZero ? "non-negative" : "positive"} number; using ${fallback}`,
    )
    return fallback
  }
  return n
}

/**
 * The fallback an int knob DECLARES in `CLI_KNOBS`, instead of a second copy here.
 *
 * `intKnob("QUANTA_IDLE_MS", <literal>)` restated the `default: 60000` declared for the
 * same key in `cli-knobs.ts`, so a changed default had two homes and `/knobs` could
 * show one while the session used the other. It also tripped the magic-timeout
 * scan in `src-no-sketchy-code.test.ts`: the earlier `Number(env(k, "60000"))` hid
 * the number inside a string, and making the fallback numeric exposed it.
 *
 * Throws on a missing or non-numeric declaration: this runs once at session start
 * and every suite that builds a session config goes red, which is the right place
 * for a renamed key to surface.
 */
const declaredIntDefault = (key: string): number => {
  const row = CLI_KNOBS.find((k) => k.envKey === key)
  if (row === undefined || typeof row.default !== "number") {
    throw new Error(`${key} declares no int default in CLI_KNOBS; declare it there, not here`)
  }
  return row.default
}

/** `QUANTA_PERMISSION`, validated against the closed set with a warning. */
const readPermissionMode = (): PermissionMode => {
  const raw = env("QUANTA_PERMISSION", "default").trim()
  if (isPermissionMode(raw)) return raw
  logger.warn(
    `QUANTA_PERMISSION='${raw}' is not a permission mode; using 'default'. ` +
      `Accepted: ${ALL_PERMISSION_MODES.join(" | ")}`,
  )
  return "default"
}

export const readSessionRuntimeConfig = (): SessionRuntimeConfig => {
  // MR-01 — ONE authority for provider + boot model + "did the operator pin it"
  // (`@/llm` `resolveBootSelection`). The interactive CLI has NO `--model` flag
  // (MEASURED: `grep '"--model"' src/apps/cli` hits only `serve --stdio`), so no
  // `modelArg` is threaded here — `QUANTA_MODEL` IS this surface's pin surface
  // and the SSOT reads it off the env view.
  const boot = resolveBootSelection({ env: process.env })
  // jun-10 — normalize the positional prompt "" → undefined HERE (the SSOT
  // seam): `argvPrompt()` returns the joined positionals, which is `""` on a
  // bare `quanta` launch, but the field is typed `string | undefined` and the
  // interactive-only gates downstream (welcome banner, ADR-0528 crash-resume
  // reinject offer) check `=== undefined`. Without this they were dead in real
  // runs while green in tests (whose stubs passed `undefined`).
  const rawArgPrompt = argvPrompt()
  return {
    env: process.env,
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
    stderrIsTTY: process.stderr.isTTY,
    cwd: process.cwd(),
    homeDir: process.env.HOME ?? "",
    provider: boot.provider,
    model: boot.modelId,
    // aug-28 — did the OPERATOR pin the model for THIS invocation? A persisted
    // `/model` pick must not silently override an explicit pin: `QUANTA_MODEL=x
    // quanta "…"` in CI, cron or a git hook otherwise ran whatever a human last
    // picked interactively, with no display (the one-shot path paints no banner).
    // MR-01 — this used to be a SECOND, separately-spelled `QUANTA_MODEL` read
    // that disagreed with the line above it: `QUANTA_MODEL=" "` booted a port
    // whose model id was literally `" "` while `pinned` said false. Both now
    // come from the one resolution.
    modelPinnedExplicitly: boot.pinned,
    // VALIDATED, not cast. This was `env(…) as PermissionMode`, so
    // `QUANTA_PERMISSION=bypassPermissions` (the Claude Code spelling), `BYPASS` or any
    // typo produced a mode no gate recognises. The gate fails CLOSED — an unknown mode
    // falls through to `ask`, identical to `default`, so there is no escalation — but
    // the operator's posture request evaporated with no diagnostic, and
    // `describe().permissionMode` echoed the bogus string to the web surface and
    // observability. `isPermissionMode` already guards the other seven operator entry
    // points; this was the one that did not.
    mode: readPermissionMode(),
    sandboxProfile: parseCliReviewerSandboxProfile(process.env.QUANTA_SANDBOX),
    maxTurns: intKnob("QUANTA_MAX_TURNS", 40),
    mcpConfigPath: resolveMcpConfigPath(process.env),
    spinnerIntervalMs: env("QUANTA_SPINNER_INTERVAL_MS", "80"),
    observeDir: observeDir(),
    argPrompt: rawArgPrompt.length > 0 ? rawArgPrompt : undefined,
    pendingImagePaths: argvImages(),
    newSession: newSessionFlag(),
    title: titleFlag(),
    idleSuppressOn: env("QUANTA_IDLE_SUPPRESS", "1") !== "0",
    idleMs: intKnob("QUANTA_IDLE_MS", declaredIntDefault("QUANTA_IDLE_MS")),
    snoozeDefaultMs: intKnob(
      "QUANTA_SNOOZE_DEFAULT_MS",
      declaredIntDefault("QUANTA_SNOOZE_DEFAULT_MS"),
    ),
    rejectLimit: intKnob(
      "QUANTA_REJECT_LIMIT",
      declaredIntDefault("QUANTA_REJECT_LIMIT"),
      /* allowZero */ true,
    ),
    // ADR-0301 — surface-side argv scan for `--playbook-trigger`. The wire
    // helper enforces env-on precedence; this is the bare CLI echo.
    playbookTriggerFlag: playbookTriggerFlag(),
  }
}
