# R15 receipt — boot / configuration truth

Status: **implemented** (not verified). Not W7 `verified`.

Lane: W5-C. `env-files.ts` / `env-flag.ts` API 재사용 (수정 없음). `internal.ts` DTO re-export 생략 (900 진입 금지).

source HEAD snapshot: `c156d76397feb63ec1c4992c07d011dd0647a4c6`

## Snapshot

| Field | Value |
|---|---|
| Bun | 1.3.14 |
| OS | Darwin arm64 24.6.0 |
| god-code | DTO in `src/runner/assemble/llm/transport-projection.ts`; eval dotenv loop replaced (956 → 923, still 900–999) |

## Findings

| ID | Result |
|---|---|
| E-PROV-01 | `requestedTransport` / `credentialProvider` / `effective` / `reason` DTO; status = boot snapshot (`captureStatusBootProjection` from CLI index); doctor = same resolver, current env; no credential values in DTO/log |
| G-F6 | eval uses `loadEnvFiles([".env.dev", ".env.local", ".env"])`; local reverse parser removed; child process + empty launch cwd + `--env-file=/dev/null` |
| E-KNOB-01 | read-outline / test-runner delegate to `isTruthyToken`; local `ENABLING` removed (`yes` included); `yes` removal mutation RED on bench report rail |

## RED→GREEN

```
bun test tests/unit/sep8-remediation/r15/ tests/integration/sep8-remediation/r15/ tests/unit/bench-knobs-wiring-hellgate.test.ts tests/unit/llm-providers/claude-use-quartet-wiring-hellgate.test.ts
```

`.env.dev` wins over `.env.local`/`.env` on the **eval entrypoint** child process. Shell env wins over all dotenv files. Status prints boot transport when current env would differ. `defaultDoctorProbes` reports current resolver transport. `yes` removal from the knob parse is RED against `knobsForReport`.

## Unverified / out of scope

- G-F5.4 EC2
- W6/R16
- W7 verified
