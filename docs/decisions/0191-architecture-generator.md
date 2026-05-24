# ADR-0191: Architecture generator — `tools/arch-gen` walks ADRs + slices + emits `ARCHITECTURE.generated.md`

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**: ADR-0001 (slice isolation — defines the planes this doc enumerates; the generator reads `biome.json` indirectly via the slice tree it discovers), ADR-0187 (this round's sibling — health-snapshot watcher; same "construct the artifact, then keep refreshing it" pattern applied to a different domain)
- **참조**: `tools/arch-gen/scan-adrs.ts`, `tools/arch-gen/scan-slices.ts`, `tools/arch-gen/render.ts`, `tools/arch-gen/main.ts`, `tests/unit/arch-gen-hellgate.test.ts`, `docs/ARCHITECTURE.generated.md`

## 맥락

Audit-D round (2026-05-25)가 `docs/ARCHITECTURE.md` 가 ~5주 뒤처졌다고 보고했다. ADR-0099부터 0190까지 **약 90개**의 ADR이 들어오는 동안 손-편집 ARCHITECTURE.md는 ADR-0098 시점에서 freeze된 채 ports / adapters / planes를 빠뜨렸다. 손 편집은 1-2 주 안에 다시 썩는다(*bit-rot is a first-class hazard*). 사람이 들춰보지 않는 문서를 누가 갱신하나? 누가 갱신해도 다음 ADR이 또 누락된다.

3가지 해결 패턴이 있다:

1. **수기 갱신만 강요** — 현재. 실측: 5주 drift.
2. **AST-기반 풀 도큐 사이트** — TSDoc / `typedoc` / `dependency-cruiser`. heavy: `@/agent` 한 슬라이스만 처리해도 노드 그래프가 수천 개, 사람이 못 본다. CI 시간 + 의존성 추가.
3. **regex 기반 mini-generator** — ADR 헤더 + `index.ts` barrel + 첫 doc-comment만 읽고 markdown 한 장으로 emit. 사람이 그대로 PR review에 올릴 수 있는 길이.

**핵심 인사이트**: ADR 헤더와 barrel `index.ts` 의 첫 doc-comment는 quanta가 이미 합의한 두 *signals of intent*다 — ADR template은 ADR-0001~0189에서 stable, barrel doc-comment는 `agent`/`memory`/`mcp` 등 새 슬라이스마다 자발적으로 작성됨. 두 신호를 합치면 architecture summary가 된다는 게 본 ADR의 주장. heavyweight AST 없이도.

## Research grounding

- **Codex 0.131** `codex-rs/cli/src/lib.rs` — `codex render --help` 의 출력은 hand-curated이지만 **subcommand 발견은 자동** (`clap::Subcommand` 도출). Generator 패턴: 코드가 신뢰할 수 있는 곳에서만 발견하고, 사람은 위에 narrative만 얹는다.
- **Cursor 3.2 `cursor-localization.md` §17 — handshake drift defense**: 모든 client-side refresh는 *event*가 아니라 *handshake* (서버가 ground truth verdict). 본 ADR도 같은 사상: `bun tools/arch-gen/main.ts` 호출이 한 번의 handshake — caller가 호출했을 때만 ground truth(`docs/decisions/`, `src/**/index.ts`)와 비교해서 새 artifact emit.
- **`dependency-cruiser`** — node ecosystem의 SOTA dep-graph. 검토했으나 거부 (아래 §Alternatives #1).
- **memory `agent-loop-4way-comparison.md`** 확인 — 어느 경쟁사도 *generated* architecture doc 패턴을 안 가진다. 모두 손편집 ARCH.md + 별도 docsite. quanta는 "doc rot은 일급 위험" 인식을 ADR-0187(드리프트 방지)에서 보였고, 본 ADR이 그 사상을 doc-domain으로 확장.

## 결정

`tools/arch-gen/` 4-part. 모두 `node:fs/promises` + `node:path`만 의존, **`@/*` 슬라이스 0 import** (plane-clean).

### Part 1 — `scan-adrs.ts`

`docs/decisions/*.md` 를 walk:

- `# ADR-NNNN: <title>` 헤더 정규식 추출
- `- **상태**:` / `- **Status**:` (Korean + English 둘 다 지원)
- `- **날짜**:` / `- **Date**:`
- `- **관련**:` / `- **Related**:` 라인에서 `ADR-NNNN` 시퀀스 추출 (dedupe + zero-pad)
- 첫 `- **참조**:` 라인에서 backtick-wrapped `src/...` / `tests/...` paths 수집
- Plane은 explicit `**plane**:` 라인 우선, 없으면 title keyword heuristic (security → observability → infrastructure → application → domain 우선순위)

Malformed ADR (헤더 매치 실패) → `skipped[]` 에 reason과 함께 기록, scanner는 계속.

### Part 2 — `scan-slices.ts`

`src/<slice>/index.ts` 마다:

- 첫 doc-comment (`/** */` OR `//`-line block) → purpose (single-paragraph, 240 chars cap)
- `export { } from "./..."` / `export const|function|class|...` / `export * as ns from "./..."` → publicExports (sorted unique)
- 첫 2000자 헤더 zone에서 `ADR-NNNN` 추출 → adrReferences
- `tests/unit/<slice>-*hellgate.test.ts` 매치 → testFile

`apps/`처럼 barrel 없는 슬라이스는 silently skip (의도된 composition root).

### Part 3 — `render.ts`

순수 함수, `(adrs, slices, { today, hellgateCount, distinctAdrCount }) => markdown`. Byte-deterministic: 모든 list/group은 stable sort.

Sections:
- **Slices** (per-slice block: heading + purpose blockquote + public surface + hellgate ref)
- **ADR catalogue by plane** (5 planes + uncategorized; each ADR rendered as link to `./decisions/<filename>`)
- **ADR Timeline** (date desc, 그 안에서 number asc)
- **Dependency Graph** (text-art, hand-fixed canonical layout)
- **Catalog parity** (총 ADR / distinct number / collision count / 총 slice / hellgate count)

### Part 4 — `main.ts`

CLI: `bun tools/arch-gen/main.ts [--output docs/ARCHITECTURE.generated.md] [--docs ...] [--src ...] [--tests ...] [--today YYYY-MM-DD]`.

Default output: `docs/ARCHITECTURE.generated.md` (hand-curated `docs/ARCHITECTURE.md` 미변경). `--today` flag로 테스트가 deterministic하게 stamping 가능.

## Default-OFF

- `docs/ARCHITECTURE.md` (hand-curated) 미변경 — bit-identical로 보존. Generator는 *parallel artifact*를 emit한다 (`.generated.md`). 운영자가 둘 중 하나를 골라 PR에 첨부.
- 어떤 hook도 자동 트리거 안 함 — CLI manual invocation만. `pre-commit` 자동 재생성은 §Follow-up.
- Caller-injected `--today` 없으면 UTC date stamping (테스트는 `--today` 지정).

## Hellgate

`tests/unit/arch-gen-hellgate.test.ts` — **19 case**:

| # | scope | case |
|---|---|---|
| A-1 | scanAdrs | single ADR → number/title/date/status 정확 |
| A-2 | scanAdrs | related ADR 추출 + dedupe + zero-pad |
| A-3 | scanAdrs | Accepted / Proposed / Superseded status 인식 |
| A-4 | scanAdrs | Korean `**날짜**` AND English `**Date**` 둘 다 |
| A-5 | scanAdrs | malformed → skipped[] 기록, crash 없음, scanner 계속 |
| B-6 | scanSlices | purpose + exports + ADR refs 정확 추출 |
| B-7 | scanSlices | doc-comment 없으면 `(no description)` |
| B-8 | scanSlices | `<slice>-*hellgate.test.ts` 매칭 |
| B-9 | scanSlices | `index.ts` 없는 슬라이스 silently skip |
| B-10 | scanSlices | multi-export barrel (named / type / const / function / class / `* as ns`) 모두 캡처 |
| C-11 | render | empty inputs → minimal template (header + 0-count footer) |
| C-12 | render | plane 내 ADR sort by number asc |
| C-13 | render | "metric" 키워드 title → observability 클러스터 |
| C-14 | render | ADR 헤딩이 `./decisions/<filename>` 링크로 |
| C-15 | render | footer에 total / distinct / collision / slice 카운트 |
| D-16 | main | parseArgs `--output` / `--today` / `--docs` / `--src` / `--tests` |
| D-17 | main | runGenerator 실제 write + body 검증 (tmpdir hermetic) |
| E-18 | helpers | `//`-line-only block 도 purpose로 인식 |
| E-19 | helpers | extractAdrReferences sort unique |

## Alternatives rejected

1. **`dependency-cruiser` + TSDoc 풀 도큐사이트** — 거부. Runtime 의존성 추가 (`dependency-cruiser` + `typedoc` + `react-static` 류 어딘가); CI 시간 +30s 이상; 사람이 안 본다 (현재 ARCHITECTURE.md도 5주 안 봤는데 풀 사이트 만들어 봐야 같은 결말). RFC §2 "단일 도구" 원칙 위반.
2. **AST 파스** (TypeScript Compiler API) — 거부. `index.ts` 의 export 목록만 필요하면 regex로 충분. AST는 `import` 그래프나 `type` 추론을 포함하는 *over-spec*. SOTA matrix(아래)에서 Cursor 17.2 — 자체 도구도 file-level signal로 시작하고 graph는 별 도구로 분리.
3. **Pre-commit hook 자동 재생성** — 거부 (이번엔). hook이 doc/decisions 변경마다 발화하면 ADR PR마다 generated.md 변경 diff 추가 → review noise. CLI manual + CI staleness gate가 더 가벼움. §Follow-up.
4. **단일 자동-run 모드 (no CLI)** — 거부. Generator는 *exact moment*에 emit해야 (e.g. ADR 머지 후) — agent autonomy / scheduled job 따로. CLI는 hook / cron / manual 셋 다 지원.
5. **JSON output 추가** — 거부. 사람이 PR에서 봐야 하는 게 핵심 가치. Machine-readable이 필요해지면 §Follow-up에서 `--format json`.
6. **hand-curated `ARCHITECTURE.md` 폐기 + generated만 유지** — 거부. Hand-curated는 *narrative* (왜 / 트레이드오프 / 운영 가이드)를 담는다 — generator는 그걸 못 만든다. 둘은 다른 청중 / 다른 목적. ADR-0187 patterns이 정확히 이걸 강제 (file 두 개를 의도적으로 분리).

## SOTA matrix

| Agent | architecture doc | generation 모델 | drift 방어 |
|---|---|---|---|
| Claude Desktop 1.7196 | 손편집만 (publish 없음) | n/a | n/a |
| Cursor 3.2.16 | 손편집 + 일부 inline docsite | hand-curated | handshake-based for client state, n/a for arch docs |
| Codex Desktop 0.131 | 손편집 `AGENTS.md` | hand-curated | n/a |
| **quanta (이 ADR)** | **hand-curated + generated parallel** | **CLI handshake (regex barrel + ADR header walk)** | **CLI re-run; CI gate (Follow-up); pre-commit hook (Follow-up)** |

= "lightweight regex generator + 사람이 검토할 길이의 single-file output + manual handshake. 본 ADR이 그 첫 single-process agent artifact를 확인."

## Follow-up (이 ADR이 닫지 않는 것)

- **CI staleness gate** — PR 시 generator 다시 돌려서 `git diff --exit-code docs/ARCHITECTURE.generated.md` 가 nonzero면 fail. 본 ADR은 CLI만, gate는 별 ADR (deferred until generator가 hot path에서 안정화된 뒤).
- **pre-commit hook** — `docs/decisions/` 또는 `src/**/index.ts` 변경 시 자동 재생성. ADR-0187처럼 *opt-in* 으로. 본 ADR이 plumbing만 깔고 트리거는 별 ADR.
- **per-plane dependency graph SVG** — `graphviz` / `mermaid` 로 ASCII 대신 svg/png. 사람이 보기 좋지만 binary asset PR에 노이즈. `--format dot` 옵션이 가벼운 첫 step.
- **port catalog 정밀화** — 본 ADR은 `index.ts` exports만 본다 (이름 ✓, shape ✗). `ports.ts` 파일이 있는 슬라이스(`src/llm/ports.ts`, `src/memory/ports.ts`)에서 `interface ...Port` 선언을 직접 추출하면 ports/adapters 표가 자동화됨. AST는 안 쓰고 regex로도 충분히 추출 가능 — Phase 2.
- **JSON output (`--format json`)** — 다른 도구(`tools/feature-catalog`)와 결합 시 필요. 본 ADR은 markdown만.
- **collision 경고 raise** — 현재 같은 ADR number 2건이 있어도 둘 다 render. CI gate가 들어오면 `--strict` flag로 collision detection을 error로 끌어올림.

## 트레이드오프

- **얻은 것**: 5주 drift → CLI 1회로 갱신. Generator는 ~600 LOC (4 file + test). 의존성 0개 추가. hand-curated 보존. plane-clean (`@/*` import 0). Korean+English ADR header 둘 다 지원해 legacy 안 깸. 19 hellgate가 핵심 invariant 봉인.
- **잃은 것 / 비용**: regex는 AST보다 fragile (특히 multi-line `export { ... } from "..."` block은 캡처되나 weird formatting은 miss 가능 — 모든 quanta barrel은 prettier로 통일돼있어 실측 안전). Plane heuristic은 title keyword에 의존 → 새로운 keyword 카테고리 들어오면 uncategorized로 떨어짐 (안전한 fallback이지만 review necessary). hand-curated `ARCHITECTURE.md` 와의 narrative gap은 사람이 메워야 함 — generator는 "facts"만, narrative는 hand.
