/**
 * ADR-0330 — Mention runner: skill resolver impl + injector composition.
 *
 * This slice is the production wire of ADR-0325's `MentionResolverPort`.
 * It supplies a SKILL-ONLY resolver (no plugin / no app — see ADR §3
 * Non-goals) and a thin composition function that produces the
 * `(userInputText: string) => readonly Message[]` value that `AgentConfig`
 * is expected to wire (slot reserved in ADR-0327).
 *
 * Closed shapes — `SkillRegistryReadOnly` mirrors the read-only adapter
 * that lives in @/skill. The mention runner accepts an INJECTED instance
 * so it can be tested with a stub (no real registry build) and so
 * @/agent never reaches into @/skill internals.
 */

/**
 * Read-only skill registry surface the mention runner depends on.
 *
 * Structurally compatible with the adapter at
 * `@/skill/registry-readonly` (`SkillRegistryReadOnly`). The duplication
 * is intentional: the runner declares its dependency in @/agent terms
 * so callers passing a fake registry (tests, headless surfaces) don't
 * have to reach into @/skill for the type.
 *
 * The single method `lookup(name)` returns descriptor data (`name +
 * description`) — NEVER the SKILL.md body. Progressive disclosure
 * mandates body loading at invocation time, not at mention time.
 */
export interface SkillRegistryReadOnly {
  /** Returns the descriptor or `null` for unknown / malformed entries. */
  lookup(name: string): { readonly name: string; readonly description: string } | null
}

/**
 * Configuration bag for {@link createMentionInjector}. All knobs optional.
 *
 * - `skills` — read-only registry the skill resolver delegates to. When
 *   omitted, the skill resolver behaves as if the registry were empty
 *   (every `@skill` mention resolves to `null` ⇒ skipped fragment).
 *
 * Plugin / app resolver knobs are INTENTIONALLY ABSENT. They live in
 * future ADRs (plugin manifest discovery + app concept definition).
 * Both resolver methods on the returned port always return `null` —
 * this is a frozen invariant of ADR-0330.
 */
export interface MentionRunnerConfig {
  readonly skills?: SkillRegistryReadOnly
}
