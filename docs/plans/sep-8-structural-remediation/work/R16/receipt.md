# R16 receipt — skill authority inputs / fail-soft observation

Status: **implemented** (not verified). Not W7 `verified`.

Lane: W6-A. Single package; no B/C slot.

source HEAD snapshot: `d6087349fbf221bdd66f3e23903b4ca647b0a69c`

## Snapshot

| Field | Value |
|---|---|
| Bun | 1.3.14 |
| OS | Darwin arm64 24.6.0 |
| god-code | `session-setup.ts` 830; `repl.ts` 500; `system.ts` 117. Not in 900–999 |

## Findings

| ID | Result |
|---|---|
| G-F11 | `resolveOrgConfigDir` distinguishes omitted default vs explicit `null` opt-out vs env/empty. CLI/web call `composeSessionSkillAuthority` once; snapshot+`loadAdminPolicy` share the same dir. Malformed policy is `SkillAdminPolicyLoadError`, not silent disable |
| G-F8 | `loadPermissionStoreFailSoft` warns once (redacted), fallback stays `undefined`; throwing warn sink still fail-soft. CLI `sessionSetupDeps` wires it. Web durable loader uses the same redact origin |
| G-F13 | `resolveModePresetRepoRules` warns once and fail-opens; override/batch skip load; `redactSecrets` on cause. Web `agent-config-base` uses the same load+redact+warn-once, not apps/agent |

## RED→GREEN

```
bun test tests/unit/sep8-remediation/r16/ tests/integration/sep8-remediation/r16/ tests/unit/skill/runtime/skill-runtime-authority-hellgate.test.ts
```

CLI/web active sets honor banned, required-pin vs user disable, XDG default, empty-env opt-out. Malformed org-policy throws. PAT in permission/repo-rules warning is `[REDACTED:github_pat_classic]`.

## Unverified / out of scope

- W7 `I.1`–`I.8` / global `prepush` / 39/39 verified
- G-F5.4 EC2 live proof
- G-F9.4 live Docker/Lima daemon (contract rail already installed)
- Unrelated startup catches (web MCP load, host `resolveBootstrapRepoRules`, CLI `rule-indicator`) not redesigned
