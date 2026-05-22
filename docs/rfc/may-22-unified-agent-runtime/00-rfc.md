# RFC: Unified Agent Runtime — `apps/agent` with Mode-Bounded Config

- **상태**: Draft
- **날짜**: 2026-05-22
- **저자**: 세션 협업 (구조 정리)
- **관련**: RFC-0001 §3.1 (apps slice), §4 (agent core), ADR-0015 (LSP nav 흡수), 커밋 `709c65c` (bench LSP-nav wiring drift fix)

---

## 1. 요약 (TL;DR)

`apps/cli`와 `apps/bench`를 형제 앱으로 완전 분리한 현재 구조를 **단일 `apps/agent`** 로 통합한다. 차이는 **discriminated-union `AgentConfig.mode`** 와 그에 결합된 의존성 슬롯(`permission` / `termination` / `sandbox` / `output` 등)으로 표현한다. 턴 수·wall-clock 같은 양적 다이얼은 모드 간 공유하고, **권한·종료·sandbox·I-O·외부 의존**의 5개 *의미론적* 축만 모드로 분기한다.

이 RFC가 해결하는 핵심 문제: 두 앱의 *조립 코드*가 분기되어 있어 **도구 wiring/프롬프트 룰/게이트 설정이 drift함** (실측 사례: LSP-nav 도구가 CLI에는 들어 있고 bench에는 없던 채로 살아 있다가 sphinx-7590 케이스에서 발견됨, `709c65c`로 봉합).

---

## 2. 동기

### 2.1 관찰된 drift

| 항목 | CLI 상태 | Bench 상태 (수정 전) | 의도 |
|---|---|---|---|
| LSP-nav 도구 등록 | `QUANTA_LSP_TOOLS=full`로 켜짐 | **없음** | 같은 knob을 따라야 했음 |
| Hook 채널 | 사용자 `~/.claude/` 로딩 | 없음 | bench는 hermetic, 의도적 분기 |
| MCP 서버 | 사용자 config 로딩 | 없음 | bench는 hermetic, 의도적 분기 |
| Permission HITL | 4-tier reviewer port | `acceptEdits` 고정 | bench는 사람 0, 의도적 분기 |
| Sandbox 정책 | 사용자 cwd | per-instance cp 격리 | 의도적 분기 |

→ 일부 분기는 **의미론적으로 필수** (사람 유무, 재현성), 일부는 **단순 drift** (LSP-nav 같은 도구 surface).
지금 구조는 둘을 코드 위치만으로 구분 — 둘 다 *서로 다른 조립 코드*에 박혀 있어 새 도구·새 게이트가 추가될 때마다 양쪽 모두 신경 써야 함.

### 2.2 SOTA 비교

| 패턴 | 사례 | 분리 정도 |
|---|---|---|
| **완전 분리** (현재 우리) | SWE-agent, AutoCodeRover (학계 batch harness) | apps 단위 sibling |
| **단일 binary + mode flag** | **Claude Code (`-p` headless), Aider (`--yes-always`), Codex (`--full-auto`)** | 같은 entry, mode 변수가 동작 결정 |
| **agent core 서비스 + thin client** | OpenHands, Replit Agent | core는 RPC 서비스 |

상용 코딩 에이전트는 전부 **B 패턴**. 학계 harness는 **A 패턴**. 우리는 A로 시작했지만 *bench도 우리가 매번 키우는 곳* (eval-bench, 가까운 미래 CI hook, 야간 regression run 등). 점점 더 많은 surface가 추가되면 A의 drift 비용이 통합 비용을 초과.

### 2.3 본질 축 (턴/budget 아님)

`max_turns`, `timeout_ms` 는 surface-무관 *튜닝 다이얼*. 두 모드가 같은 다이얼을 다르게 설정할 뿐 분기 기준이 아님. 진짜 모드 분기 축은 **다섯**:

1. **권한 해결** — borderline action을 누가 결정하나
2. **종료 판단** — 끝났다는 신호가 무엇인가
3. **Sandbox** — 변경이 어디서 일어나나
4. **출력 계약** — 결과물의 shape이 무엇인가
5. **외부 의존** — 호스트 환경에 어디까지 닿나

이 5축이 *모드*이고, 그 외(턴/budget/모델/도구 surface)는 mode-무관 공통 다이얼.

---

## 3. 목표 / 비목표

### 3.1 목표

- **G1** 단일 entry `apps/agent`로 `cli` + `bench` + (미래) `headless`/`ci-bot`/`web` 통합.
- **G2** 5개 의미론적 축을 **discriminated union 타입**으로 표현해 컴파일 타임에 모드 위반(예: bench가 reviewer port 호출) 차단.
- **G3** 도구 surface·프롬프트 룰·게이트가 **단일 wiring 지점**에서 모든 모드에 노출되도록 — drift 불가능.
- **G4** 양적 다이얼(턴/budget/모델/온도)은 모드 무관 공통 옵션.
- **G5** 마이그레이션은 phased — 큰 폭의 big-bang 리팩터링 회피.

### 3.2 비목표

- **N1** 단일 process / 단일 binary 강제 — `apps/agent run --mode batch` 와 `apps/agent run --mode interactive`는 같은 entry지만 같은 process 인스턴스일 필요 없음. (OpenHands식 RPC 서비스화는 별도 RFC)
- **N2** 기존 CLI 사용자 경험 변경 — `bun run cli` alias는 유지하며 내부적으로 `apps/agent run --mode interactive`로 라우팅.
- **N3** SWE-bench 외부 호환성 — predictions.jsonl / report.json schema는 그대로.
- **N4** RFC §3.1 슬라이스 격리 완화 — `@/agent`가 cross-slice 조립자라는 원칙 유지.

---

## 4. 디자인

### 4.1 의미론적 축 5개

```ts
// src/agent/run-mode.ts (신규 슬롯)
export type RunMode = "interactive" | "headless" | "batch"

export type PermissionResolver =
  | { kind: "reviewer-backed"; port: ReviewerPort }   // interactive
  | { kind: "auto"; policy: "acceptEdits" | "denyAll" } // headless | batch

export type TerminationCriterion =
  | { kind: "user-stop" }                              // interactive
  | { kind: "verdict"; testCmd: string; maxTurns: number; wallClockMs: number } // batch
  | { kind: "single-turn" }                            // headless

export type SandboxPolicy =
  | { kind: "user-cwd"; root: string }                 // interactive | headless
  | { kind: "per-instance"; clone: (corpusPath: string) => Promise<string> } // batch

export type OutputContract =
  | { kind: "stdout-chat" }                            // interactive | headless
  | { kind: "structured"; predictionsPath: string; reportPath: string; observeDir: string } // batch

export type ExternalDeps =
  | { kind: "host"; hooks: HooksConfig | null; mcp: McpConfig | null }  // interactive
  | { kind: "hermetic" }                               // batch
  | { kind: "hermetic-with-overrides"; mcp: McpConfig | null }  // headless (optional MCP, no hooks)
```

`AgentConfig`는 이 5개 필드를 가지며, `mode`는 type-narrowing의 discriminator 역할 (mode → 허용되는 조합).

### 4.2 모드-필드 매트릭스 (compile-time enforced)

| 필드 | interactive | headless | batch |
|---|---|---|---|
| `permission.kind` | `reviewer-backed` | `auto` | `auto` |
| `termination.kind` | `user-stop` | `single-turn` | `verdict` |
| `sandbox.kind` | `user-cwd` | `user-cwd` | `per-instance` |
| `output.kind` | `stdout-chat` | `stdout-chat` | `structured` |
| `externalDeps.kind` | `host` | `hermetic-with-overrides` | `hermetic` |

매트릭스는 `narrowConfig<Mode>()` 헬퍼로 강제. Bench가 `reviewer-backed` permission을 받으려 하면 TS error.

### 4.3 공통 다이얼 (모드-무관)

`AgentConfig.dials`:
- `model: string`
- `provider: "anthropic" | "openai"`
- `maxTurns: number` (default by mode hint, override 가능)
- `wallClockMs: number`
- `temperature?: number`
- `compactionTokens?: number`
- `lspToolsEnabled: boolean` (모든 모드에서 같은 knob)
- `gitToolsEnabled: boolean`
- `mcpServers: McpServerConfig[]` (mode가 `host`이거나 `hermetic-with-overrides`인 경우만 의미 — type-level enforced)

### 4.4 entry CLI

```sh
# 기존
bun run cli                                  # → interactive
bun run bench --corpus X                     # → batch

# 통합 후
bun run agent --mode interactive             # 같은 binary, 기본 mode 옵션
bun run agent --mode batch --corpus X --instance Y
bun run agent --mode headless -p "<task>"
```

`bun run cli` / `bun run bench`는 package.json scripts에서 `agent --mode ...`로 라우팅하는 **얇은 alias만 유지**.

### 4.5 조립 책임 (single wiring point)

`src/apps/agent/assemble.ts`:
- mode 받음
- 공통 wiring 한 번: `defaultTools` + `lspNavTools` (knob) + `gitTools` (knob) + `mcpTools` (mode가 허용하면)
- mode별 분기 wiring: `permission` resolver, `termination` criterion, `sandbox` policy, `output` contract, `externalDeps`
- `AgentConfig` 반환

기존 `apps/cli/buildTooling` 과 `apps/bench/runner.ts#buildConfig`가 같은 assemble.ts로 흡수됨. **새 도구가 추가되면 한 군데만 추가하면 됨**.

---

## 5. 마이그레이션 플랜 (phased)

### Phase 1 — 타입 일반화 (no-op, 코드 변경 0)

- `RunMode`, `PermissionResolver`, `TerminationCriterion`, `SandboxPolicy`, `OutputContract`, `ExternalDeps` 타입 슬롯 신설
- 기존 코드는 안 건드림. apps/cli와 apps/bench 그대로 동작
- 목적: 다음 phase의 명확한 타깃 타입 확보
- 검증: tsc 통과, 기존 테스트 모두 통과 (코드 변경 없으니 자동)

### Phase 2 — bench를 새 타입으로 어댑트

- `apps/bench/runner.ts#buildConfig`가 새 `AgentConfig` shape를 반환하도록 변경
- mode = `"batch"` 고정, permission = `auto/acceptEdits`, sandbox = `per-instance`, output = `structured`, externalDeps = `hermetic`
- 기존 bench 동작 byte-identical (실제 wiring은 그대로, 타입 shell만 바뀜)
- 검증: 기존 bench 통합 테스트 모두 통과 (predictions/report shape 동일)

### Phase 3 — cli를 새 타입으로 어댑트

- `apps/cli/assembleConfig`도 같은 shape 반환, mode = `"interactive"`
- reviewer port wiring, hooks 로딩 그대로
- 검증: CLI REPL 수동 smoke test + 기존 CLI 통합 테스트 통과

### Phase 4 — assemble.ts 통합

- `apps/agent/assemble.ts` 신설 — apps/cli와 apps/bench의 wiring을 양쪽이 동일한 코드 경로로 호출하게 흡수
- apps/cli와 apps/bench는 mode 고정해서 assemble.ts 호출하는 **얇은 wrapper**로 축소
- 검증: 양쪽 통합 테스트 통과 + 새 anti-regression 테스트 (모드별 invariant)

### Phase 5 — entry 통합 (선택적, 운영자 가시성)

- `apps/agent/index.ts` 단일 entry 만들고 `--mode` 플래그 노출
- `bun run cli` / `bun run bench`는 package.json에서 라우팅
- 새 surface(headless / web / ci-bot) 추가가 entry 한 곳에 옵션 추가로 가능
- 검증: 두 alias가 기존과 동일 동작

각 phase 끝에서 **bench 9-task regression run** 돌려 결과(테스트 카운트, 패치 사이즈, 턴 수)가 변하지 않는지 비교.

---

## 6. Anti-regression — drift 재발 방지

Phase 4 이후 도입할 강제 invariant:

### 6.1 도구 surface invariant

`tests/unit/agent-wiring-invariants.test.ts`:
- "모든 모드에서 `lspNavTools`는 `lspToolsEnabled` knob을 따른다" — 각 모드별 assemble 호출 → registry에 lsp_* 도구 포함 여부가 knob과 일치
- "`MCP` 도구는 mode가 `host` / `hermetic-with-overrides`일 때만 등록" — batch 모드에서 mcp 등록 시도하면 등록 거부
- "`hooks` 채널은 mode가 `host`일 때만 활성" — batch에서 hook fire 시 정적 분석으로 차단

### 6.2 모드 매트릭스 invariant

`narrowConfig<Mode>()` 헬퍼가 type-narrowing — 매트릭스 위반은 컴파일 에러. 추가로 런타임 assert (방어):

```ts
const assertModeMatrix = (cfg: AgentConfig): void => {
  if (cfg.mode === "batch" && cfg.permission.kind !== "auto") {
    throw new Error("batch mode requires permission.kind === 'auto'")
  }
  // ... 다른 매트릭스 셀
}
```

### 6.3 Drift detector

`tests/unit/agent-config-shape.test.ts`:
- 각 mode의 합법적 AgentConfig 샘플 3개씩 — 새 필드 추가 시 모든 샘플이 컴파일되어야 통과 (한 곳 빠뜨림 ⇒ TS error → CI fail)

---

## 7. 트레이드오프

### 7.1 얻는 것

- **Drift 불가능**: 새 도구/게이트가 단일 wiring 지점에서 모든 모드에 노출. LSP-nav drift 같은 케이스 재발 차단.
- **Type-level 모드 안전**: bench가 reviewer port 호출 같은 의미론 위반이 컴파일 에러.
- **새 surface 추가 비용 작음**: `headless`, `web`, `ci-bot` 같은 새 모드가 매트릭스에 행 1개 + assemble.ts 분기 추가.
- **운영자 인지 비용 감소**: 한 binary, 한 doc, 한 issue tracker.

### 7.2 잃는 것

- **분리의 안전판 약화**: 지금은 "bench에 사용자 hook 절대 안 들어옴"이 **코드 부재**로 강제됨. 통합 후엔 **config invariant**로만 강제 — 잘못된 한 줄이 leak 가능. → mitigation: §6 anti-regression 테스트로 잠금.
- **AgentConfig 표면적 증가**: 5개 새 필드. → mitigation: discriminated union이라 mode 알면 narrowed shape이 작음.
- **마이그레이션 비용**: phase 5 단계, 각 phase가 회귀 테스트 통과 필요.

### 7.3 리스크 매트릭스

| 리스크 | 확률 | 영향 | 완화 |
|---|---|---|---|
| Phase 2-3 마이그레이션 중 bench/cli 동작 회귀 | 중 | 큼 | 각 phase 끝에 9-task regression run + 통합 테스트 |
| 매트릭스가 새 mode에 맞지 않음 (e.g. CI bot은 hermetic+test execution) | 중 | 중 | discriminated union이라 새 케이스 추가는 type-level enforce — 한 셀 빠뜨림 = 컴파일 에러 |
| Anti-regression 테스트 우회 가능성 | 낮 | 중 | invariant assert를 런타임에도 (§6.2) |
| 사용자 (= 너) 워크플로 영향 | 낮 | 낮 | alias 유지 (§3.2 N2), 명령어 그대로 |

---

## 8. 거부된 대안

### 8.1 현 상태 유지 (A 패턴)

- **유지 케이스**: surface가 2개로 충분히 적고 drift는 anti-regression 테스트로 잡으면 됨
- **거부 이유**: 이미 1건 발생 (LSP-nav). headless / web / cron 등 surface가 늘면 N² 조립 코드. 비용이 선형 증가하지 않음

### 8.2 RPC 서비스화 (C 패턴, OpenHands식)

- **유지 케이스**: 여러 frontend (web/cli/IDE plugin)가 같은 agent를 호출
- **거부 이유**: 우리 단계에서 과한 deployment 복잡도. 단일 process 운영이 단순. 미래에 web frontend가 추가되면 별도 RFC로 재검토 — 그 시점에 이미 B 패턴이라면 C로 가는 비용도 더 작음.

### 8.3 mode flag로 양 binary 안에서 분기 (얕은 통합)

- **유지 케이스**: 코드 거의 안 바꾸고 `bun run cli --mode headless`만 추가
- **거부 이유**: type-level invariant 강제 안 됨. drift 그대로. RFC의 진짜 가치는 *조립을 한 곳에 모으는 것*이지 entry 통합 자체가 아님.

---

## 9. 결정 기준 — 언제 mandatory가 되나

| 트리거 | 조치 |
|---|---|
| 새 surface 추가 제안 (headless `-p`, web UI, cron job 등) | Phase 1-2 즉시 시작 (그 surface가 추가될 때 같이 통합) |
| 두 번째 drift 사례 발견 | Phase 1-4 우선순위 ↑ (drift 비용이 통합 비용 추월 증거) |
| 신규 도구가 한 surface에만 추가되고 다른 surface가 1개월 이상 누락 | 강한 drift 신호 — 통합 시작 |
| 위 3개 다 안 일어남 | 옵션 유지, 우선순위 낮음. anti-regression 테스트만 추가 (§6) |

---

## 10. Open questions

- **Q1** mode가 3개를 넘어 5-6개가 되면 discriminated union이 너무 복잡해지나? → 그 시점에는 plugin/policy 패턴으로 한 단계 더 추상화 (별도 RFC)
- **Q2** `headless` 모드는 single-turn만? 멀티턴 자동 진행 (Claude Code -p와 -c 옵션)도 같은 mode? → 동일 mode 안에서 `termination` 만 다름 (`single-turn` vs `verdict-without-test`로 변형)
- **Q3** observe trajectory가 interactive에서도 켜질 수 있어야 하나? → `output.kind` 조합 확장 (e.g. `stdout-chat-with-observe`) 또는 별도 직교 옵션 — 후속 결정

---

## 11. 다음 액션 (이 RFC가 Accepted 됐을 때)

1. ADR-XXXX 작성 — 본 RFC 수락 결정 기록
2. Phase 1 (타입 슬롯) PR 열기 — no-op, 컴파일 통과만 검증
3. 9-task bench regression baseline 캡처 (Phase 2-3에서 비교 기준)
4. Phase 2 (bench adapt) 작업

---

## 12. 부록 — 현재 상태 진단 (이 RFC의 evidence)

### 12.1 현재 조립 분기 위치

| 책임 | apps/cli 경로 | apps/bench 경로 | 공통? |
|---|---|---|---|
| `runAgent` 호출 | `src/apps/cli/index.ts:298` | `src/apps/bench/runner.ts:617` | ✅ 동일 함수 |
| AgentConfig 조립 | `assembleConfig(...)` (apps/cli) | `buildConfig(...)` (apps/bench) | ❌ 분기 |
| Tool registry | `buildTooling(mcp, lsp, lspNav, git, slog)` | `new ToolRegistry([...defaultTools, ...lspNavTools])` | ❌ 분기 |
| Permission | HITL 4-tier + reviewer port | `{mode:"acceptEdits"}` 고정 | ❌ 분기 |
| First user msg | stdin REPL | `problemStatement + SWEBENCH_DIRECTIVE` | ❌ 분기 |
| 후처리 | session save | `withGitSnapshot` + `testCmd` + verdict | ❌ 분기 |

### 12.2 LSP-nav drift 사례 (해결됨, but evidence)

- ADR-0015로 LSP nav 도구 슬라이스가 추가됨 (2026-05-20)
- `apps/cli/internal.ts`에서 `QUANTA_LSP_TOOLS=full` env knob으로 wiring
- `apps/bench/runner.ts`는 `defaultTools`만 사용 — knob을 따르지 않음
- 2026-05-22 sphinx-7590 케이스에서 발견 — 커밋 `709c65c`로 봉합
- **이 RFC가 통합되면 drift 자체가 type/test 레벨에서 차단됨**

### 12.3 통합 후 예상 wiring shape

```ts
// src/apps/agent/assemble.ts (신설)
export const assembleAgentConfig = (req: AssembleRequest): AgentConfig => {
  const dials = resolveDials(req)  // 모드 무관 공통
  const tools = buildToolRegistry({
    base: defaultTools,
    lsp: dials.lspToolsEnabled ? lspNavToolList() : [],
    git: dials.gitToolsEnabled ? gitTools() : [],
    mcp: req.externalDeps.kind !== "hermetic" ? loadMcp(req.externalDeps) : [],
  })  // 한 곳에서 모든 모드용 wiring
  const permission = resolvePermission(req.mode, req.permission)
  const termination = resolveTermination(req.mode, req.termination)
  // ...
  return { runAgent: { tools, permission, termination, ... } }
}
```

→ 새 도구 추가? `buildToolRegistry` 한 곳에 추가하면 자동으로 모든 모드에 노출 (knob이 모드 무관 dial).

---

## 13. 변경 이력

| 날짜 | 버전 | 변경 |
|---|---|---|
| 2026-05-22 | Draft | 초안 작성 — sphinx-7590 drift evidence + 5축 분기 정의 |
