# ADR-0205: Multi-source rules vendor-detector (S2 — 5-vendor convergence)

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련 ADRs**: ADR-0098 repo-rules-tree-scoping, ADR-0099 default-NO-git posture, ADR-0102 .cursor/.quanta glob rules
- **참조**: `src/rules/vendor-detector/{port,vendor-table,normalizer,default-detector,index}.ts`, `tests/unit/vendor-rules-detector-hellgate.test.ts` (19 cases)

## 맥락

다섯 경쟁 코딩 에이전트(Cursor/Cline/Roo/Aider/Windsurf)가 각자 on-disk rule format을 가짐. 사용자가 그 중 하나에서 quanta로 migrate 하거나, 기존 vendor 설정이 있는 repo에서 quanta를 돌릴 때:

- **Cursor**: `.cursor/rules/*.mdc` (YAML frontmatter + body, `globs` / `alwaysApply`)
- **Cline**: `.clinerules` (flat 파일 OR `.clinerules/*.md` 디렉토리)
- **Roo**: `.roo/rules-{mode}/*.md` (mode-scope 파일들)
- **Aider**: `.aider.conf.yml` (YAML) + `CONVENTIONS.md` (markdown)
- **Windsurf**: `.windsurfrules` (always-applied plain text)
- **우리 자체**: `.quanta/rules/*` (mdc 호환)

기존 `src/agent/glob-rules.ts`는 `.cursor/rules` + `.quanta/rules`만 알았다. 즉 Cline에서 migrate한 사용자의 `.clinerules`는 모델이 못 봄. 5-vendor 강신호가 같은 패턴으로 수렴함을 확인 — 흡수 ROI 높음.

## 결정

**`src/rules/vendor-detector/` 신규 slice**, port-shaped:

1. **`port.ts`**: `VendorDetectorPort.detectAll({cwd}) → Promise<DetectionResult>` (rules + errors). **no-throw across boundary** — 모든 실패 mode가 typed `DetectorError`.
2. **`vendor-table.ts`**: declarative `VENDOR_TABLE` (6 entries). 배열 순서 = priority. `PathKind` 3-types (`file` / `dir` / `mode-dir`) 닫힌 enum, exhaustive-switch.
3. **`normalizer.ts`** (pure): vendor data → 공통 `DetectedRule` (`vendor`, `sourcePath`, `description`, `body`, `trigger{alwaysApply, globs, mode?}`, `scope`, `metadata`). collision resolution: 같은 `sourcePath`가 두 vendor에 잡히면 priority 낮은(table 앞쪽) vendor가 win — **우리 `.quanta`가 foreign vendor를 무조건 이김**.
4. **`default-detector.ts`** (`node:fs/promises` adapter): symlink reject(file+dir), 2x body cap 초과 시 read 전 skip, `maxFiles=256` cap.
5. **`index.ts`**: barrel.

slice fence: `@/rules`는 `@/shared`만 import. `@/skill` 의존 회피 위해 frontmatter parser 인라인 (50 LOC 부분 집합 — same as `@/skill/frontmatter.ts`). `yaml` lib 미사용 — declared key set이 작아서 dependency-free 충분.

**implicitly-always** 정책: Windsurf/Cline(flat)/Aider/Roo는 `alwaysApply:` 키 없어도 always-applied로 승격(각 vendor convention). Roo의 mode tag는 alwaysApply 승격 시 preserve (mode는 rule identity, trigger axis 아님).

**Default-OFF**: 기존 `glob-rules.ts` 경로 byte-identical. `detectAll`를 호출하지 않는 caller는 변화 없음. wiring은 후속 슬라이스에서.

## 결과

- `tests/unit/vendor-rules-detector-hellgate.test.ts`: 19 cases (6 per-vendor smoke / 4 absence-empty-malformed / 3 security / 5 determinism-collision / 1 pure normalize). 모두 tmpdir 기반 real I/O — 단 normalize/collision unit은 in-mem.
- src tsc 0(내 슬라이스 한정 — 사전 존재 5건은 별 트랙), biome 0 errors / 0 warnings (cognitive complexity 2건은 helper 추출로 해결).
- 기존 `tests/unit/rules*` + `glob-rules-hellgate` + `round3-hardening` 50 tests no regression.

## 한계

- **wiring 미완**: `runAgent` / `loadGlobRules`로 흘리는 composition은 별 슬라이스. 본 ADR은 detector 신설까지만. (`@/agent/glob-rules.ts`가 `loadGlobRules` 호출 시 detector도 호출하도록 후속 작업 필요)
- **글로벌 frontmatter 라이브러리 미도입**: 사용자 spec은 `gray-matter` install을 제안했지만 — install은 verify-workflow 정책상 blocked, 게다가 dependency-free 인라인이 slice fence(`@/shared`만)를 유지하므로 의도적 trade-off.
- **fast-glob 미사용**: vendor table의 path-kind 3종(file/dir/mode-dir)이 닫혀 있어 일반 globber 불필요. 새 vendor가 더 풍부한 패턴 요구하면 `PathKind` 확장.
- **collision tiebreak**: 같은 vendor + 같은 path 시 first-occurrence가 wins. 현재 detector는 path를 한 번씩만 enumerate하므로 발생하지 않으나, host가 여러 detector 결과를 합치는 경우 가능.
- **mode-dir 파서 깊이**: 1-level만 walk. `.roo/rules-{mode}/sub/x.md`는 미지원.
