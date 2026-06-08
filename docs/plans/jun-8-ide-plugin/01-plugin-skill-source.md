# 01 — plugin skill source + `<plugin>:<skill>` 네임스페이스 · gap #1A · EXTEND `skill/registry.ts` · wave-A

**Date:** 2026-06-08
**Model:** `docs/plans/jun-8-ide-plugin/00-index.md` (plugin = {skills + MCP + app} capability bundle; plugin skills surface as `<plugin>:<skill>` — codex `github:gh-fix-ci`) · `docs/reviews-codex-agent/plugin-audit.md` §2.3 (plugin-prefixed skills 직접 관측).
**Discipline:** default-OFF byte-identical (gate `QUANTA_PLUGIN_MODE` via `@/shared` `gateOn`; gate off **또는** `<cwd>/.quanta/plugins` 부재 ⇒ skill registry 바이트동일) · TDD red-first hellgate(red-on-injection 포함) · `@/skill` slice-fence 준수 · claim-100 ⇒ ≥3R 적대어딧.

---

## Gap

`buildSkillRegistry`/`defaultSkillSources`는 6개 source(admin/repo/team/user/personal/system)만 스캔하고 **plugin source가 없다.** 따라서 `<cwd>/.quanta/plugins/<plugin>/skills/<name>/SKILL.md`에 사는 plugin-contributed skill이 registry에 절대 등록되지 않고, activation handler(`resolvePluginSkillsForActivation`)가 선언된 skill NAME을 registry에서 resolve 못 해 전부 drop된다 ⇒ plugin skill이 영원히 표면되지 않음.

## Current (file:line)

- `src/skill/registry.ts:61` `defaultSkillSources(inp)` — 정확히 6개 `SkillSource`만 push: admin(`orgConfigDir/admin-skills`, :64-66), repo(`repoRoot/.quanta/skills`, :67-70), team(`repoRoot/.team-skills`, :71-74), user(`homeDir/.quanta/skills`, :75-78), personal(`homeDir/.quanta/personal-skills`, :79-82), system(`systemSkillsDir`, :83-86). **plugin push 없음.**
- `src/skill/registry.ts:42-51` `SkillSourceInputs` — `repoRoot?/homeDir?/orgConfigDir?/systemSkillsDir?`만. **plugin root 입력 필드 없음.**
- `src/skill/registry.ts:36-39` `SkillSource = { scope: SkillScope; dir: string | null }` — `dir: null` ⇒ "이 host에 미구성"(silent skip, :147-150).
- `src/skill/registry.ts:141-166` `discoverSkillSourcesIn` — source당 `discoverSkills(src.dir)` 호출 후 **scope retag만** 수행(:159-161: discovery가 path로 추론한 scope ≠ 선언 scope면 `{...s, scope: src.scope}`로 덮음). **name 변형(prefix)은 없음** — plugin skill의 `<plugin>:` namespace는 이 retag로 못 만든다.
- `src/skill/registry.ts:189-220` `resolveByPrecedence` — `SKILL_SCOPES_PRECEDENCE_DESC` 순회, **per-`sk.name`** 첫 승자 고정(:198-204), 나머지는 `overridden`에 누적 ⇒ collision. name 기준 dedup이므로 `<plugin>:` prefix가 다르면 collision 자체가 안 생김.
- `src/skill/registry.ts:228-258` `buildSkillRegistry` — `defaultSkillSources(opts)` → `discoverSkillSourcesIn` → legacy fallback(:234) → extraSkills(:238) → `resolveByPrecedence`. plugin 진입점 0.
- `src/skill/types.ts:23` `SkillScope = "builtIn"|"system"|"admin"|"team"|"repo"|"user"|"personal"` (closed union, :26-34 `SKILL_SCOPES`) · `:42-50` `SKILL_SCOPES_PRECEDENCE_DESC = [admin,repo,team,user,personal,system,builtIn]`. **`plugin` 스코프 미존재.**
- `src/skill/plugin-manifest.ts:196-199` `PLUGIN_DIR_NAME=".quanta-plugin"`, `PLUGIN_MANIFEST_FILE="plugin.json"`, `PLUGIN_SKILLS_DIR="skills"`. `:98-101` `name: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/)` (kebab/snake — namespace prefix의 권위). `:109` `skills?: z.array(z.string()).optional()` (declared 목록).
- `src/skill/plugin-loader.ts:99-125` `collectSkillEntries(pluginDir)` — `<pluginDir>/skills/*`를 enumerate, `<dir>/SKILL.md` stat 후 `{name, skillMdPath}` 반환(이름순 정렬, ENOENT/ENOTDIR ⇒ `[]`). **그러나 `Skill` 객체(body/frontmatter)는 안 만든다** — name+path만. (registry는 full `Skill`이 필요 ⇒ `discoverSkills` 경유해야 함.)
- `src/skill/plugin-loader.ts:218-240` `discoverPlugins(rootDir)` — depth-4 walk, `<dir>/.quanta-plugin/plugin.json` 존재 디렉토리를 `{dir, manifestPath}`로 수집(node_modules/.git/dist/build/dotfile skip, :184/211-216). dir 정렬 결정적(:232-238). **이게 plugin root 스캐너의 정본**(layout=`.quanta-plugin`).
- `src/skill/discover.ts:292-318` `discoverSkills(dir)` — `<dir>/<name>/SKILL.md`(nested) + `<dir>/<name>.md`(flat)를 full `Skill`로 파싱, name순 정렬, nested가 flat override. **plugin skill 디렉토리(`skills/`)에 그대로 적용 가능** — `skills/`는 정확히 nested 레이아웃.
- `src/skill/discover.ts:73-95` `inferScopeFromPath` — `.quanta/plugins/` 패턴 매칭 **없음** ⇒ plugin skill의 path-infer scope는 `builtIn`으로 떨어짐(:87). 따라서 source builder가 scope를 **명시적으로 덮어야** 함(registry retag와 동일 메커니즘).
- `QUANTA_PLUGIN_MODE`: `grep -rn` 결과 src/ 전역 **0건**(신규 knob 확정, 충돌 없음).
- `buildSkillRegistry` runtime caller: 현재 prod 호출부 0건(grep). registry는 host adapter가 wrap(:20-24 docstring). ⇒ 이 ticket은 source builder를 추가하되, `buildSkillRegistry`가 plugin source를 **gate+root 입력이 있을 때만** 켜는 형태로 EXTEND. (실제 host 주입은 ticket 02.)

> 정리: 코어 디스커버리 primitive(`discoverPlugins`/`collectSkillEntries`/`discoverSkills`)는 전부 존재. 빠진 것은 **(a) plugin root → per-plugin `skills/` dir → `discoverSkills` → name prefix → registry source** 연결 한 줄, (b) `plugin` scope, (c) gate.

## Design (default-OFF)

### A. `plugin` scope 추가 (types.ts)

`SkillScope`에 `"plugin"` 추가. precedence는 **최하위 직전**에 배치 — workspace skill(repo/user 등)이 동명 skill을 이기되, plugin은 system/builtIn보다 위:

```
SKILL_SCOPES_PRECEDENCE_DESC = [admin, repo, team, user, personal, plugin, system, builtIn]
```

근거: (1) 네임스페이스 prefix `<plugin>:` 때문에 **bare name과 collision이 사실상 안 난다**(`github:gh-fix-ci` ≠ `gh-fix-ci`) — precedence 위치는 안전망일 뿐. (2) 만약 author가 `skills/` 안에 frontmatter로 `name: rr`을 박아 bare name으로 새면(아래 §C에서 prefix 강제로 차단하므로 정상 경로엔 안 생김), repo/user가 이김 = workspace 우선 원칙. (3) system/builtIn(번들 SSOT)보다는 plugin이 위 — 사용자가 깐 plugin이 번들 fallback보다 의미 있음.

`SKILL_SCOPES`(:26-34)에도 `"plugin"` 추가(Zod/CLI SSOT). `isSkillScope`(:53-54)는 배열 참조라 자동 반영.

### B. 새 입력 + source push (registry.ts)

`SkillSourceInputs`에 추가:
```ts
/** Workspace plugin root (`<cwd>/.quanta/plugins`). null/absent ⇒ plugin source 미구성. */
readonly pluginRoot?: string | null
```
`defaultSkillSources`는 **plugin source를 직접 push하지 않는다** — plugin source는 single dir이 아니라 *N개 plugin × 각자 skills/* 의 다중 dir이고, name prefix까지 필요하므로 `SkillSource{scope,dir}` 단일 모델에 안 맞는다. 대신 별도 비동기 builder(아래 §C)가 plugin bucket을 만든다. `defaultSkillSources` 시그니처/출력은 **불변**(6 source) ⇒ 기존 caller 바이트동일.

### C. `src/skill/plugin-skill-source.ts` (NEW, 작은 helper)

```ts
// 슬라이스 내부(@/skill). import: node:path, node:fs/promises(없음 — discoverPlugins/discoverSkills가 fs 담당), @/shared(gateOn), ./discover, ./plugin-loader, ./plugin-manifest, ./types
export const PLUGIN_SKILL_NAMESPACE_SEP = ":"

/** plugin root 아래 모든 plugin의 skills/를 스캔, `<plugin>:<skill>`로 namespaced Skill[] 반환.
 *  scope="plugin"으로 강제. gate off OR root 부재 OR plugin 0개 ⇒ []. NO-THROW. */
export const discoverPluginSkills = async (
  pluginRoot: string | null | undefined,
  env: Record<string, string | undefined>,
): Promise<readonly Skill[]> => {
  if (!gateOn(env, "QUANTA_PLUGIN_MODE")) return []          // ① gate off ⇒ 빈 bucket
  if (typeof pluginRoot !== "string" || pluginRoot.length === 0) return []
  const plugins = await discoverPlugins(pluginRoot)          // ② depth-4, .quanta-plugin/plugin.json
  if (plugins.length === 0) return []                         // ③ no plugins ⇒ 빈 bucket
  const out: Skill[] = []
  for (const p of plugins) {
    const prefix = await pluginNamespace(p)                   // ④ manifest.name(권위) > basename(dir) fallback
    if (prefix === null) continue                             // malformed manifest ⇒ skip(NO-THROW)
    const skillsDir = join(p.dir, PLUGIN_SKILLS_DIR)          // <plugin>/skills
    const skills = await discoverSkills(skillsDir)            // ⑤ full Skill[](nested SKILL.md)
    for (const s of skills) {
      out.push({ ...s, name: `${prefix}${SEP}${s.name}`, scope: "plugin" })  // ⑥ prefix + scope 강제
    }
  }
  // 결정적 정렬(plugin dir 순 + skill name 순은 discover가 보장; 최종 name순 재정렬은 resolveByPrecedence가 함)
  return out
}
```

**namespace 권위(`pluginNamespace`)**: `loadPluginManifest(p.dir)`로 manifest를 읽어 `manifest.name`을 prefix로 사용(kebab/snake 정규식이 `:` 미포함을 보장 — prefix가 안전). manifest 파싱 실패(`PluginManifestError`)면 `null` 반환 ⇒ 해당 plugin **전체 skip**(NO-THROW, 한 깨진 plugin이 나머지를 못 막음). `discoverPlugins`가 이미 `plugin.json` 존재를 확인하므로 정상 경로에선 항상 파싱 성공. (대안: `basename(p.dir)` fallback — 그러나 manifest.name이 dir명과 다를 수 있고 codex 모델은 manifest.name이 정본이므로 **manifest.name 우선, 파싱 실패 시 skip**이 안전. basename fallback은 manifest를 못 읽는 상황 = 이미 비정상이므로 skip이 옳다.)

**왜 `collectSkillEntries`(plugin-loader)가 아니라 `discoverSkills`(discover)인가**: `collectSkillEntries`는 `{name, skillMdPath}`만 주고 frontmatter/body를 안 읽는다(:99-125). registry는 full `Skill`(description/body/tools…)이 필요하므로 `discoverSkills(<plugin>/skills)`를 쓴다 — `skills/`는 정확히 `discoverSkills`가 기대하는 nested(`<name>/SKILL.md`) 레이아웃이라 그대로 동작. `collectSkillEntries`는 ticket 02 이후 enable-state/manifest.skills 교차검증용으로 남겨둔다(이 ticket에선 미사용).

### D. `buildSkillRegistry` EXTEND (registry.ts)

```ts
// 기존 6-source 디스커버리 후, plugin bucket 추가(gate+root가 있을 때만)
const pluginSkills = await discoverPluginSkills(opts.pluginRoot, opts.env ?? process.env)
if (pluginSkills.length > 0) buckets.set("plugin", [...pluginSkills])
```
`SkillRegistryOptions extends SkillSourceInputs`에 `pluginRoot`가 따라 들어옴. `env`는 옵션 필드로 추가(테스트 주입; 기본 `process.env` — 단 `@/shared`의 env 정책 따름, 아래 §slice-fence). plugin bucket이 비면 `buckets.set` 미실행 ⇒ `resolveByPrecedence`가 `buckets.get("plugin") ?? []`(:196)로 빈 처리 ⇒ **registry 바이트동일**.

### 불변식 (default-OFF byte-identity)

`QUANTA_PLUGIN_MODE` off **또는** `pluginRoot` null/부재 **또는** `.quanta/plugins`에 plugin 0개 ⇒ `discoverPluginSkills`가 `[]` ⇒ `buckets`에 `plugin` 키 미추가 ⇒ `entries`/`collisions`/`lookup`/`bySope` 출력이 6-source 시절과 **바이트동일**. 게이트가 켜져도 plugin이 0개면 동일. (red-on-injection: 이 불변식이 깨지면 hellgate가 red — §TDD.)

## Files

| 파일 | 변경 | 내용 |
|---|---|---|
| `src/skill/types.ts` | EXTEND | `SkillScope`에 `"plugin"`, `SKILL_SCOPES`에 `"plugin"`, `SKILL_SCOPES_PRECEDENCE_DESC`에 `personal`과 `system` 사이 `"plugin"` 삽입. |
| `src/skill/plugin-skill-source.ts` | **NEW** (~60줄) | `discoverPluginSkills(pluginRoot, env)` + `pluginNamespace(plugin)` + `PLUGIN_SKILL_NAMESPACE_SEP`. NO-THROW. import: `node:path` `join`/`basename`, `@/shared` `gateOn`, `./discover` `discoverSkills`, `./plugin-loader` `discoverPlugins`/`loadPluginManifest`, `./plugin-manifest` `PLUGIN_SKILLS_DIR`, `./types` `Skill`. |
| `src/skill/registry.ts` | EXTEND | `SkillSourceInputs`+`pluginRoot?`; `SkillRegistryOptions`+`env?`; `buildSkillRegistry`에 plugin bucket 머지(§D). `defaultSkillSources` **불변**. |
| `src/skill/index.ts` | EXTEND | `discoverPluginSkills`/`PLUGIN_SKILL_NAMESPACE_SEP` re-export(ticket 02가 소비). |
| `src/shared/runtime-config-knobs.ts` | EXTEND | `{ envKey:"QUANTA_PLUGIN_MODE", kind:"bool", default:false, group:"misc", describe:"Plugin host mode: surface plugin-contributed skills/MCP/app." }` (orphan ratchet). |

> **runtime-config.ts 필드는 이 ticket에서 추가하지 않는다** — gate는 `discoverPluginSkills`가 `gateOn(env, "QUANTA_PLUGIN_MODE")`로 **직접** 읽는다(registry는 pure transform; `runtimeConfig()` 글로벌 의존을 안 들인다 = 테스트 주입성 유지, :17-24 docstring 철학). knob declare는 orphan ratchet 통과용. (ticket 07이 comp-root에서 `runtimeConfig().pluginMode`로 격상할지 결정 — 이 ticket 범위 밖.)

## TDD (red-first hellgate)

순수 unit(in-memory fixture dir; 실 fs는 tmpdir fixture로). 전부 red-first.

1. **discovered + namespaced** — fixture: `<root>/acme/.quanta-plugin/plugin.json`(name="acme") + `<root>/acme/skills/foo/SKILL.md`. gate on. ⇒ registry `lookup("acme:foo")` 적중, `winnerScope==="plugin"`, `skill.body`/`description` 채워짐(full Skill — `collectSkillEntries` 아닌 `discoverSkills` 경유 증명). bare `lookup("foo")` ⇒ undefined(prefix 안 새는지).
2. **🛑 red-on-injection: gate off ⇒ byte-identical** — 동일 fixture, gate **off**. plugin source가 `[]` ⇒ 6-source registry와 `entries`(이름/scope/순서)·`collisions` **deep-equal**. 별도로 plugin이 존재해도 gate off면 `lookup("acme:foo")===undefined`. (이 assert가 깨지면 red — default-OFF 불변식 가드.)
3. **🛑 red-on-injection: no plugins ⇒ byte-identical** — gate **on**, `pluginRoot` 존재하나 `.quanta/plugins` 빈 디렉토리(또는 부재). plugin bucket `[]` ⇒ 6-source registry와 deep-equal. `pluginRoot:null`도 동일.
4. **두 plugin 동명 skill** — `acme/skills/build` + `globex/skills/build`(둘 다 manifest name acme/globex). gate on. ⇒ `acme:build`·`globex:build` **둘 다** 등록(prefix가 다르므로 collision 0), `registry.collisions`에 `build` 항목 **없음**. (namespace가 collision을 막는지 증명.)
5. **malformed plugin dir skip** — `<root>/good/.quanta-plugin/plugin.json`(valid)+`good/skills/x` AND `<root>/bad/.quanta-plugin/plugin.json`(JSON 깨짐 또는 schema mismatch). gate on. ⇒ `good:x` 등록, `bad` 전체 누락, **throw 없음**(나머지 진행). `discoverSkills`가 못 읽는 skill dir(SKILL.md 없는 폴더)도 silent skip.
6. **precedence vs repo skill** — bare name collision을 인위로 만들기: plugin skill의 frontmatter `name:`을 prefix 없이 새게 한 **음성 경로**는 정상 코드에서 prefix를 강제하므로 발생 불가 — 대신 **양성 증명**: repo source에 `name:"rr"` + plugin이 `acme:rr`(prefix됨) ⇒ 둘 다 등록(서로 다른 name, collision 없음). 그리고 **precedence 단위 테스트**(types): `SKILL_SCOPES_PRECEDENCE_DESC`가 `repo` < (precedence 높음) `plugin` < `system`임을 직접 assert(만약 미래에 동명이 생기면 repo가 이기고 plugin이 builtIn보다 위라는 계약 고정).
7. **namespace prefix 정확성** — manifest `name:"my-plugin"`(kebab) + skill dir `foo-bar` ⇒ `my-plugin:foo-bar`. `name`에 `.`/`_`/`-` 포함(`a_b.c-d`) 케이스도 prefix 정확. **`:`는 prefix에 안 들어감**(정규식이 `:` 불허 — manifest.name이 권위라 안전) 확인.
8. **manifest.name vs basename 권위** — plugin dir명 `dir-xyz`인데 `manifest.name:"realname"` ⇒ prefix는 **`realname:`**(dir명 아님). manifest 파싱 실패 fixture(plugin.json 빈 파일) ⇒ 해당 plugin **skip**(basename fallback 안 함, NO-THROW).
9. **scope 강제** — plugin skill의 `sourcePath`가 `.quanta/plugins/...`라 `inferScopeFromPath`는 `builtIn` 추론하지만, source builder가 `scope:"plugin"`을 덮어 `winnerScope==="plugin"`인지(retag 누락 회귀 가드).
10. **NO-THROW 전반** — `discoverPlugins`가 던지는 fs 에러(EACCES 등)·`discoverSkills` 내부 실패에도 `discoverPluginSkills`가 `[]` 또는 부분결과 반환, never throw(loop-safe).
11. **결정성** — 동일 fixture 2회 호출 ⇒ `entries` 순서·내용 동일(정렬 결정적).

## Slice-fence

`@/skill`은 biome `noRestrictedImports`(biome.json:426-460)로 `@/agent`·`@/mcp`·`@/memory`·`@/storage`·`@/stream`·`@/permission`·`@/runtime`·`@/lsp`·`@/observability`·`@/llm`·`@/subagent`·`@/security`·`@/patch`·`@/rules`·`apps/cli` import 전부 **금지**. 허용 = `@/tool`, `@/shared`, 슬라이스 내부(`./*`), `node:*`.

- `plugin-skill-source.ts`: `@/shared`(`gateOn`)·`node:path`·슬라이스 내부(`./discover`/`./plugin-loader`/`./plugin-manifest`/`./types`)만 ⇒ **fence 준수**. **⚠️ `@/agent/plugin-discovery`를 import하면 안 됨**(다른 slice) — 반드시 슬라이스 내부 `./plugin-loader`의 `discoverPlugins`(`.quanta-plugin` depth-4 스캐너)를 쓴다. (2개의 동명 `discoverPlugins`가 존재: `@/skill/plugin-loader`(이걸 사용)와 `@/agent/plugin-discovery`(import 금지·breadth-1·`.codex-plugin`).)
- `registry.ts`: 기존 import(`node:path`·`./discover`·`./types`) 외 `@/shared` `gateOn`을 `discoverPluginSkills` 내부에서만 쓰므로 registry.ts 자체는 `./plugin-skill-source` import만 추가 ⇒ fence 준수.
- `env` 주입: registry는 pure transform 유지 — `process.env` 직접 참조 대신 `opts.env` 우선, fallback만 `process.env`(`@/shared`가 env-flag로 wrapping). 글로벌 `runtimeConfig()` 끌어오지 않음(테스트 주입성·:17-24 철학).
- biome.json **수정 불필요**(신규 path 없음; `plugin-skill-source.ts`는 `src/skill/**` 글롭에 자동 포함). tsconfig `@/skill` 와일드카드 기존 커버 ⇒ 신규 path 등록 불필요.

## Risks

- **scan cost / depth** — `discoverPlugins`는 depth-4 walk(plugin-loader.ts:56 `MAX_DISCOVERY_DEPTH=4`)이나 node_modules/.git/dist/build/dotfile를 skip(:184/211)하므로 monorepo에서도 종료. plugin당 `loadPluginManifest`(manifest+mcp read) + `discoverSkills`(skills dir 1-depth) — plugin 수×skill 수 선형. session 시작 1회(registry는 snapshot, 캐시 없음 :20). gate off면 walk 자체를 안 함(① 조기 return) ⇒ off-path 비용 0.
- **symlink** — `discoverSkills`(:281)·`collectSkillEntries`(:111)가 symlink 디렉토리를 따라감(skill 작성 관례). plugin skills/ 안의 symlink가 트리 밖을 가리키면 임의 SKILL.md를 읽을 수 있으나 **읽기 전용**(코드 실행 아님)이고 plugin 설치 자체가 trust 행위. depth-4 cap + read-only로 한정. (강제 격리는 plugin-isolation/permission rail = ticket 05 영역, 여기 아님.)
- **namespace collision** — `manifest.name`이 두 plugin에서 동일하면 `<name>:<skill>`도 충돌. `discoverPlugins`가 dir 정렬(:232) 후 순회하므로 **나중 plugin이 같은 namespaced name을 push** ⇒ `resolveByPrecedence`가 동일 scope(plugin) 내 첫 승자 고정(:198-204)·나머지를 collision으로 기록. 즉 **조용한 덮어쓰기 아님 — `registry.collisions`로 관측됨**(TDD §4의 반대 케이스). 동명 plugin은 설치 단계 정책(ticket 03/06 enable)에서 거부 권장 → DEFER 노트.
- **precedence 놀람** — plugin을 `personal`과 `system` 사이에 넣으면 미래에 bare-name 동명이 생길 때 repo/user가 이긴다(의도). 만약 "plugin이 user skill을 덮어야 한다" 요구가 생기면 precedence 재배치 = ADR 필요. 현재는 prefix로 collision을 회피하므로 위치는 안전망. precedence 변경은 `SKILL_SCOPES_PRECEDENCE_DESC` 단일 SSOT라 1곳.
- **frontmatter `name:` override 누수** — `discoverSkills`는 frontmatter `name:`을 skill id로 채택(discover.ts:166). plugin skill이 `name: rr`을 frontmatter에 박으면 dir명 대신 `rr`이 되지만, source builder가 **그 뒤에** `${prefix}:${s.name}`로 prefix하므로 최종은 `acme:rr` — bare로 새지 않음(§C ⑥가 unconditional prefix). TDD §7이 가드.
- **빈 manifest.name 회귀** — 정규식 `min(1)`이라 빈 name 불가; 파싱 실패면 §C가 plugin skip. basename fallback을 **안 하는** 결정이라 "manifest 못 읽는데 dir명으로 추정"하는 모호함 제거.

## Deps

- **upstream**: 없음(wave-A 독립 코어). `discoverPlugins`/`discoverSkills`/`loadPluginManifest`/`gateOn`/`SkillScope` 전부 기존 자산.
- **downstream(feeds)**: **ticket 02**(activation 풀배선) — `auto-wire.ts`가 `buildSkillRegistry({ ..., pluginRoot, env })`로 registry를 만들어 `createPluginActivationHandler({ skillRegistry })`에 주입하면, `resolvePluginSkillsForActivation`이 manifest의 `skills:["acme:foo"]`(또는 bare→prefix 정규화는 02에서 결정)를 `lookup("acme:foo")`로 resolve 가능. **이 ticket이 registry에 `<plugin>:<skill>`을 등록하지 않으면 02의 lookup이 전부 miss**(현 상태). 02는 namespaced name 표기 규약(manifest.skills가 bare인지 prefixed인지)을 추가로 정의한다.
- 병렬: ticket 03(plugin-session)·05(capability-policy)와 무관 — 동시 진행 가능.
