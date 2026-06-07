# RFC — Knob Registry: 선언적 설정 SSOT + derive-everything (`src/config/`)

> **Status: 📐 DRAFT (jun-07) — 설계 제안. 미구현. 그린필드(quanta는 현재 설정파일 레이어 없음, env-only).**
> Date: 2026-06-07
> Slice: NEW `src/config/` (descriptor + registry + read + sources + derive + control) — 슬라이스 펜스: `zod`/`@/shared`만, `@/agent` 금지
> Default posture: byte-identical 마이그레이션 (P0는 기존 `loadFromEnv` 139개를 registry fold로 교체, 출력 불변)
> Feature axis: 설정/거버넌스 축 (NEW) — feature-catalog(기능축)·tool-surface manifest(도구축)에 이은 **세 번째 SSOT 축**
> 한 줄: knob 하나당 타입 있는 descriptor 하나를 단일 테이블에 선언하고, 파싱·기본값·검증·runtime-config·`--help`·config UI·on/off 토글·settings 레이어·가드를 **전부 그 테이블에서 파생**한다.

---

## 1. 요약

quanta는 환경변수 `QUANTA_*` ≈ **438개**(src, 비-test, grep-verified)로 동작이 갈리지만, 진실원이 **암묵적**이다. 중앙 `loadFromEnv`에 등록된 건 **139개**뿐이고, 나머지 ~60개(아티팩트 제거 후)는 CLI/host/slice 레이어에서 `process.env`로 직접 읽혀 **어느 registry에도 없다**. 결과: (1) 사용자가 기능 존재를 모르고(`--help`엔 41개), (2) on/off 토글 수단이 env뿐이며(영속 settings도, 세션 중 토글도 없음), (3) ~60개는 default-OFF auto-guard 밖.

본 RFC는 **선언적 KnobDescriptor registry**를 단일 SSOT로 도입하고, runtime-config·`quanta config` CLI·`--help`·settings.json 레이어·검증·가드·런타임 토글을 전부 거기서 파생한다. UX는 **VSCode 환경설정과 동형**(검색·그룹·토글·기본값표시·JSON 레이어·라이브 반영). drift는 ratchet으로 영구 차단.

---

## 2. 경쟁사 레퍼런스 (verified evidence)

- **VSCode `contributes.configuration`** (`package.json`): 각 설정이 `type/default/description/enum/enumDescriptions/scope(application|machine|window|resource)/markdownDescription/order`를 선언 → Settings UI(검색·카테고리·토글/드롭다운·modified표시·reset-to-default)와 `settings.json` 검증이 전부 이 스키마에서 파생. 본 RFC의 `KnobDescriptor`가 1:1 대응.
- **Claude Code settings** (`docs/plans/jun-7-draft-ide-integration-spec-claude.md` §12): `claude-code-settings.schema.json`이 `**/.claude/settings.json`·`settings.local.json`·`managed-settings.json`을 검증; `--setting-sources user,project,local` precedence; `allowManagedHooksOnly`/`disableBypassPermissionsMode` 같은 관리자 lock. 본 RFC의 sources 레이어가 동형.
- **Claude Code control-request** (동 문서 §2): `set_model`/`set_permission_mode`/`get_settings`/`apply_flag_settings` 로 **세션 중 라이브 설정 변경**. 본 RFC의 `set_config` 런타임 토글이 동형.

→ 흡수 결론: 세 레퍼런스 모두 "선언 스키마 → 파생 UI/파일/검증 + 레이어드 소스 + 런타임 토글" 패턴. quanta는 이걸 멀티-surface(CLI/web/embedded)로 일반화한다.

---

## 3. 현재 quanta 상태 (grep-verified)

- **설정파일 레이어 없음**: quanta 자체 `settings.json` 로더 0. (`migration/external-config`는 경쟁사 config IMPORT 전용, quanta 런타임 설정 아님.) → env-only.
- **registry/descriptor 없음**: `src/shared/runtime-config.ts`의 `loadFromEnv`가 손으로 쓴 객체. 리더 분포(실측): `gateOn` 68 · `parsePositiveInt` 30 · `parseBool` 14 · `gateDisabled` 3 · `parseSwebench`/`parsePtyBackend`/`parseLogLevel` 각 2 → **7종 kind**.
- **있는 것(위에 얹는다)**: gateOn/gateDisabled(+strict) SSOT(jun-7 통일 완료) · feature-catalog(YAML, 기능축) · tool-surface manifest(도구축) · ratchet/burn-down 패턴(검증됨) · `runtimeConfig()` accessor(캐시+reset) · permission accessor per-turn 재읽기 패턴.
- **측정 갭**: distinct `QUANTA_*` 438 / 중앙등록 139 / `--help` 41 / 미등록 read ~60.

---

## 4. 설계

### 4.1 원자 — `KnobDescriptor`

```ts
// src/config/descriptor.ts
type KnobKind = "bool" | "int" | "float" | "enum" | "string" | "path" | "duration-ms" | "bytes" | "csv"
type KnobGroup =
  | "loop" | "memory" | "permission" | "mcp" | "subagent" | "ui"
  | "git" | "network" | "session" | "vector" | "web" | "bench" | "observability"

interface KnobDescriptor<T = unknown> {
  name: `QUANTA_${string}`                  // env 이름 = SSOT 키 (유일)
  kind: KnobKind
  default: T                                // unset일 때 값 (대부분 false/0/undefined)
  // bool 전용
  polarity?: "opt-in" | "kill-switch"       // default-OFF vs default-ON
  tier?: "normal" | "strict-security"       // gateOn vs gateOnStrict (code-mode/tls-mitm류)
  // 검증
  enumValues?: readonly string[]
  min?: number; max?: number
  // 거버넌스/표시
  scope: ReadonlyArray<"cli" | "web" | "bench" | "headless" | "ide">  // 어느 surface가 존중
  audience: "user" | "internal" | "bench"   // user만 --help/config UI에 노출
  group: KnobGroup
  summary: string                           // 한 줄 (--help/UI에 그대로)
  stability?: "stable" | "experimental" | "deprecated"
  deprecatedBy?: `QUANTA_${string}`
  adr?: string                              // 추적성
}
```

### 4.2 SSOT + 파생 모듈

```
src/config/
  descriptor.ts   KnobDescriptor 타입 + KnobKind/KnobGroup union
  registry.ts     export const REGISTRY: readonly KnobDescriptor[]   ← 유일한 진실원 (~200)
  read.ts         readKnob<T>(name, sources): T — descriptor 보고 kind/tier/default대로 파싱+검증
  sources.ts      precedence chain + resolve(name)
  derive.ts       runtimeConfigFor(surface) / helpDoc() / settingsJsonSchema() — 전부 REGISTRY fold
  control.ts      set_config 런타임 토글 핸들러 (descriptor로 검증)
  index.ts        배럴
```

**파생물 (전부 REGISTRY에서 생성 — 손수 관리하는 표를 두지 않는다):**

| 파생물 | 생성 방법 | 대체 대상 |
|---|---|---|
| `runtimeConfig()` | `REGISTRY.filter(scope∋surface).reduce(readKnob)` | 손으로 쓴 `loadFromEnv` 139 |
| `quanta config list/get/set/diff` | `REGISTRY.filter(audience:user)` 그룹별 + 현재값/기본값/출처 | 없음 (신규) |
| `--help` knob 섹션 | 동일 | help-render 하드코딩 41 |
| settings.json **JSON Schema** | descriptor→schema (검증/에디터 자동완성) | 없음 |
| 값 검증 | kind/enum/min-max 위반 시 명확 에러(출처 인용) | ad-hoc `parsePositiveInt` |
| default-OFF 가드 | `descriptor.polarity`로 단언 | knob-completeness regex discovery |
| 텔레메트리 | non-default knob 목록 = config drift 가시화 | 없음 |
| 웹/embedded 설정 GUI | descriptor → 검색+토글 위젯 (kind→위젯) | 없음 |

핵심: **runtime-config는 registry의 타입 프로젝션**이 된다(이중관리 제거). `gateOn`/`parsePositiveInt` 등은 `readKnob` 내부 디테일로 흡수.

### 4.3 소스 레이어링 (사용자 on/off의 실체)

```ts
// sources.ts — 위가 이김
resolve(name) = firstDefined(
  env[name],               // 1. ad-hoc / CI (최우선)
  session.get(name),       // 2. 세션 중 /config set (이 세션 한정)
  settingsLocal[name],     // 3. <proj>/.quanta/settings.local.json (gitignore, 개인)
  settingsProject[name],   // 4. <proj>/.quanta/settings.json (커밋, 팀)
  managed[name],           // 5. managed-settings.json (관리자 lock)
  descriptor.default,      // 6. 코드 기본값
)
```

- Claude Code `--setting-sources` + `allowManagedHooksOnly`와 동형. quanta trust/policy-merge layering과 정합.
- `managed`는 admin 강제층(예: 보안팀이 `code-mode` 영구 OFF lock) → `allowManagedOnly`로 하위층 무시.
- 보안 carve-out: `tier:"strict-security"` knob(code-mode/tls-mitm)은 `env`/`managed`만 허용하고 `session`/`settings` 레이어로는 못 켜게 막는다(우발적 활성화 방지).

### 4.4 런타임 토글

- control-request `set_config {knob, value}` (Claude `set_model` 동형) → descriptor 검증 → `session.set` → **config-accessor per-turn 재읽기**(기존 permission accessor authority 패턴 그대로).
- CLI: `/config list`, `/config set memory off`, `/config diff`(기본값 대비).
- 잘못된 값 → descriptor 인용 즉시 거부: `QUANTA_EFFORT: enum {default,low,medium,high,max} 중 하나, 'foo' 받음`.

---

## 5. 통합 (3축 분리·교차참조)

- **기능축** = feature-catalog(YAML): "어떤 기능이 있나".
- **도구축** = tool-surface manifest: "LLM이 어떤 도구를 보나".
- **설정축** = knob-registry(본 RFC): "사용자가 무엇을 토글하나". ← NEW
- 교차 무결: 게이트형 도구의 env가 registry에 있고 manifest gate와 일치(ratchet). feature-catalog 엔트리는 자기 knob을 registry로 link.
- composition root: `runtimeConfigFor(surface)`가 surface 부트스트랩(cli/web/headless)에서 호출 — surface별 시딩이 `scope` 필드로 일원화.

---

## 6. 가드 / 헬게이트 ("다 등록"을 영구 강제 — jun-7 ratchet 패턴 재사용)

1. **registry-completeness ratchet**: src에서 읽히는 모든 `QUANTA_*` ∈ REGISTRY. 누락 시 실패 + burn-down 허용리스트(현 ~60 → file→count 소진).
2. **no-raw-env-read ratchet**: `read.ts` 밖에서 `process.env.QUANTA_*` 직접 read 금지(gate-vocab ratchet의 일반화). 전부 `readKnob` 경유.
3. **doc-completeness**: 모든 `audience:user` descriptor는 비지 않은 `summary`+`group` 필수.
4. **default-OFF (registry 기반)**: `polarity!=="kill-switch"`면 default falsy 단언(기존 regex discovery 졸업).
5. **cross-axis 정합**: catalog·manifest·registry 3축 상호 참조 무결.
6. **red-on-injection self-test**: 각 ratchet이 주입된 위반을 실제로 잡는지(vacuous-0 방지).

---

## 7. 마이그레이션 단계 (빅뱅 금지 · byte-identical · 단계별 회귀게이트)

- **P0 — registry 골격 + 기계추출**: descriptor+registry+readKnob 도입. registry를 기존 139 `loadFromEnv`에서 **기계 추출**(`gateOn(env,"X")`→`{name:"X",kind:"bool",polarity:"opt-in",tier:"normal",default:false}`; `parsePositiveInt`→`{kind:"int",...}`). `loadFromEnv`는 registry fold로 교체. **출력 byte-identical**(기존 default-OFF/byte-identity hellgate가 증명). 회귀 0.
- **P1 — 미등록 burn-down**: ~60개를 registry로 편입(ratchet이 강제). bench-internal은 `audience:bench`로. 갭→0.
- **P2 — discoverability**: `--help` knob 섹션 + `quanta config` CLI를 registry에서 파생(하드코딩 41 제거).
- **P3 — settings 레이어**: settings.json/local/managed 로더 + precedence + `/config set` + JSON Schema 생성.
- **P4 — read 일원화**: no-raw-env-read ratchet 활성화(슬라이스 read 전부 readKnob 경유 전환 완료 후).
- **P5(opt) — 웹/embedded GUI**: web surface 붙으면 descriptor→검색+토글 설정화면(같은 registry).

각 단계 독립 PR, 회귀 0, 보안 carve-out(code-mode/tls-mitm strict) 보존.

---

## 8. 비용 / ROI (HONEST)

- **비용**: P0~P1이 핵심(타입+registry+readKnob+139 기계추출+~60 burndown) ≈ 1~2 세션. P2~P5 점증(각 독립).
- **ROI 큼**: ① discoverability(사용자가 전 기능 발견+토글) ② drift 영구차단(파생==원본 ratchet) ③ 검증 일원화(좋은 에러) ④ settings.json으로 팀/CI 영속화 ⑤ config-drift 텔레메트리 ⑥ 멀티-surface 공짜(한 번 등록→CLI/web/embedded 다 따라옴) ⑦ 경쟁사(VSCode/Claude settings-schema) 패리티 흡수.
- **위험 낮음**: P0가 byte-identical 추출이라 기존 동작 불변, 기존 hellgate가 안전망. 표면적 큰 건 P3(settings 레이어)뿐 — 독립이라 분리/연기 가능.

---

## 9. 리스크 / 대안 / 비결정

- **리스크**: registry가 거대 단일파일(~200엔트리) → group별 파일 분할(`registry/loop.ts`+barrel)로 완화. 기계추출 오분류(int를 bool로) → P0 byte-identity hellgate가 즉시 적발.
- **대안 A (기각)**: zod 스키마만으로 검증. → 검증은 되나 default/scope/audience/group/runtime-toggle 메타가 없어 UI/레이어 파생 불가. descriptor가 상위호환.
- **대안 B (기각)**: 그냥 `--help`만 채우기. → discoverability 일부 해결하나 drift/토글/레이어/가드 미해결. 본질 미봉.
- **비결정**: settings.json 위치(`.quanta/` vs `~/.quanta/`)와 trust-scope 연동은 P3에서 trust/policy-merge ADR과 함께 확정.

---

## 10. 코드 위치 요약

- NEW: `src/config/{descriptor,registry,read,sources,derive,control,index}.ts`
- 변경: `src/shared/runtime-config.ts` `loadFromEnv` → `derive.runtimeConfigFor()` 위임(P0)
- 파생 소비: `src/apps/cli/help-render.ts`(P2), `src/apps/cli/config-cmd.ts`(NEW, P2), settings 로더(P3)
- 가드: `tests/unit/config/{registry-completeness,no-raw-env-read,doc-completeness,default-off-from-registry}-hellgate.test.ts`
- 교차: feature-catalog YAML `knob:` 필드 link, tool-surface manifest gate 정합 ratchet

---

## 11. UX 비교 (VSCode 환경설정과 동형)

| VSCode | quanta knob-registry |
|---|---|
| `contributes.configuration` 엔트리 | `KnobDescriptor` |
| Settings UI(검색/그룹/토글/기본값/reset) | `quanta config` (CLI grid) + web/embedded 설정화면 |
| `settings.json` (user→workspace→folder) | sources 레이어 (env→session→local→project→managed→default) |
| `onDidChangeConfiguration` (라이브) | control-request `set_config` + per-turn 재읽기 |
| scope(application/machine/window/resource) | scope(cli/web/bench/headless/ide) |
| (거의 전부 노출) | `audience` 게이팅(internal/bench 숨김 — 438개 중 user-facing만) |

---

## 12. Capability 레이어 (호출 surface 통합 — knob 한 층 위)

### 12.1 문제: knob ≠ invocation surface
knob은 기능의 **on/off 값**이지만, 켜진 기능이 **어떻게 호출되냐**는 surface마다 다르다:
- **LLM 도구**: 모델 tool list에 등록되냐 (`src/tool/surface/manifest.ts`, `gate:{kind:"env-flag"|"config-slot"}`)
- **슬래시커맨드**: command 목록에 보이냐 (`src/apps/cli/slash/registry-surface.ts`)
- **스킬**: auto-load 되냐 (`buildSkillGate`)
- **훅**: 이벤트가 구독/발화되냐

오늘은 이 네 surface가 **각자 env를 직접 읽어 독립 게이팅**한다. 한 기능(예 `subagent`)이 manifest env-flag + runtime-config knob + 슬래시 visible 조건에 **따로따로** 박혀 있다. → **이게 jun-7 split-brain 버그 클래스의 정체**(manifest는 "on"인데 슬라이스 reader는 `=== "1"`이라 `=on`이 도구만 켜고 기능은 안 켜짐 — QUANTA_INDEX, 6-게이트). surface마다 손으로 게이트를 박으니 drift가 난다.

### 12.2 해결: `CapabilityDescriptor` (Layer 2)
```ts
// src/config/capability.ts
type Surface = "cli" | "web" | "bench" | "headless" | "ide"

interface CapabilityDescriptor {
  id: string                              // "memory" | "subagent" | "web-search"
  gate: { knob: `QUANTA_${string}`; tier?: "normal" | "strict-security" }  // 단 하나의 게이트 knob (→ Layer 1 registry)
  surfaces: {                             // 켜졌을 때 "어떻게 호출되냐"
    llmTool?: { names: readonly string[] }      // 모델에 노출되는 도구 이름
    slash?:   { commands: readonly string[] }   // 보이는 슬래시커맨드
    skill?:   { ids: readonly string[] }        // 자동 가용 스킬
    hook?:    { events: readonly string[] }      // 발화되는 훅 이벤트
  }
  defaultBySurface?: Partial<Record<Surface, "on" | "off" | "opt-in">>  // surface별 기본 posture
}
```

### 12.3 파생: `resolveExposure`
```ts
// 게이트는 capability에 한 번만 선언 → 각 surface 노출은 파생 (손으로 env 안 읽음)
resolveExposure(capId, surface, config): { llmTool: boolean; slash: boolean; skill: boolean; hook: boolean }
```
- `manifest`/`slash registry`/`skill gate`/`hook subscriber`가 더 이상 env를 직접 읽지 않고 `resolveExposure`를 호출한다 → **split-brain 구조적 불가능**(jun-7 버그 클래스 소멸).
- surface별 호출 의미가 다른 걸 descriptor가 선언으로 흡수: LLM도구=tool-list 등록, 슬래시=command 목록 visible, 스킬=auto-load, 훅=구독.
- surface별 기본값 차이도 `defaultBySurface`로(예: `memory` = CLI on / web opt-in / headless off).

### 12.4 두 레이어의 관계 + 가드
- **Layer 1 (knob-registry, §4)** = 값. "QUANTA_X가 무슨 타입/기본/검증인가."
- **Layer 2 (capability)** = 매핑. "어떤 기능이 어떤 knob으로 게이팅되고, 켜지면 어느 surface로 노출되나."
- capability.gate.knob ∈ knob-registry (ratchet으로 dangling 참조 차단).
- **cross-surface 정합 ratchet**: capability가 선언한 surface 노출이 실제 manifest/slash/skill 등록과 일치(불일치 = 빌드 실패). 이게 split-brain을 영구 봉인.
- `/config set memory off` → Layer 1 값 변경 → `resolveExposure`가 LLM도구·슬래시·스킬·훅 노출을 **한꺼번에** 끔(cascade). 사용자가 한 번 끄면 모든 호출 경로가 일관되게 사라진다.

### 12.5 마이그레이션 (§7에 추가)
- **P6 — Capability 승격**: manifest의 `config-slot`(이미 tool↔slot↔env 링크 존재)을 최상위 `CapabilityDescriptor`로 승격. manifest/slash/skill/hook 게이트를 `resolveExposure` 파생으로 전환. cross-surface 정합 ratchet 활성화. (P1~P4 knob-registry 안정화 후 착수 — Layer 1 위에 Layer 2를 얹음.)

### 12.6 3축과의 관계
- 기능축(feature-catalog) = "무엇이 있나" (사람용 카탈로그)
- 도구축(manifest) = "LLM이 무엇을 보나" → **capability.surfaces.llmTool로 파생**
- 설정축(knob-registry) = "사용자가 무엇을 토글하나" (Layer 1)
- **Capability(Layer 2)** = 이 셋을 묶는 접착제: 기능 ↔ 게이트 knob ↔ 모든 surface 노출. 결과적으로 feature-catalog/manifest/slash/skill이 전부 capability에서 파생되어 **단일 진실원으로 수렴**.
