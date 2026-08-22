/**
 * S1 (jun-7-naive-impl-hardening Phase-2 FINAL) — branded `ScrubbedEnv` + the
 * `spawnScrubbed` boundary that makes an exec-cluster env LEAK UNREPRESENTABLE.
 *
 * THE STRUCTURAL UPGRADE OVER R-D3'S SCANNER:
 *   R-D3 (a source ratchet) CATCHES a leaky `Bun.spawn` after the fact. S1 makes
 *   it a TYPE ERROR at the call boundary: `spawnScrubbed`'s `env` parameter is
 *   the branded {@link ScrubbedEnv}, a nominal type produced ONLY by
 *   {@link asScrubbedEnv} — the single documented chokepoint that wraps the
 *   shared scrubbers (`scrubEnv` / `buildPtyEnv` / `applyLocalEnv`, optionally
 *   composed through `withProxyEnv`). Two consequences fall out for free:
 *     - inherit-by-omission is impossible — `env` is a REQUIRED field, so a
 *       caller cannot omit it (the silent `Bun.spawn(argv, {})` leak R-D3 had to
 *       scan for cannot be written);
 *     - a raw `{ ...process.env }` spread does not satisfy `ScrubbedEnv`, so it
 *       is a tsc error rather than a runtime leak.
 *
 * SCOPE (why a WRAPPER, not a branded `scrubEnv` return): `scrubEnv`'s
 * `Record<string,string>` return — and `applyLocalEnv` / `withProxyEnv`'s
 * `NodeJS.ProcessEnv` returns — are consumed by ~10 NON-exec files
 * (`runner/batch/eval/*`, `tool/gh/*`, `apps/agent/mode-presets/*`). Branding
 * THEIR return type would ripple tsc errors across all of them. So the brand is
 * minted HERE, at the exec boundary, leaving the producers' public types
 * untouched (the SCOPE GUARD in the plan).
 *
 * Closed-port DI: the real `Bun.spawn` is the only effect, isolated behind
 * {@link ScrubbedSpawner} so tests can record the exact `{ argv, options }`
 * passed to spawn without running a process.
 */

/** A child env that PROVABLY came from the shared scrubber chokepoint. Nominal
 *  brand — the `__scrubbed` phantom field is never present at runtime (the cast
 *  in {@link asScrubbedEnv} adds zero bytes), it exists only so a raw env object
 *  is NOT assignable to `ScrubbedEnv`. */
export type ScrubbedEnv = Record<string, string | undefined> & {
  readonly __scrubbed: unique symbol
}

/**
 * The ONLY producer of {@link ScrubbedEnv}. Pass the result of a shared scrubber
 * (`scrubEnv()`, `buildPtyEnv(...)`, `applyLocalEnv(...)`, or one of those
 * composed through `withProxyEnv(...)`). This is the documented chokepoint — a
 * code review that sees `asScrubbedEnv(process.env)` has a single obvious line
 * to reject, vs. an `env:` buried in a spawn options bag.
 *
 * Pure — a zero-cost brand cast (no allocation, no copy).
 */
export const asScrubbedEnv = (env: Record<string, string | undefined>): ScrubbedEnv =>
  env as ScrubbedEnv

/** Options for {@link spawnScrubbed}. `env` is REQUIRED and branded so a spawn
 *  cannot inherit-by-omission. `extra` carries the per-site Bun.spawn knobs
 *  (`stdin`/`terminal`/etc.) the wrapper does not model directly. */
export interface ScrubbedSpawnOptions {
  readonly cwd: string
  readonly env: ScrubbedEnv
  readonly stdout?: "pipe" | "ignore" | "inherit"
  readonly stderr?: "pipe" | "ignore" | "inherit"
  readonly stdin?: "pipe" | "ignore" | "inherit"
  /** Escape hatch for site-specific Bun.spawn options (e.g. `{ terminal }`).
   *  MUST NOT carry an `env` — the branded `env` above is authoritative. */
  readonly extra?: Readonly<Record<string, unknown>>
}

/** Closed-port spawner seam. Production wires {@link bunScrubbedSpawner}; tests
 *  pass a recorder that captures `{ argv, options }`. The return is the opaque
 *  `Bun.Subprocess`-like handle — callers narrow it at their site. */
export type ScrubbedSpawner = (argv: readonly string[], options: ScrubbedSpawnOptions) => unknown

/** Production spawner — funnels the branded options into the real `Bun.spawn`.
 *  The branded `env` is unwrapped here (the brand is a compile-time-only
 *  phantom; at runtime it is the plain scrubbed record Bun.spawn expects). */
export const bunScrubbedSpawner: ScrubbedSpawner = (argv, options) => {
  const { cwd, env, stdout, stderr, stdin, extra } = options
  return Bun.spawn(
    argv as string[],
    {
      cwd,
      env: env as unknown as Record<string, string | undefined>,
      ...(stdout !== undefined ? { stdout } : {}),
      ...(stderr !== undefined ? { stderr } : {}),
      ...(stdin !== undefined ? { stdin } : {}),
      ...(extra ?? {}),
    } as Parameters<typeof Bun.spawn>[1],
  )
}
