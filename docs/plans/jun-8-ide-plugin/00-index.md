# jun-8 Plugin (host) mode — ticket index + master board

**Date:** 2026-06-08
**Goal:** quanta를 **plugin 호스트**로 — discovered plugin 번들({skills + MCP servers + app capabilities})을 enabled-상태로 노출하고, plugin-aware **routing preference**를 적용. Codex/Claude의 plugin 모델(아래 §모델)을 따른다.
**Source of truth:** `docs/reviews-codex-agent/plugin-audit.md`(plugin = capability bundle + routing layer; R2 manifest 스키마). 본 계획은 그 모델을 quanta 기존 자산 위에 *조립*한다.
**Discipline (all tickets):**
- default-OFF byte-identical: gate `QUANTA_PLUGIN_MODE`(@/shared `gateOn`); 게이트 off **또는** `<cwd>/.quanta/plugins` 비면 기존과 바이트동일.
- TDD red-first; hellgate에 **red-on-injection**(불변식 깨지면 반드시 red) 포함. e2e는 실 seam 관통.
- 신규 슬라이스 → `@/agent/*` 와일드카드로 tsconfig 커버(plugin-discovery 등과 동일, 신규 path 대개 불필요) + biome **slice-fence**(noRestrictedImports) 준수.
- gate-vocab는 `@/shared` `gateOn`/`gateDisabled` SSOT. **knob home 분기**(티켓 03/07 코드검증): `QUANTA_PLUGIN_MODE`는 comp-root서 `gateOn`으로 읽는 **host-gate**라 `src/config/knob-inventory.ts`(group host-gate, `QUANTA_WORKTREE_TOOL` 선례)에 등록 — `runtime-config-knobs.ts`/`runtime-config.ts` 필드는 **아님**(거긴 `runtimeConfig().x`로 소비되는 knob 전용). orphan ratchet(`knob-registry-completeness-ratchet-hellgate.test.ts`, ORPHAN_CEILING=0)은 read-site 기준이라 inventory 등록으로 green.
- claim-100 ⇒ ≥3R 적대어딧.

---

## 모델 (plugin-audit.md best-fit)

```
Plugin = { plugin-contributed skills (<plugin>:<skill>) , MCP servers , app/UI capabilities }
         + routing preference ("관련 plugin 있으면 standalone보다 우선")
```
- plugin은 **직접 호출 도구가 아님**. 노출한 skill/MCP/app path로 우회 사용.
- manifest엔 **선언적 permission 없음** — capability(Interactive/Read/Write)는 *advertise*만, 실제 admissibility는 격리 경계 + permission rail이 결정.
- on-disk layout(quanta rename): `<plugin>/.quanta-plugin/plugin.json` + `<plugin>/.mcp.json` + `<plugin>/skills/<name>/SKILL.md`. 루트 규약 `<cwd>/.quanta/plugins`.

## 이미 있는 자산 (reuse, ADR-0162 / 0336~0350)

| 슬라이스 | 역할 | 상태 |
|---|---|---|
| `src/skill/plugin-manifest.ts` · `plugin-loader.ts` · `manifest-compat.ts` | manifest 스키마 + codex-compat 인제스트 | ✅ reuse |
| `src/agent/plugin-discovery/` (ADR-0336) | `discoverPlugins` + in-memory registry(`lookup`/`list`, **stateless**) | ✅ reuse |
| `src/agent/plugin-mcp-launcher/` (ADR-0338) | isolated MCP spawn + `PluginMcpRegistry` lifetime | ✅ reuse |
| `src/agent/plugin-skill-extension/` (ADR-0339) | `resolvePluginSkillsForActivation`/`unionActiveSkills` | ✅ reuse |
| `src/agent/plugin-activation-handler/` (ADR-0340/0350) | `@mention`→ MCP+skill 활성 closure, `autoWirePluginActivation` | 🟡 EXTEND |
| `src/agent/loop-activation-hook.ts` (ADR-0346) | 턴마다 `cfg.activatePlugins` 호출(mention-only, prompt 미접촉) | 🟡 consume |
| `src/agent/plugin-app-resolver/` · `mention-injection/` | `@plugin` mention 해석 | ✅ reuse |
| `src/plugin-isolation/` (ADR-0162) | PluginHost JSON-RPC + lifecycle heartbeat + DXT loader | ✅ reuse |

## 코드레벨 검증된 gap (file:line)

| # | Gap | 증거(file:line) | 티켓 |
|---|---|---|---|
| 1 | plugin 스킬 미표면 | `handler.ts:191`(skillRegistry 없으면 `[]`) + `auto-wire.ts:145`(생략) + `registry.ts:61` `defaultSkillSources`에 **plugin 소스 없음**(admin/repo/team/user/personal/system 6개뿐) | 01,02 |
| 2 | routing-preference 0 | `loop-activation-hook.ts:23`(non-goal "does NOT touch `@/agent/prompt`"); preference 블록 전무 | 04 |
| 3 | mention-only, enabled-state 부재 | `loop-activation-hook.ts:281`(`mentions.length===0→EMPTY`); `PluginRegistryPort`=`lookup/list`만(plugin-discovery/types.ts:115); `enablePlugin` grep=0 | 03 |
| 4 | 표면/knob 0 | `/plugins`·`QUANTA_PLUGIN` grep=0 | 06,07 |
| 5 | capability→perm 미연결 | `manifest.interface.capabilities`는 선언만; `dispatch.ts`·`src/permission/`서 소비 0 | 05 |
| 6 | ~~CLI 미배선~~ **정정**: partial flavor | `autoWirePluginActivation`은 `agent-config-assembler.ts:797`(공용 `assembleAgentConfig`, 인터랙티브 포함)서 **이미 호출**. docstring "apps/agent 전용"은 stale → "신규배선" 아니라 **EXTEND**(skillRegistry+session 주입) | 02,07 |

## 🛑 코드레벨 검증서 발견한 함정/latent (착수 전 숙지)

각 티켓에 상세. 구현 트랩이라 인덱스에도 박음:
1. **`discoverPlugins` 2개 존재** — `@/skill/plugin-loader` `discoverPlugins`(plugin-loader.ts:218, depth-4, `.quanta-plugin/plugin.json`) vs `@/agent/plugin-discovery` `discoverPlugins`(discovery.ts:94, breadth-1, `.codex-plugin`). 티켓 01은 **전자**(`@/skill`)를 써야 slice-fence 안 깸. (티켓 01)
2. **`buildSkillRegistry`는 런타임 루프서 dead**(prod 호출 0, 재export만). 실제 per-session skill build는 `buildSkillBlock`(tier1/skill.ts:94)→`discoverSkills`→`features.activeSkills`. 핸들러에 주입할 skill set은 거기서 파생해야 함(orphan registry 아님). (티켓 02)
3. **latent leak: `auto-wire.ts:138`이 `PluginMcpRegistry` 핸들을 retain 안 함** → 오늘 `shutdownAll()` 호출 불가능. 티켓 03 lifecycle + 07 comp-root retain이 닫음. (티켓 03/07)
4. **plugin-origin tool 식별 lossy** — `composeServerId`의 `::`가 `mcpToolName` sanitize서 `_`로 붕괴(`a_b::c`↔`a::b_c` 충돌). 재파싱 금지 → minted tool명 forward-index. (티켓 05)
5. **manifest 타입 2종** — agent-side `@/agent/plugin-discovery` `PluginManifest`(`.description?`) vs skill-side `@/skill/plugin-manifest` `interface.shortDescription`. routing-block/surface는 discovery 타입 소비(`@/agent`에 2번째 manifest 타입 도입 금지). (티켓 04/06)

## 티켓 (ticket-unit)

| # | 티켓 | gap | 종류 | 의존 |
|---|---|---|---|---|
| 01 | plugin skill source + `<plugin>:<skill>` 네임스페이스 | 1A | EXTEND `skill/registry.ts` | — |
| 02 | activation 풀배선(skillRegistry 주입) + assembler 격상 | 1B,6 | EXTEND `auto-wire.ts`·`agent-config-assembler.ts` | 01 |
| 03 | `plugin-session/` enable-state + lifecycle(shutdownAll) | 3 | NEW slice | — |
| 04 | routing-preference 레이어(`plugin-routing/` + prompt 소비) | 2 | NEW slice + EXTEND prompt | 03 |
| 05 | capability→permission rail(`plugin-capability-policy.ts`) | 5 | NEW + dispatch gate | 03 |
| 06 | `/plugins` 표면(list/enable/disable/status) | 4 | NEW surface 3파일 | 03 |
| 07 | gate `QUANTA_PLUGIN_MODE` + comp-root mode 조립 + default-OFF e2e | 4,6 | knob + comp-root | 02,03,04,05,06 |

상세는 각 `NN-*.md`. 전부 default-OFF·TDD red-first·slice-fence·≥3R 어딧.

## 시퀀싱 (병렬 가능 축)

- **병렬 wave-A (독립 코어)**: 01(skill source) · 03(plugin-session) · 05(capability-policy pure) — 서로 무관, 동시.
- **wave-B (코어 의존)**: 02(01 위) · 04(03 위) · 06(03 위) — wave-A green 후.
- **wave-C (통합)**: 07(전부 위) — gate + comp-root + default-OFF byte-identity e2e + 최종 어딧.

## ⚠️ 작업트리 주의

현재 트리에 **동시 세션의 in-flight 작업**(NEW 클러스터 16-25: browser/mcp-server/fleet 등)이 다수 uncommitted. 본 계획 doc은 신규 폴더라 충돌 없음. **구현 착수 전** 동시 세션 상태/영속화 조율 필요(이전 IMPROVE 작업이 reset에 한 번 먹힌 전력). 각 티켓은 신규 슬라이스 위주라 충돌면이 작지만, 공유 EXTEND 파일(`agent-config-assembler.ts`·`registry.ts`·`registry-surface.ts`·`runtime-config*.ts`)은 동시 세션과 겹칠 수 있어 착수 시 재확인.
