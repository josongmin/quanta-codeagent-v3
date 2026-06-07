# RFC — 설정/기능 토글 통합 (knob 거버넌스 + Capability 레이어)

> **Status: 📐 DRAFT rev2 (jun-07) — 3-에이전트 적대 어딧 후 전면 축소. rev1은 이미 있는 인프라(`@/runner/knobs`·`@/config`·`runtime-config`·`tools/pm`)를 재발명하고 있었음. rev2는 "신축"이 아니라 "통합+거버넌스+capability"로 범위 재정의.**
> Date: 2026-06-07
> 한 줄: **새 registry를 만들지 않는다.** 이미 있는 3개 knob 시스템 + settings 레이어 + ratchet 위에, (1) 누락 봉인 거버넌스 (2) cross-surface Capability 레이어 (3) discoverability(`/config`·`--help`)만 얹는다.

---

## 0. 어딧 판정 — rev1이 재발명하던 것 (grep-verified, ⚠️ 신축 금지)

3-에이전트 적대 어딧(중복/갭/개선-교체) 결과, rev1이 "신축"하려던 Layer-1이 **거의 다 이미 존재**:

| rev1이 만들려던 것 | 실제 위치 (이미 있음) |
|---|---|
| 타입 knob descriptor | `src/runner/knobs/types.ts` `Knob<T>` (id/envKey/category/surfaces/parse/apply/describe/conflicts/requires/default + `hotToggleable`) |
| registry SSOT | `src/runner/knobs/registry.ts` (registerKnob/allKnobs/knobsForSurface) — 25 def, ~49 knob |
| 레이어드 소스 해석(precedence) | `src/runner/knobs/resolve.ts` — `cli>session>env>config-file>preset>default` + `KnobValue.source` 추적 |
| knobs.json 영속 | `src/runner/knobs/persist.ts` (`~/.quanta/knobs.json`, 0600) |
| 관계검증/apply | `src/runner/knobs/{validate,apply}.ts` |
| kind 파서 | `src/shared/env-flag.ts`(gateOn/strict/isTruthyToken) + `runtime-config.ts`(parsePositiveInt/parseBool/…) |
| 4-레이어 settings + trust + setting-sources | `src/config/`(ADR-0497) |
| default-OFF 자동발견 | `tests/unit/knob-default-off-completeness-guard.test.ts` (regex 발견 = rev1이 formalize하려던 바로 그것) |
| ratchet/burn-down | `tools/pm/{definition-of-done,check}.ts` + baseline.json |
| gate vocab SSOT | `src/shared/env-flag.ts` (jun-7 통일) |
| **`/config` CLI** ← rev1이 신축하려던 것 | `src/apps/cli/slash-commands-knobs.ts` (428줄 **`/knobs`**: show/list/set/reset/**preset**/save/help + `KnobsSurfaceWire` + `DEFAULT_OVERRIDES` 세션영속 + 자동완성). **`diff`만 없음.** |
| preset 번들 | `src/runner/knobs/presets.ts` `KNOB_PRESETS` + `/knobs preset` 배선 완료 |
| `--setting-sources` | `src/config/index.ts parseSettingSources` + `runtime-config.centralConfigSources`(`QUANTA_SETTING_SOURCES`). **CLI 플래그 형태만 없음**(env는 됨) |
| feature↔surface↔knob 메타데이터 | `tools/feature-catalog/schema.ts:47,50,75` (`ui_surfaces`/`configurable`/`knobs`[descriptive]) — capability가 **링크**(병합 아님) |
| hook 이벤트 타입 | `src/agent/hooks.ts` typed `HookEvent` union(12 이벤트) — hook-registry가 참조 |
| 런타임 토글 프레임워크 | `src/agent/control-request/` (ADR-0496, `QUANTA_CONTROL_REQUEST`) — `set_config`는 variant 1개 추가 |

**진짜 NEW (어디에도 없음, R1b 확정) — rev2의 실제 범위:**
1. **cross-surface Capability 레이어** (기능↔LLM도구↔슬래시↔스킬↔훅 통합) — 유일하게 미구현, split-brain 근본해결. (+ **hook은 manifest 같은 registry조차 없음** → 작은 hook-registry도 신설 필요.)
2. **누락-봉인 거버넌스** (신규 `QUANTA_*`가 어느 registry에도 안 들어가면 CI/컴파일 실패).

**부분존재 — "신축" 아니라 "확장" (R1b 교정):**
3. **discoverability**: `/knobs` CLI가 **이미 거의 완성**(428줄) → `diff` 추가 + `--help`를 `allKnobs`서 파생(하드코딩 41 폐기)만. 새 `/config` 신축 ❌(있는 `/knobs` 확장/별칭). `set_config` 세션영속은 기존 `DEFAULT_OVERRIDES` 재사용. preset 번들도 이미 완성.
4. **고아 편입 + 검증**: 슬라이스 직접 read(완전성가드가 이미 자동발견)를 적절한 registry로 burn-down, knobs.json untyped→registry 검증. + `--setting-sources` **CLI 플래그**만 추가(env는 됨).

---

## 1. ⚠️ 레이어링 제약이 설계를 결정한다 (핵심)

knob이 **3개 병렬 시스템**으로 존재하는 건 우연이 아니라 **헥사고날 레이어 때문**이다. 그래서 "하나로 합쳐라"는 **불가능**:

> **측정 주석(R1a/R2b 교정 — metric 혼동 금지):** `438`=src 전역 distinct `QUANTA_*` 토큰(help 언급·const 이름 포함, **실 knob 아님 다수**). 실 등록: loadFromEnv 발견 **~132–143**(완전성가드 실측, 세션 중 사용자 동시편집으로 변동; RuntimeConfig 인터페이스 필드는 146이나 1:1 아님) + @/runner/knobs **49**(registerKnob 실측) + **어느 registry에도 없는 고아 read 77**(R2b 재실측, ~60 아님). 이 셋은 **합산 대상 아님**(서로 다른 metric).

- `src/shared/runtime-config.ts` (~132 knob) = **`@/shared` leaf 레이어**. AgentConfig를 안 만지고 **값만** 노출.
- `src/runner/knobs/` (49 knob) = **`@/runner` Layer-2**. `apply(cfg: AgentConfig)`로 **AgentConfig를 변형**(bench matrix/agent-config 튜닝).
- **`@/shared`가 `@/runner`를 import하면 upward 위반 — `biome.json:905`가 실제로 금지**("@/shared is the leaf — pure utilities only", 컨벤션 아니라 tool-enforced) → runtime-config를 @/runner/knobs로 fold **불가**. (a42f "다 합쳐라"는 이래서 기각, a32722 "분리 유지"가 맞음.)

**결론(두 도메인 분리 유지):**
- **값-게이트 knob** (AgentConfig 안 만짐) → `@/shared/runtime-config`에 **그대로 둔다**(rich JSDoc·byte-identity 계약·완전성 가드 이미 있음).
- **AgentConfig-변형 knob** (bench/matrix) → `@/runner/knobs`에 **그대로 둔다**.
- **고아 77개**: 읽히는 레이어에 따라 배치(runner+ 레이어 read → @/runner/knobs; shared/값성 → runtime-config).
- **통합은 registry 병합이 아니라 (a) 거버넌스 ratchet 한 개가 두 테이블 전부 커버, (b) Capability 레이어가 기능↔surface를 묶음 — 두 지점에서만 한다.**

---

## 2. 워크스트림 (rev2 실제 범위)

### W1 — 누락-봉인 거버넌스 (실현가능 순서로 재정렬, R2b 교정)
"기능 추가 시 또 놓침"을 차단. **즉시가능 → 점증 → 장기** 순(R2b: 효과 강도순이 아니라 구현가능 순으로):
1. **메타 ratchet (즉시, 신규 코드 최소)** — *이게 P0의 핵심*: src의 모든 `QUANTA_*` read ∈ **3 테이블 union**(runtime-config 발견 ∪ @/runner/knobs `allKnobs()` ∪ apps/cli-local `cli-knobs`) + 명시적 예외. (capability.gate.knob 체크셋은 앞 2개만 — §9-7.) 기존 knob-completeness 가드를 **두 테이블 합집합**으로 확장(source-scan + allKnobs, 둘 다 이미 발견가능). **decreasing-ceiling burn-down**(현 고아 **77** → 0, 오직 감소; gate-vocab ratchet과 동일 패턴) → **즉시 도입·non-blocking**(===0 강제 아님이라 고아 건드는 PR이 CI RED 안 됨). 신규 누락은 ceiling 초과로 실패.
2. **tools/pm PR 게이트 (`check.ts`)** — *definition-of-done.ts 아님*(그건 순수 verdict). `check.ts`에 git-diff 훅: 새 `QUANTA_*` 추가 PR이 어느 registry도 안 건드리면 실패. 사람 실수 그물.
3. **no-raw-env-read ratchet (점증)**: 지정 reader 밖 `process.env.QUANTA_*`/`gateOn(env,"QUANTA_*")` 직접 read 금지. ⚠️ 허용리스트가 **작지 않음**(R2b: ~12 모듈/~92 site — runtime-config·@/runner/knobs·factory·agent-config-assembler·테스트 + 마이그레이션 중 고아). vacuous는 아니나 "단일 reader"가 아니라 "curated 모듈 집합". 고아 read를 reader로 전환 후 조임.
4. **타입 레벨 (P4-급, 장기)** — ⚠️ *R2b: P0 아님*. `gateOn(env, name: string)`이 string을 받으므로 컴파일에러 내려면 **173+ call-site를 typed `readKnob(name: KnobName)`로 변환** 필요(union은 인터페이스서 자동도출 불가, codegen/hand). 가장 강하지만 가장 비쌈 → 고아 burn-down(W4) 후 P4에서.
5. **드리프트 텔레메트리**: non-default knob emit → north-star(agent-state 가시성) 합류.

### W2 — Capability 레이어 (유일한 신축, §4)
기능↔게이트knob↔surface(LLM도구/슬래시/스킬/훅) 매핑을 **한 곳**에 선언 → 각 surface 노출을 파생. split-brain 근본 봉인. (rev1 §12 그대로, 단 multi-gate/per-surface 보강 — §4.)

### W3 — discoverability (R1b: 대부분 이미 있음, "확장")
- `--help` knob 섹션을 **두 registry의 `describe`/필드에서 파생**(help-render 하드코딩 41 폐기). 테스트 floor를 "≥5" → "audience:user 전수".
- **기존 `/knobs`(428줄, show/list/set/reset/preset/save) 확장** — `diff` 서브커맨드 추가 + runtime-config 값-knob도 노출(현재 @/runner/knobs만). 새 `/config`는 별칭으로만(신축 아님). 출처표시는 기존 `KnobValue.source` 재사용.

### W4 — 고아 편입 + knobs.json 검증
- 고아 77개를 §1 분류대로 배치(burn-down).
- `runner/knobs/persist`의 `user_defaults`(untyped) → registry 타입검증(v1→v2, fail-soft).

---

## 3. 기존 자산별 처분 (어딧 매트릭스)

| 자산 | 처분 | 근거 |
|---|---|---|
| `runtime-config.ts loadFromEnv` (~132-143) | **KEEP** (신축/대체 안 함) | rich JSDoc=감사추적, byte-identity 계약, 완전성 가드 이미 커버. fold는 churn 큰데 ROI 낮음(a32722). registry는 **참조/거버넌스 대상**으로만. |
| `@/runner/knobs/` 프레임워크 | **KEEP-SEPARATE + REUSE** | 레이어상 합칠 수 없음(§1). discoverability/거버넌스가 이걸 **소비**. |
| `src/config/` (ADR-0497) | **EXTEND (⚠️ knobs band SPLIT 필수)** | resolveKnobs "config-file" 소스층 그대로. **R3a-P0 보안**: knobs band를 통째로 `LayerBenign`에 넣으면 untrusted repo settings.json이 `QUANTA_CODE_MODE=1` 켤 수 있음=capability-grant 구멍 → **security-knob(tier:strict-security; code-mode/tls-mitm/mcp/team)→`LayerSecurity`(trust-gated), benign-knob(log-level/pty)→`LayerBenign`**로 분리. ⚠️R4a: merge.ts는 기존 필드(permissions/hooks/mcp)만 하드코딩 게이팅 → **`types.ts`(knobs sub-band)+`merge.ts`(gate 분기)+`loader.ts`(parse) 신규 코드 필요**(자동 안 됨). trust/precedence 재발명 금지. |
| `manifest.ts` config-slot | **EXTEND (capability가 권위)** | manifest=도구축 SSOT 유지. capability.gate가 권위, manifest.gate는 derived/descriptive. ratchet이 일치 강제. |
| `help-render.ts` 하드코딩 41 | **DISCARD + DERIVE** | 수동 큐레이션 실패 증거. registry에서 파생. |
| gate 헬퍼들 | **`parseBool` KEEP-EXPORTED, 나머지 reader 뒤로** | parseBool은 mcp-tool-annotations 테스트가 양 채널 byte-parity로 pin(§6). gateOn/parsePositiveInt는 reader 내부 디테일. |
| `tools/pm/` | **EXTEND** | DoD에 knob-등록 규칙 추가. |
| **`src/config/registry.ts` (rev1 신축안)** | **❌ DROP** | @/runner/knobs가 이미 그것. 4번째 시스템 추가 = 파편화 악화. |

---

## 4. Capability 레이어 (W2 — 유일 신축)

### 4.1 문제
knob=값. 호출 surface(LLM도구=tool-list 등록 / 슬래시=command visible / 스킬=auto-load / 훅=구독)는 **각자 env 직접 읽어 독립 게이팅** → drift(이번 세션 split-brain 정체). manifest config-slot이 도구축에만 부분 존재, 4-surface 통합은 **없음**.

### 4.2 descriptor + 파생
```ts
type Surface = "cli" | "web" | "bench" | "agent-batch" | "agent-interactive" | "ide"  // @/runner/knobs Surface 재사용

interface CapabilityDescriptor {
  id: string
  gate: { knob: string } | { composite: { requires: string[]; resolve(v: Record<string,string|undefined>): boolean } }  // 단일 OR 복합(tls-mitm류 — R2a 작동확인)
  surfaces: {
    llmTool?:    { names: readonly string[] }     // manifest group과 동일(subagent 6-tool/lsp 7-tool 표현 OK, R2a)
    slash?:      { commands: readonly string[] }
    skill?:      { ids: readonly string[] }
    hook?:       { events: readonly string[] }
    thinClient?: { routes: readonly string[] }     // NEW(R2a): skill thinClientDispatch (web/thin 노출) — R3a 확인: skills 한정
    // mcp?: 보류(R3a) — quanta는 MCP CLIENT만(client.ts+oauth-provider), 자기 tool을 MCP SERVER로 재노출 안 함. MCP server mode 생기면 추가.
  }
  perSurface?: Partial<Record<Surface, "on" | "off" | "opt-in">>  // surface별 부분 노출
}
// 순수 config→bool. ⚠️(R2a) "runtime 강제"가 아니라 각 surface의 자연스러운 게이트 시점에 호출:
//   slash = registry-build/load-time(현 BUILTINS 포함여부 결정 지점), llmTool = tool-registration(composition root),
//   hook = wiring 시점. → 기존 load-time 제거(/memory가 env off면 BUILTINS서 빠짐)와 충돌 안 함.
resolveExposure(capId, surface, config) → { llmTool: boolean; slash: boolean; skill: boolean; hook: boolean; thinClient: boolean }
```
- 각 surface의 게이트 reader가 env 직접 read를 멈추고 **자기 시점에** `resolveExposure` 호출 → 결정의 단일 SOURCE는 capability, 호출 시점은 surface별 → **split-brain 구조적 불가 + load-time 제거 보존**(R2a 핵심).
- **multi-gate**: `gate.composite`로 tls-mitm 표현(R2a 작동확인). **부분 노출**: `perSurface`.
- **scope-out(R2a)**: passive-behavior(passive-vcs/read-dedup, 이벤트구동)·status-bar pill(상태반영 UI)은 invocation surface 아니라 capability 대상에서 제외(별도 관리).
- capability.gate.knob ∈ 두 registry(dangling ratchet). 선언 ↔ 실제 manifest/slash/skill 등록 일치 ratchet(split-brain 영구봉인).

**hook-registry 신설(R2a — hook은 manifest 같은 게 없음)**: `src/runner/knobs/hooks-registry.ts`
```ts
interface HookEntry { id: string; env: string; ackEnv?: string; source: "env" | "settings.json#hooks"; surfaces: Surface[]; describe: string }
// 추출(R3a — settings-기반 vs env-only 구분 필수):
//   command-hooks: env QUANTA_COMMAND_HOOKS + ackEnv QUANTA_COMMAND_HOOKS_ACK + source settings.json#hooks (CommandHookGate: armed/acknowledgedRisk/bindings/envAllowlist)
//   lsp-diagnostics: env QUANTA_LSP_DIAGNOSTICS_HOOK, source env-only
//   bench-hooks: env QUANTA_BENCH_HOOKS (bench surface)  ← ≥3개, 착수 전 전수 audit
```

**manifest 권위 인버전(R2a — realistic, R3a 확인: manifest.ts 실존 72 gate)**: capability가 권위가 되면 manifest.gate는 **projector로 파생**. ⚠️ 단 **capability 없는 always-on/resource 도구**(manifest gate `always`/`resource`)는 capability에 안 묶임 → projector는 config-slot/env-flag gate 도구만 변환, always-on은 그대로 통과. 기존 tool-surface drift guard가 manifest==실도구 계속 검증(안전망). projector seam 1개 추가.

---

## 5. 어딧이 잡은 갭/오설계 수정 (rev1 → rev2)

| # | rev1 문제 | 수정 |
|---|---|---|
| 1 | precedence를 새로 발명(settings>knobs.json) | **`resolve.ts` 기존 precedence 채택**(cli>session>env>config-file>preset>default). 발명 금지. |
| 2 | secret(OPENAI_API_KEY)을 registry에 포함 | **❌ 제외.** credential은 기존 `@/auth`·`@/llm/credential-helper`가 권위. `/config set`로 API키 세션변경=과금위험. registry는 feature 토글만. |
| 3 | hot-reload "blanket per-turn 재읽기" 약속 | 기존 `Knob.hotToggleable`로 한정. cached(runtimeConfig 부팅캐시) knob은 "restart 필요" 명시. set_config는 hotToggleable knob만 라이브. |
| 4 | descriptor name `QUANTA_${string}` 하드락 | 기존 `Knob.envKey: string`(QUANTA 안 잠금) 따름. 단 secret/표준env(NO_COLOR)는 registry 밖. |
| 5 | bench를 통합 precedence에 편입 | **bench 격리 보존.** resolveBenchKnobs는 env+preset만(측정무결성) — 기존 surface-aware resolve가 이미 처리, 안 깨면 됨. |
| 6 | knob rename 시 user 데이터 마이그레이션 없음 | knobs.json load 시 마이그레이션 훅(deprecatedBy 따라 old→new rename, warn+keep). |
| 7 | capability 1-cap=1-knob | §4.2 `composite` + `perSurface`로 multi-gate/부분노출 처리. |
| 8 | byte-identity가 등록여부만 검사 | P0에 old-vs-new **출력 스냅샷 비교 테스트** 추가(canonical env → 동일 RuntimeConfig). strict carve-out(code-mode `=`"1"/tls-mitm dual/fs-jail "off") 손-표기 보존. |

---

## 6. 불변식 정합 (어딧: 위반 없음, 단 구현이 지켜야)

- **thin-surface/hexagonal**: 두 도메인 분리(§1)로 upward import 회피. Capability는 `@/config` 또는 신규 얇은 슬라이스, env 직접 read 금지(닫힌 포트). 토큰 판정은 `@/shared`(이미 거기) 재사용.
- **closed-port DI**: resolveExposure/readers는 주입된 sources만(process.env 직접 read 금지).
- **default-OFF byte-identity**: runtime-config KEEP라 P0 추출 churn 없음 → 기존 byte-identity hellgate가 안전망. carve-out 강등 금지(§5-8).
- **parseBool pin**: mcp-tool-annotations 테스트가 양 채널 byte-parity 요구 → parseBool은 단일 함수로 양쪽 공유, export 유지.
- **surface-coupling ratchet**: Capability cross-surface ratchet(§4.2)이 active test로 split-brain 봉인.

---

## 7. 단계 (rev2 — 훨씬 작음, 신규 인프라 최소)

- **P0 — 거버넌스(W1)**: knob-completeness 가드를 **두 registry 합집합**으로 확장 + 고아 burn-down 허용리스트. no-raw-env-read ratchet 초안(P3 후 활성). tools/pm DoD 규칙. → **신규 코드 거의 없음, ROI 즉시**(누락 봉인).
- **P1 — 고아 편입(W4)**: 77개를 §1 분류대로 배치, burn-down→0. knobs.json registry 검증 + 마이그레이션 훅.
- **P2 — discoverability(W3)**: `--help` 파생(하드코딩 폐기) + `/config` CLI.
- **P3 — Capability(W2)**: `CapabilityDescriptor` 신설, manifest/slash/skill/hook을 resolveExposure 파생으로, cross-surface ratchet 활성. (multi-gate/perSurface 포함.)
- **P4 — read 일원화**: no-raw-env-read ratchet 활성(모든 read가 지정 reader 경유 후).
- **P5(opt) — web/embedded 설정 GUI**: 기존 web surface 위에 registry→검색+토글.

---

## 8. ROI / 결론

- **rev1 대비 범위 ~70% 축소**: "registry 신축"이 환상이었음(이미 3개 존재). 진짜 일 = **거버넌스 + Capability + discoverability + 고아편입**.
- **최고 ROI = W1 거버넌스**(신규 인프라 최소, "또 놓침"을 컴파일/CI에서 봉인). 다음 = W2 Capability(split-brain 근본해결, 유일 신축).
- **DROP**: `src/config/registry` 신축, 발명한 precedence, secret 포함, QUANTA 잠금 — 전부 기존 자산이 더 잘하거나 충돌.
- **레이어링이 핵심 교훈**: knob 3시스템은 헥사고날 산물이라 병합 불가 — 통합은 registry 병합이 아니라 거버넌스 ratchet + Capability 두 지점에서만.

---

## 9. 착수 전 명세 보강 (R3b 완전성 비평)

내부모순은 0(R3b-A 전부 CLEAN). 단 아래 under-specification을 P0 착수 전 확정:

1. **통합 `/knobs` 뷰 배선(B7)**: `/knobs`는 apps/cli라 `@/runner/knobs`(allKnobs)와 `@/shared/runtime-config` **둘 다 downward import 가능**(레이어 위반 아님 — apps가 최상위). 통합 뷰 = 두 테이블을 apps 레이어서 합쳐 표시. (런타임-config는 값+기본값만, @/runner/knobs는 hotToggleable/preset까지.)
2. **Capability 레이어 자체 kill-switch(B8)**: P3는 quanta default-OFF 규칙 따라 `QUANTA_CAPABILITY_LAYER`(strict opt-in) 뒤. OFF면 **각 surface의 기존 게이트(load-time 제거/env 직접read) 그대로** = byte-identical degrade. resolveExposure는 ON일 때만 권위. → 버그 시 즉시 롤백.
3. **resolveExposure 테스트(B9)**: ratchet(선언↔등록 일치) 외에 단위테스트 — composite.resolve() truth-table(tls-mitm), perSurface 부분노출, capability-OFF 시 기존동작 byte-identical, 미등록 capId fail-closed.
4. **CapabilityDescriptor registry 위치(B10)**: `@/runner/knobs`와 동형 패턴 — `src/config/capabilities/` 하위 per-feature 파일 + `registerCapability()`/`allCapabilities()` 배럴. (capability.gate.knob ∈ 두 knob registry는 ratchet 검증.)
5. **고아 분류 알고리즘(B11, ⚠️R4a 3번째 버킷)**: 고아 77개 = ① `AgentConfig` 변형? → `@/runner/knobs`(apply 필요) ② daemon 값/path/gate? → `runtime-config` ③ **CLI-render-only**(둘 다 아님 — `QUANTA_STATUSBAR`/`HISTORY_DEFAULT_N`/`KEYBINDINGS`: 표시/입력만, AgentConfig도 daemon-config도 아님) → **`apps/cli` 로컬 registry**(`src/apps/cli/cli-knobs.ts`, 동일 register 패턴; 메타-ratchet은 이 3번째 테이블도 union에 포함). 판정 수동 triage(77개 1회) 후 ratchet 고정. (즉 union = runtime-config ∪ @/runner/knobs ∪ apps/cli-local.) check.ts 시그니처: `(prDiff, unionRegistry) → unregistered[]`.

6. **기존 partial 인프라 reconcile(⚠️R4b — capability가 무에서 만드는 게 아님)**: ① **feature-catalog schema에 `ui_surfaces`+`knobs`+`configurable` 필드 존재**(`tools/feature-catalog/schema.ts:47,50,75`). 단 `knobs`는 **descriptive metadata**(string|object 배열, typed registry 아님 — R5b) → CapabilityDescriptor는 이걸 **참조/링크**(registry 병합 아님, §1 정합). ② **`src/agent/hooks.ts`의 typed `HookEvent` union = 12 이벤트**(R5b 정정: session_start/end·pre/post_tool_use·**post_tool_use_failure**·pre_compact·**post_compact**·subagent_start/stop·permission_request·turn_start·user_prompt_submit) → hook-registry `HookEntry`에 `events: HookEvent[]` 필드로 이 union 참조(이벤트명 재발명 금지; `source`=where-config-comes-from은 별개 축). ③ **set_config는 기존 control-request 프레임워크(ADR-0496, `QUANTA_CONTROL_REQUEST`; set_model/set_permission_mode/set_thinking/get_context_usage)에 variant 1개 추가** — 새 메커니즘 아님(R5b 확인). ④ **`/knobs doHelp`가 이미 `allKnobs()`서 help 파생**(slash-commands-knobs.ts:362) → `--help` env 섹션은 그 derivation 재사용(ENV_TABLE 수동분만 폐기). ⑤ 레지스트리 헬퍼는 **`@/runner/knobs/registry.ts` 패턴**(registerKnob/allKnobs) 복제. (⚠️R5b: `@/skill/registry.ts`는 discovery 패턴이라 register 모델 아님 — 참조 대상서 제외.)

7. **ratchet check-set 명시(R5a — 이제 registry 다중)**: capability.gate.knob ∈ **(runtime-config 발견 ∪ @/runner/knobs `allKnobs()`)** — 이 2개만(knob 진실원). CapabilityDescriptor 자체는 **별도 registry**(`src/config/capabilities/`, knob 아님)라 union에 안 들어감. dangling ratchet은 capability.gate.knob이 위 2개 집합에 있는지만 검증.
8. **`QUANTA_CAPABILITY_LAYER` 등록처(R5a)**: value-gate(AgentConfig 안 변형)라 **`runtime-config`**(strict opt-in, default-OFF). resolveExposure는 이게 ON일 때만 권위; OFF면 각 surface 기존 게이트 그대로(byte-identical degrade).

---

## 10. 어딧 출처 (3-에이전트 + 직접, jun-07)
- 중복/재발명: `@/runner/knobs` 전 프레임워크가 Layer-1 = rev1 §4 (types.ts:47-63 `Knob<T>`, registry.ts, resolve.ts 6-layer, persist.ts, validate/apply).
- 갭/정합: precedence 역전·secret 분리·hotToggleable·bench 격리·rename 마이그레이션·capability multi-gate·byte-identity 스냅샷.
- 개선/교체: runtime-config EXTEND(KEEP)·@/runner/knobs KEEP-SEPARATE(레이어)·manifest EXTEND·help DISCARD+DERIVE·parseBool KEEP.
- 직접: 3시스템 병렬 공존 실측(runtime-config ~132-143 / @/runner/knobs 49 / 고아 77), 레이어링 upward-import 제약.
