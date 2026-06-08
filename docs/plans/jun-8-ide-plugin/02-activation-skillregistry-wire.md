# Ticket 02 — activation 풀배선: `skillRegistry` 주입 + assembler 격상 (gap 1B + 6)

**Date:** 2026-06-08
**Cluster:** jun-8 plugin (host) mode — see `00-index.md` (model + discipline)
**Gap:** #1B (handler가 skill을 표면할 *수* 있으나 auto-wire가 `skillRegistry`를 절대 안 넘김) + #6 (auto-wire는 이미 `agent-config-assembler.ts:797`서 호출되나 **mention-only/MCP-only** flavor — partial)
**Kind:** EXTEND (`auto-wire.ts` · `agent-config-assembler.ts`) — NOT a new slice
**Deps:** needs ticket 01 (`<plugin>:<skill>` namespaced skill source). Feeds ticket 07 (gate `QUANTA_PLUGIN_MODE` comp-root 조립 + default-OFF e2e).

---

## Gap

plugin activation handler는 manifest의 `skills[]`를 `SkillRegistryReadOnly`에 lookup해서 active-skills 채널로 surface할 수 있다. 그러나 **production wire(auto-wire)가 `skillRegistry`를 단 한 번도 주입하지 않아** plugin-declared skill은 영원히 표면되지 않는다. 현재 plugin activation은 **MCP-only** flavor다(서버는 spawn되나 skill은 0).

티켓 01이 `<plugin>:<skill>` 네임스페이스 skill source를 추가하면 "plugin이 선언한 skill 이름이 registry에 존재"하게 되지만, 본 티켓이 그 registry를 handler에 **꽂아주지 않으면** 01의 효과는 죽은 채로 남는다. 즉 01과 02는 한 쌍이다(01=registry에 항목 존재 / 02=handler가 그 registry를 봄).

---

## Current (file:line)

### handler가 skill을 surface하는 조건 — registry 주입 IFF
- `src/agent/plugin-activation-handler/handler.ts:184-191` `runSkillStep`:
  ```ts
  const registry = cfg.skillRegistry
  if (registry === undefined) return []         // ← 미주입 ⇒ skill 0
  if (!Array.isArray(skills) || skills.length === 0) return []
  ```
  주입돼야만 `resolvePluginSkillsForActivation(skills, { registry, emit? }, opts)` (handler.ts:201-205)로 흐른다.
- `src/agent/plugin-skill-extension/extender.ts:122-148` `resolvePluginSkillsForActivation`: manifest의 skill **이름**을 `registry.lookup(name)` (extender.ts:87)으로 조회 → hit만 `ActiveSkillDescriptor`로 project, **miss는 drop**(extender.ts:34-41 "Drop-on-miss"). ⇒ 01이 `<plugin>:<skill>` 이름을 registry에 넣어야 lookup이 hit한다.
- `src/agent/plugin-activation-handler/types.ts:92-99` `ActivationHandlerConfig`: `skillRegistry?: SkillRegistryReadOnly` — optional, 미주입 ⇒ skill step no-op(types.ts:87-88).

### auto-wire가 `skillRegistry`를 의도적으로 생략
- `src/agent/plugin-activation-handler/auto-wire.ts:141-148` handler 빌드 시:
  ```ts
  const handler = createPluginActivationHandler({
    pluginRegistry, mcpLauncherPort, mcpRegistry,
    // skillRegistry intentionally omitted — see module docstring §Defaults.
  })
  ```
- `auto-wire.ts:74-80` `AutoWireDeps` 인터페이스: `pluginRoot?` + `fs?` **두 필드뿐** — registry를 받을 슬롯조차 없다.
- `auto-wire.ts:42-50` §Defaults docstring이 생략 사유를 명시: *"building one synchronously is not possible here (`buildSkillBlock` is async + caches per-session inside the loop)"*. ← 이게 **본 티켓이 풀어야 할 HARD problem**의 1차 진술.

### auto-wire는 이미 공용 assembler서 호출됨 (#6 "partial" 정정)
- `src/host/runtime/agent-config-assembler.ts:797` `autoWirePluginActivation(cfg)` — 공용 `assembleAgentConfig`(line 652) 안. 인터랙티브 경로(`buildInteractiveTurnAssembler` line 812-828)도 `assembleAgentConfig`를 통과하므로 **이미 배선됨**.
- 따라서 `auto-wire.ts:26-29` docstring §4 ("The wire is restricted to `apps/agent/assemble.ts`")는 **STALE**. 본 티켓은 "신규 배선"이 아니라 **기존 호출에 deps를 넘기는 EXTEND**다.

### 🔴 신규 검증: live loop의 skill 빌드 경로는 `buildSkillRegistry`가 **아님**
- `src/skill/registry.ts:228` `buildSkillRegistry`는 **production runtime에서 호출되지 않는다**(grep: `apps/`·loop에 caller 0; src 내 re-export만 — `index.ts:93`). auto-wire docstring이 인용한 `buildSkillRegistry`는 사실상 loop와 무관한 orphan이다.
- 실 per-session skill 빌드 = `src/agent/tier1/skill.ts:94` `buildSkillBlock(config)`:
  - `discoverSkills(dir)` (skill.ts:100) + `discoverSystemSkills()` (skill.ts:106) → `byName: Map<string, Skill>` (skill.ts:107-109) → `inventory` (skill.ts:168-172) = `{name, description, rawDependencies?}[]`.
  - `Skill` 은 `name`+`description`을 갖는다(`src/skill/types.ts:88-92`).
- 호출 체인:
  `buildSessionFeatures` (`src/agent/features.ts:245` `buildSkillBlock` await) → `features.activeSkills = skill?.inventory` (features.ts:301) → `createRunAgentContext` (`src/agent/loop/session-bootstrap.ts:80`) → `session.activeSkills` (session-bootstrap.ts:179) → `prepareTurnContext(...)`의 `activeSkills` 인자 (`src/agent/loop/context-assembler.ts:207`).
- activation은 `prepareTurnContext` 안 `src/agent/loop/context-assembler.ts:266-271`:
  ```ts
  const pluginActivation = await resolvePluginActivationForTurn(config, latestUserTextFromWm(wm), `t${turn}`)
  const augmentedSkills = augmentActiveSkillsWithPlugin(activeSkills, pluginActivation)
  ```
  `resolvePluginActivationForTurn` (`src/agent/loop-activation-hook.ts:263-290`)이 `config.activatePlugins`(= auto-wire가 set한 closure)를 호출.

> **결론(설계 제약):** handler에 꽂을 `SkillRegistryReadOnly`는 orphan `buildSkillRegistry`가 아니라 **`buildSkillBlock`이 만든 바로 그 skill 집합**(또는 01이 그 집합에 주입한 plugin skill)에서 파생돼야 한다. 그래야 활성 가능 surface와 plugin lookup surface가 일치한다.

---

## The HARD problem (명시)

- **타이밍 불일치:** auto-wire는 `assembleAgentConfig`(config-assembly time, **동기**)서 실행된다. 그러나 session의 skill 집합(`buildSkillBlock`)은 **async + per-session, loop 진입 후(`createRunAgentContext`)** 에야 존재한다. config-assembly 시점엔 아직 `byName`/`inventory`가 없다.
- 따라서 auto-wire 시점에 `SkillRegistryReadOnly`를 **즉시(eager) 만들 수 없다**. handler closure는 config 시점에 굳어지는데, 그 안에 들어갈 registry는 나중에야 materialize된다.

### 설계 옵션 비교

| 옵션 | 메커니즘 | 단점 | 판정 |
|---|---|---|---|
| (a) **lazy provider** | `AutoWireDeps`에 `skillRegistryProvider?: () => SkillRegistryReadOnly \| undefined` getter 추가. handler config의 `skillRegistry`를 **호출 시점에 provider를 읽는 thin adapter**로 채움. loop가 `buildSkillBlock` 후 box를 populate. | provider box를 누가 set하나 한 군데 더 배선해야 함(session-bootstrap). | ✅ **채택** |
| (b) second wire pass | skill registry가 생긴 뒤(loop 안) `cfg.activatePlugins`를 **재할당**(두 번째 auto-wire). | caller-override-precedence(`auto-wire.ts:122-124` 이미-set ⇒ no-op)와 충돌 → 1차 wire를 먼저 지우거나 우회해야 함; 1차서 만든 MCP registry/launcher를 버리고 재생성하면 핸들 lifetime/idempotency 깨짐(handler.ts:21-30 캐시). | ❌ lifetime 위험 |
| (c) deferred handler | 첫 activate 호출 시 registry를 resolve하는 self-building handler. | resolve가 async(`buildSkillBlock`)면 handler closure 안에서 async build + per-session 캐시를 재구현 → tier1 로직 중복 + race. | ❌ 중복·복잡 |

### 권장: (a) lazy provider — rationale

1. **타이밍을 깔끔히 분리.** config-assembly 시점엔 *provider 함수*(빈 box를 읽는 getter)만 굳히고, 실제 registry는 loop가 box에 채운다. handler는 매 activation에서 box를 한 번 읽을 뿐.
2. **handler/closure 재구성 0.** 1차 wire가 만든 `pluginRegistry`/`mcpLauncherPort`/`mcpRegistry`/idempotency 캐시(handler.ts:221)를 그대로 둔다 — (b)/(c)와 달리 MCP 핸들 lifetime이 안전.
3. **NO-THROW/byte-identity 보존이 자명.** box가 비면(provider→`undefined`) handler는 오늘과 동일하게 `runSkillStep`서 `[]` 반환(handler.ts:190-191). 즉 *registry 부재 ⇒ MCP-only ⇒ byte-identical*가 코드 변경 없이 그대로 성립.
4. **slice-fence 유지.** provider는 `() => SkillRegistryReadOnly | undefined` 시그니처. `SkillRegistryReadOnly`(`@/skill/registry-readonly`)는 이미 handler/types가 import 허용된 fence-clean 타입(handler.ts:46-48 §Slice-fence). loop 타입(`@/agent/loop|dispatch|prompt|types`)은 시그니처에 등장하지 않음 → fence 무위반(아래 §Slice-fence 상세).

> handler config의 `skillRegistry`는 이미 `SkillRegistryReadOnly` 객체다. lazy provider는 그 객체를 **box-읽는 adapter**로 감싼다:
> ```ts
> // auto-wire.ts 내부 — provider가 있을 때만 adapter를 꽂음
> const skillRegistry: SkillRegistryReadOnly | undefined =
>   deps.skillRegistryProvider === undefined
>     ? undefined
>     : { lookup: (name) => deps.skillRegistryProvider!()?.lookup(name) ?? null }
> ```
> adapter 자체는 NO-THROW(registry-readonly.ts:96-109 패턴: name 빈값/throw ⇒ null). provider가 매 호출 새 box를 읽으므로 **early-turn(아직 미populate) ⇒ `undefined` ⇒ adapter가 `null` 반환 ⇒ skill 0, no crash**.

---

## Design (default-OFF · lazy-provider seam · gate)

### 1) `AutoWireDeps` 확장 (auto-wire.ts)
`skillRegistryProvider?: () => SkillRegistryReadOnly | undefined` 추가. 미지정 ⇒ 오늘과 100% 동일(skill step 영원히 no-op). 지정 시 위 adapter로 `createPluginActivationHandler({ ..., skillRegistry })`에 주입.

### 2) provider box 배선 (assembler ↔ loop seam)
- config-assembly 시점엔 box가 비어 있음. 두 가지 thread 방식 중 택1(작업 시 코드 확인 후 결정 — 둘 다 fence-clean):
  - **(권장) `cfg`의 narrow side-channel box**: `agent-config-assembler.ts:797` 직전에 box `{ current?: SkillRegistryReadOnly }`를 만들고 `autoWirePluginActivation(cfg, { skillRegistryProvider: () => box.current })`로 넘긴 뒤, 같은 box ref를 cfg에 구조적 side-channel로 노출(예: `(cfg as { pluginSkillRegistryBox?: ... }).pluginSkillRegistryBox = box` — `metricsEmitter` side-channel 선례 agent-config-assembler.ts:768-770와 동형). loop의 `createRunAgentContext`(session-bootstrap.ts:80)가 `buildSessionFeatures` 직후 box.current를 채움.
  - **(대안) 명시 슬롯**: `AgentConfig`에 `pluginSkillRegistryBox?`를 정식 선언. side-channel보다 타입-안전하나 `@/agent/types` 수정 필요(01/07과 충돌면 ↑). gate-OFF면 어차피 unset.
- box를 채우는 source = `buildSkillBlock`이 만든 skill 집합에서 `createReadOnlySkillRegistry`(`src/skill/registry-readonly.ts:96`)로 만든 view. **단, ticket 01이 `<plugin>:<skill>` 항목을 그 집합에 넣은 뒤**라야 plugin skill이 lookup된다(01 의존성의 본질).
  - 구현 디테일: `buildSkillBlock`/`buildSessionFeatures`가 `Pick<SkillRegistry,"lookup">`-호환 lookup(또는 `byName` Map)을 expose하도록 ticket 01에서 넓힌다. 02는 그 lookup을 `createReadOnlySkillRegistry`로 감싸 box에 넣는다.

### 3) gate `QUANTA_PLUGIN_MODE` (default-OFF byte-identity)
- `@/shared` `gateOn`(`src/shared/env-flag.ts:73`) SSOT. 게이트 OFF ⇒ box를 **절대 채우지 않음**(provider→`undefined`) ⇒ handler skill step `[]` ⇒ 오늘과 byte-identical. (gate 자체의 comp-root 조립 + e2e는 ticket 07이 소유; 02는 box-populate를 gate 뒤에 두는 것까지.)
- knob 선언: `src/shared/runtime-config-knobs.ts`에 `{ envKey:"QUANTA_PLUGIN_MODE", kind:"bool", default:false, group:"plugin", describe:"..." }` 엔트리(선례 :291 `QUANTA_SKILL_MCP_DEPS`) — **orphan ratchet** 충족. `src/shared/runtime-config.ts`에 필드+read(선례 :299/:1344). *(declare 자체는 07과 겹칠 수 있으니 착수 시 누가 declare하는지 조율; 02는 read만 해도 됨.)*
- **3중 default-OFF**: ① gate OFF, 또는 ② `<cwd>/.quanta/plugins` 비어 discovery 0(auto-wire.ts:135 short-circuit ⇒ `cfg.activatePlugins` unset), 또는 ③ provider box 미populate(early turn / 01 미적용) — 셋 다 byte-identical.

---

## Files (EXTEND only — no new slice)

| 파일 | 변경 |
|---|---|
| `src/agent/plugin-activation-handler/auto-wire.ts` | `AutoWireDeps`(74-80)에 `skillRegistryProvider?` 추가; handler 빌드(141-148)서 provider→box-읽는 NO-THROW adapter를 `skillRegistry`로 주입; docstring §Defaults(42-50)·§4(26-29 STALE) 갱신 |
| `src/agent/plugin-activation-handler/index.ts` | `AutoWireDeps` 이미 export(34) — 시그니처만 넓어짐, 추가 export 불필요 |
| `src/host/runtime/agent-config-assembler.ts` | `autoWirePluginActivation(cfg)`(797) 호출에 `{ skillRegistryProvider }` 전달 + box를 cfg side-channel로 노출(gate `QUANTA_PLUGIN_MODE` 뒤) |
| `src/agent/loop/session-bootstrap.ts` | `createRunAgentContext`(80) `buildSessionFeatures` 직후 box.current를 `createReadOnlySkillRegistry(<01의 lookup>)`로 채움(gate ON일 때만) |
| `src/shared/runtime-config-knobs.ts` · `runtime-config.ts` | `QUANTA_PLUGIN_MODE` declare+필드+read (07과 조율) |
| (ticket 01 소관) `src/agent/tier1/skill.ts` / `features.ts` | session skill 집합에 `<plugin>:<skill>` 항목 + lookup expose |

> handler.ts / types.ts / composite-activation.ts 코드 변경 **불필요** — `skillRegistry` 소비 경로(handler.ts:190-205)는 이미 존재한다. 02는 그 슬롯을 *채우기만* 한다.

---

## TDD — red-first hellgate

신규: `tests/unit/plugin-activation-skillregistry-wire-hellgate.test.ts`. 기존 `tests/unit/composition-activation-auto-wire-hellgate.test.ts`(in-memory `FilesystemPort` fake 패턴, makeFs/makeCfg)를 차용. manifest는 `skills: ["<plugin>:<skill>"]`을 선언하고, fake `skillRegistryProvider`로 그 이름을 hit/miss시켜 surface를 검증.

1. **registry injected ⇒ plugin skill resolves + surfaces**
   manifest `{ skills:["acme:lint"] }` + provider가 `lookup("acme:lint")→{name,description}` 반환 ⇒ `cfg.activatePlugins(...)` 결과 `resolvedSkills`에 `acme:lint` 등장. (red-first: 주입 배선 전엔 `[]`.)
2. **registry absent ⇒ MCP-only byte-identical**
   `skillRegistryProvider` 미지정 ⇒ `resolvedSkills.length===0`, `handles`는 manifest의 `mcpServers`만큼(오늘과 동일). 기존 테스트 5/6과 동치 — 회귀 없음 증명.
3. **gate-off no-op**
   `QUANTA_PLUGIN_MODE` OFF env로 `assembleAgentConfig` 경유 시 box 미populate ⇒ plugin skill 미표면, `cfg.activatePlugins`는 MCP-only(또는 discovery 0이면 unset). gate ON↔OFF 두 config의 prompt activeSkills 블록이 plugin skill 유무로만 갈림.
4. **lazy provider returns undefined early-turn ⇒ no crash**
   provider가 `() => undefined`(box 아직 미populate) ⇒ activate 호출이 throw 없이 `resolvedSkills:[]` 반환. (adapter NO-THROW 입증.)
5. **🔴 red-on-injection (불변식 가드):** *"a wired registry MUST make a declared plugin skill appear on the active-skills channel."*
   provider가 `acme:lint`를 hit하는데 결과 `resolvedSkills`에 `acme:lint`가 **없으면 RED**. 이 어서션이 "주입했는데 표면 안 됨"(=02 회귀)을 영구 적발. 추가로 e2e: `prepareTurnContext`(context-assembler.ts:266-271) → `augmentActiveSkillsWithPlugin` → `ctx.activeSkills`까지 관통시켜 prompt active-skills 블록(`src/agent/prompt.ts:503-504`)에 plugin skill이 실제로 렌더되는지 한 번 검증(실 seam 관통, 00-index discipline).
6. **provider 우선순위/캐시 상호작용:** handler 캐시(handler.ts:221, idempotent per pluginId)가 첫 호출의 빈 결과를 굳히지 않는지 확인 — early-turn(provider→undefined) 후 같은 turn 재호출이 아닌, **다음 turn**에 box populate되면 새 activate가 skill을 본다(turn마다 `resolvePluginActivationForTurn` 새 turnId). (handler 캐시는 per-session이므로, box populate 타이밍이 첫 activate보다 앞서도록 session-bootstrap서 `buildSessionFeatures` *직후* populate하는 게 중요 — 테스트로 박는다.)

red-first 순서: (5)+(1) 먼저 RED(주입 배선 전) → auto-wire+box 배선 → GREEN. (2)(3)(4)는 byte-identity 가드(처음부터 GREEN 유지).

---

## Slice-fence

handler.ts:42-48 / types.ts:18-22 / composite-activation.ts §fence: **MUST NOT import** `@/agent/loop` · `@/agent/dispatch` · `@/agent/prompt` · `@/agent/types`(AgentConfig 순환). 본 티켓이 이를 어떻게 존중하는가:

- **provider 시그니처가 fence-clean.** `skillRegistryProvider?: () => SkillRegistryReadOnly | undefined`. `SkillRegistryReadOnly`는 `@/skill/registry-readonly`(registry-readonly.ts:60) — handler/types가 **이미 import 허용**된 타입(handler.ts:46-48 "MAY import `@/skill/registry-readonly`"). loop 타입은 등장조차 안 함.
- **`AutoWireDeps`는 `@/agent/types`를 import해도 됨.** auto-wire.ts:26-33 docstring §5는 auto-wire만 `@/agent/types` import를 **허용**한다(이미 `import type { AgentConfig }` auto-wire.ts:65). handler/types/composite와 fence 비대칭 — provider 타입을 `AutoWireDeps`(auto-wire.ts)에만 두고 handler config엔 fence-clean `SkillRegistryReadOnly`만 전달하면 비대칭이 안전하게 유지된다.
- **box-populate(loop 방향)는 auto-wire 밖에서.** box.current를 채우는 코드는 `session-bootstrap.ts`(이미 `@/agent/loop` 내부)와 `agent-config-assembler.ts`(`@/host`)에 산다 — plugin-activation-handler 슬라이스 *바깥*. 슬라이스는 provider를 **읽기만** 하지 loop를 import하지 않는다. 의존 방향: loop/host → (set box) → provider closure ← (read) ← handler. 슬라이스는 데이터(함수 ref)만 받는다.
- 정적 가드: 기존 fence 패턴(예: `tests/unit/integrations/github/slice-fence-static-hellgate-r3.test.ts`)처럼 handler/types/composite 소스에 금지 import가 없음을 어서트하는 정적 테스트를 추가/확장(02가 슬라이스 파일을 거의 안 건드리므로 기존 가드로 충분할 수 있음 — 착수 시 확인).

---

## Risks

1. **box-populate 타이밍 race.** `buildSessionFeatures`(session-bootstrap.ts:80) **직후** 채워야 첫 `prepareTurnContext`(context-assembler.ts:266)가 본다. 더 늦게 채우면 첫 turn은 skill 0(early-turn 경로로 graceful하나 1턴 누락). → session-bootstrap의 정확한 위치를 테스트(케이스 6)로 박는다.
2. **handler 캐시 vs 빈 결과.** handler는 per-pluginId 결과를 캐시(handler.ts:234-249). early-turn에 빈 skill로 한 번 activate되면 그 turn 캐시가 굳음. 다음 turn은 새 handler 호출이 아니라 **같은 closure**라 캐시 잔존 → 같은 plugin은 첫 빈 결과를 계속 반환할 위험. **완화:** box를 첫 activate **이전에** populate(위 1과 동일 조치). 잔존 위험이면 ticket 03(enable-state)서 캐시 무효화 훅 검토. (지금은 box-먼저-populate로 충분 — 테스트로 증명.)
3. **`buildSkillRegistry` orphan 혼동.** 01/02 구현자가 docstring 따라 orphan `buildSkillRegistry`(registry.ts:228)를 쓰면 live skill 집합과 불일치(activatable ≠ lookupable). → 본 doc의 "live 경로 = `buildSkillBlock`" 사실을 01/02 모두에 명시. registry source는 반드시 `buildSkillBlock`이 만든 집합.
4. **knob declare 중복(02 vs 07).** `QUANTA_PLUGIN_MODE` declare를 둘이 동시에 추가하면 orphan-ratchet 충돌. → 07이 declare를 소유, 02는 read만(또는 착수 시 조율). 00-index §작업트리 주의의 공유 EXTEND 파일(`runtime-config*.ts`) 동시-세션 충돌도 동일.
5. **side-channel vs 정식 슬롯.** cfg side-channel box는 타입 surface를 안 건드려 01/07과 충돌면이 작으나 타입-안전성↓. 정식 `AgentConfig.pluginSkillRegistryBox?`는 안전하나 `@/agent/types` 수정(충돌면↑). default-OFF면 둘 다 unset이라 byte-identity는 동일 — 착수 시 동시-세션 상태 보고 결정.

---

## Deps

- **needs ticket 01** (`<plugin>:<skill>` namespaced skill source): 01이 session skill 집합에 plugin skill을 넣고 lookup을 expose해야 02가 주입할 registry에 항목이 존재한다. 01 없이는 02의 wire는 동작하나 lookup이 전부 miss(drop-on-miss) → surface 0. **(기능)** plugin skill 표면 **(왜)** handler lookup이 hit하려면 namespaced 항목이 registry에 있어야 함 **(ROI)** 01+02 한 쌍이 gap #1을 완전히 닫음(plugin skill이 실제로 prompt에 등장).
- **feeds ticket 07** (gate `QUANTA_PLUGIN_MODE` comp-root + default-OFF e2e): 07이 gate 조립·comp-root mode·byte-identity e2e를 소유. 02는 box-populate를 gate 뒤에 두는 hook과 knob read를 제공. **(기능)** default-OFF 전사 e2e **(왜)** 02의 wire가 gate OFF서 byte-identical임을 전 surface(CLI/web-daemon)서 증명해야 안전 **(ROI)** 07이 02·03·04·05·06을 한 gate로 묶어 release-ready.

---

## 어딧 (claim-100 ⇒ ≥3R)

본 티켓 "완료" 주장 전 적대 어딧 ≥3회: ① box-populate 타이밍이 첫 activate보다 정말 앞서는가(race 실증) · ② gate OFF + 01 미적용 + discovery 0 세 경로 모두에서 byte-identical(prompt 바이트 비교) · ③ handler 캐시가 빈 결과를 굳혀 plugin skill을 영구 누락시키지 않는가. red-on-injection(케이스 5)은 하드룰 — 주입했는데 미표면이면 RED.
