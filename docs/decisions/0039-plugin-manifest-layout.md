# ADR-0039: 플러그인 매니페스트 레이아웃 (.quanta-plugin/)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: Cluster E F13, codex-plugin-manifest-pattern, RFC §1.6 ("no foreign brand in paths"), ADR-0022(Skill 트리거)

## 맥락

Codex 분석에서 발견된 플러그인 패키지 레이아웃은 단일 디렉터리에
`.codex-plugin/plugin.json` + 옵셔널 `.mcp.json` + `skills/<name>/SKILL.md`
세 surface를 묶는 형태였다. plugin.json은 `interface { capabilities,
defaultPrompt, displayName, ... }` 같은 메타데이터 17 필드 + author/mcpServers/
skills 등을 strict shape으로 보관한다. quanta-codeagent-v3는 플러그인을
사용자 영역 (USER_PLUGINS_DIR) + repo-local 영역 (./plugins/) 모두에서
검색해야 하며, MCP 서버 와이어업 시 manifest의 mcpServers 키를 1차 SSOT로
삼는 호스트 경로가 필요하다.

문제: (a) Codex 그대로 `.codex-plugin/` 이름을 ship하면 우리 제품 path에
타사 브랜드를 박제하게 된다 (RFC §1.6 위반). (b) plugin.json은 호스트가
신뢰해야 하는 SSOT이므로 schema drift는 무조건 loud-fail 해야 한다
(swallowed default 금지).

## 결정

### Part 1 — 디렉터리 명 v3 rename

`.codex-plugin/` → **`.quanta-plugin/`**. `plugin.json` / `.mcp.json` /
`skills/<name>/SKILL.md` 세 surface는 그대로 유지. canonical 경로 상수는
`src/skill/plugin-manifest.ts`에서 `PLUGIN_DIR_NAME` /
`PLUGIN_MANIFEST_FILE` / `PLUGIN_MCP_FILE` / `PLUGIN_SKILLS_DIR`로 단일화 —
어떤 다른 모듈도 string literal로 경로를 박지 않는다.

### Part 2 — Zod schema strict mode

- `PluginManifestSchema` — top-level 9 필드 (`name/version/description/author/
  homepage?/license/keywords/mcpServers?/skills?/interface`) 모두 `.strict()`.
  unknown key는 schema 위반 — silent drop 금지.
- `PluginInterfaceSchema` — 14 필드 (`displayName / shortDescription /
  longDescription / developerName / category / capabilities / websiteURL /
  privacyPolicyURL / termsOfServiceURL / logo / composerIcon? /
  defaultPrompt / brandColor / screenshots`). `capabilities`는 **closed
  enum** `Interactive | Read | Write` (Codex 그대로). 새 capability 추가는
  ADR 개정 필요 — silent widening 금지.
- `MCPServerSpecSchema` — `{ command: nonempty-string, args: string[], env?:
  Record<string,string> }` strict.
- `PluginAuthorSchema` — `name` 필수, `email` / `url` 옵셔널 (각각 zod
  email / url validate).

### Part 3 — loader + discovery

`src/skill/plugin-loader.ts` 단일 모듈에 `loadPluginManifest(dir)` /
`discoverPlugins(rootDir)` 노출:

- loader: 매니페스트 → Zod parse → 옵셔널 `.mcp.json` parse → skills dir
  enumerate (`<dir>/skills/<name>/SKILL.md`만 entry로 인정).
- discovery: depth 4 cap, `node_modules` / `.git` / `dist` / `build` /
  dot-prefix 디렉터리 (canonical `.quanta-plugin/` 제외) skip, deterministic
  sort (path lex order).
- 에러는 `PluginManifestError` (`cause: "missing" | "json" | "schema" |
  "io"`)로 typed 분기 가능. silent fallback 0개 — `.mcp.json`이 present-
  but-broken이면 loader가 throw (genuinely-absent만 무시).

## 근거

- Codex 패턴은 plugin authoring tool과 marketplace UI가 직접 의존하는
  schema — 변형은 호환성 비용. capability/displayName/icon 등 UI 메타데이터
  surface를 그대로 보존하면 외부 plugin → quanta import 시 manifest 무수정
  마이그레이션 가능.
- strict mode + closed Capability enum: silent typo가 plugin registration
  miss로 이어지지 않게 함. 새 capability 도입은 명시적 ADR + schema 개정
  경로.
- `.quanta-plugin/` rename: 우리 path에 타사 brand 박제 안 함 (RFC §1.6).

## 대안

- **`.codex-plugin/` 그대로 ship**: 기각 — 브랜드 누출.
- **Zod 대신 hand-roll schema**: 기각 — Zod는 이미 코드베이스 dependency,
  strict + discriminated union이 freebie.
- **discovery max depth = 무제한**: 기각 — `node_modules` 같은 거대 tree에서
  runaway 위험. 4가 monorepo + plugins/ 구조 둘 다 cover.

## 결과·트레이드오프

- **얻은 것**: Codex-compat manifest shape을 v3 path 명으로 ship. loader가
  cause-typed error로 호스트 분기 enable. discovery depth + skip-set이
  monorepo에서 안전. 49 unit + integration tests (manifest schema 30 +
  loader 14 + discovery 5) all green.
- **비용**: plugin authoring 시 디렉터리 이름이 Codex와 다름 → 호환 변환
  도구가 향후 필요할 수 있음 (limit (a) 참조).

## 한계 (LIMITATIONS)

- **(a) plugin runtime loader 통합은 follow-up**: 본 ADR은 schema +
  filesystem layout만 정의. 실제 host wiring (discoverPlugins → MCP
  bridge 등록 → SkillRegistry 등록)은 별도 follow-up. 현재는 contract +
  test surface만 안정화.
- **(b) screenshots 필드는 string[] placeholder**: Codex 실 사용은 asset
  path 객체 array일 수 있음. 우리는 string entry 받아두고 향후 ADR
  개정에서 narrow.
- **(c) `.mcp.json` 다중 server**: Codex 1개 서버만 가정하던 코드 경로도
  존재했음. 우리는 `Record<string, MCPServerSpec>`로 보관 — host는
  명시적으로 enumerate해야 함.

## 불변식 영향

- **슬라이스 격리 유지**: `src/skill/` 신규 파일만 추가 (additive). 다른
  슬라이스 import 0.
- **RFC/ADR 동기**: RFC §1.6 path-no-brand 보강.
- **신규 npm dep 0**.
- **Tier 1 catalog**: `tools/feature-catalog/features/06-tier1/06-plugin-
  manifest.yaml` 추가.
