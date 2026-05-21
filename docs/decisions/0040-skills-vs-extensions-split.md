# ADR-0040: Skills vs Extensions split + SKILL.md frontmatter

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: Cluster E F14, codex-system-skills-pattern, ADR-0022(skill 트리거), ADR-0039(plugin manifest)

## 맥락

Codex 분석에서 발견된 SKILL.md frontmatter는 두 부류를 한 ML 파일 포맷에
혼합한다:

1. **Skills** — LLM이 reminder loop에서 자동 trigger 가능, optional하게
   사용자가 `/skill-name` 슬래시 명령으로도 호출 가능. allowedTools whitelist
   가 활성화 시 적용된다.
2. **Extensions** — 시스템 레벨 (예: pre-turn hook, post-tool-call
   formatter). LLM auto-trigger 절대 안 됨. 사용자 슬래시 명령으로도 호출
   안 됨. SKILL.md frontmatter만 공유.

v3 기존 `src/skill/frontmatter.ts`는 의도적으로 lenient (`unknown key는
keep as-is`, scalar 강제 coerce 안 함). 이는 reminder cache 길이 안정성을
위한 설계지만, 두 부류 분류에 쓰기에는 contract가 약하다. drift가 모델의
auto-trigger 결정에 silent 영향.

## 결정

### Part 1 — 6-field strict frontmatter

`src/skill/skill-frontmatter.ts` 신규 모듈에서 SKILL.md frontmatter를
**별도** 6-필드 schema로 enforce:

```yaml
name: string              # kebab-case canonical id
description: string       # short, model-facing
userInvocable: boolean    # `/name` slash command 허용 여부
allowedTools: string[]    # 명시적 whitelist (empty = NO tools, not "all")
category: skill | extension
stability: experimental | stable | deprecated
```

기존 `frontmatter.ts`는 그대로 두고 (lenient discover 용도 유지), 이 모듈은
**별도** parser + Zod schema를 ship — 두 호출 경로 모두 보존하여 byte-
identical 회귀 0.

### Part 2 — hand-rolled YAML splitter

`js-yaml` 의존 추가 금지 (Cluster E hard rule, RFC §1.4 npm dep cap).
SKILL.md frontmatter는 6 필드 / 3 scalar 타입 (`string | boolean | string[]`)
만 받는 restricted subset만 parse. 모든 reject 케이스는 1-based line
number 동봉 (`FrontmatterParseError.line`):

- 누락된 fence (`---`)
- duplicate key
- indented continuation line
- 알 수 없는 escape (`\z`)
- bareword `yes` / `True` / `null` / 숫자 → 모두 reject (boolean은 literal
  `true`/`false`만)
- flow map `{a: 1}` / anchor `&x` / tag `!x` → reject (YAML 1.2 advanced
  feature 미지원)

### Part 3 — classify + allowedTools gate

`src/skill/skill-vs-extension.ts`:

- `classify(fm) → { kind: "skill" | "extension", userInvocable }` 순수
  dispatch.
- `assertAllowedTool(fm, toolName)` — `allowedTools` 미포함 시
  `ToolNotAllowedBySkillError` throw. **empty array는 NO tools**, 절대
  "all"이 아님 (heuristic 금지).
- defensive: `category: extension` + `userInvocable: true` 모순 조합은
  Zod 통과 후 classify에서 추가 throw — schema가 받아들였다고 routing이
  거짓말하지 않도록.

## 근거

- 두 부류 혼합은 Codex 패턴 그대로 — 한 파일 포맷에 user-invocable + 시스템
  hook을 묶는 게 authoring DX 측면 ROI가 높았다고 분석에서 확인.
- 별도 parser: 기존 `frontmatter.ts`의 lenient 흡수가 cache prefix
  byte-stability 보존에 의존하므로 (ADR-0004), 같은 파서로 strict 모드
  switch는 위험. 분리가 회귀 0 보장.
- empty `allowedTools` = no-tools: "0 tools" 와 "all tools" 의도가 시각적
  으로 구분 안 가는 게 보안 이슈 (`allowedTools: []` 의미를 잊고 LLM이
  Bash 호출 → silent grant). explicit-deny가 safer default.

## 대안

- **기존 frontmatter.ts에 strict 모드 옵션 추가**: 기각 — cache prefix
  byte-stability 회귀 위험 + dual-purpose가 readability 저하.
- **`js-yaml` 도입**: 기각 — npm dep 0 정책.
- **empty allowedTools = "all"**: 기각 — 의도와 의미 분리, 보안 default
  파괴.

## 결과·트레이드오프

- **얻은 것**: 6-필드 strict schema가 frontmatter drift를 빌드/load 타이밍
  에서 잡음. classify + assertAllowedTool가 host loop의 명확한 enforcement
  seam. 30+ frontmatter + 7 classify + 3 fixture integration test all
  green.
- **비용**: skill author가 frontmatter 작성 시 기존 lenient (`tools:` 약식)
  과 신규 strict (`allowedTools:` 명시) 둘 다 인지해야 함 → 마이그레이션
  가이드 필요 (limit (b)).

## 한계 (LIMITATIONS)

- **(a) 실 슬래시-명령 라우팅은 별도 wiring**: 본 ADR은 frontmatter +
  classify까지. `userInvocable: true` skill을 CLI가 실제 `/name`로 받아
  실행하는 router는 `src/apps/cli/` follow-up.
- **(b) 기존 frontmatter.ts와 신규 schema의 dual 운영**: 호환 기간 동안
  두 파서가 공존. 향후 단일화 ADR 필요할 수 있음 (지금은 회귀 0이 더
  중요).
- **(c) Extensions의 hook 시점 정의는 비어있음**: pre-turn / post-tool 같
  은 hook 시점 enum은 별도 ADR. 본 ADR은 분류 surface만.

## 불변식 영향

- **슬라이스 격리 유지**: `src/skill/` 신규 2개 파일만 추가. 기존
  `frontmatter.ts` / `discover.ts` 등 무수정.
- **RFC/ADR 동기**: ADR-0022 trigger 정책과 충돌 없음 — 신규 6-필드는
  trigger 정책 위에 얹는 분류 layer.
- **신규 npm dep 0** (hand-roll parser).
- **cache prefix byte-stability (ADR-0004) 보존**: 기존 frontmatter.ts
  무수정으로 cache prefix 동일.
