# quanta vs OpenHands — tool surface 정밀 어딧 · 대칭 비교

분석 소스: quanta = `/Users/songmin/quanta-codeagent-v3/src/tool/`,
OpenHands = `docs/analysis/scaffold-repro/openhands-loop/03-tools-dispatch.md`(→ `competitor-scaffolds/openhands-agent-sdk/`).

모든 quanta 주장은 file:line으로 고정한다. OpenHands 주장은 03-tools-dispatch.md가 이미 고정한 file:line을 재인용한다. 추측은 명시 표기한다.

---

## 0. 핵심 판정 (TL;DR)

두 축 판정:

- **reproduce-tool 구성(실행 bash / 편집 edit·apply_patch / 검색 grep·glob)** → **PARITY**. quanta는 이 3종을 `BASE_TOOL_NAMES`(gated-tools.ts:13-40)에 무-게이트로 박아 bench에서 `buildDefaultTools()`(driver.ts:2507)로 무조건 노출한다. OpenHands도 모든 preset에 무조건 포함(03 §1, default.py:52 / gpt5.py:47 / gemini.py:67). 설계 의도가 동일: "이 능력은 협상 불가". 갭 없음.
- **description 스타일** → **관찰된 갭(효과 미검증)**. OpenHands는 description을 (a) working_dir/vision 런타임 **동적 조립**하고(file_editor/definition.py:245-251), (b) 실행층이 리터럴 오용을 **런타임 교정**하며(terminal/definition.py:42), (c) description에 **few-shot(Scenario)**를 박는다(task_tracker 690단어, definition.py:270-400). quanta는 이 3개가 전부 **없다**: 모든 tool description이 정적 문자열 리터럴(170/188, §A2), 런타임 상태 주입 0건(§A3), few-shot 0건(§A4), bash 리터럴-교정 hint 부재(§A3). 방향성 갭은 실재하나 **점수 효과는 미측정**이고, 5바퀴 어딧 결론(description=능력이지 시점 아님; few-shot은 강모델 native-FC엔 미주입)과 정합시키면 **보수적으로 "영향 여지 낮음"**(§D).

---

## A. quanta tool surface 정밀 어딧

### A1. tool 인벤토리 (BASE 전수 + GATED 전수)

**BASE_TOOL_NAMES — 26종, 전부 무-게이트**(gated-tools.ts:13-40). 주석이 명시: "gate is implicitly `always` / default `on` everywhere"(gated-tools.ts:12).

```
read, write, edit, scripted_replace, apply_patch, bash, bash_await, bash_kill,
grep, glob, localize, file_tree_summary, parse_test_failure, test_runner,
diagnostics, read_image, read_image_url, web_fetch, csv_read, ndjson_read,
yaml_read, pdf_read, xlsx_read, docx_read, pptx_read, session_config
```

이 26종이 `buildBaseDefaultTools`(index.ts:851-923)에서 무조건 배열로 반환된다 — 조건분기 없음(포트 유무는 factory-vs-const 선택일 뿐 tool 존재 여부는 불변, 예: index.ts:852 `ports.fs ? makeReadTool(ports.fs) : readTool`). 드리프트 가드가 이를 핀한다: `buildDefaultTools()` (no ports) 정렬 === `BASE_TOOL_NAMES` 정렬(terminal-surface.test.ts:85-89).

**GATED_TOOLS — 50+ 엔트리, 전부 게이트 보유**(gated-tools.ts:43-851). 각 엔트리는 `{name, gate, default, risk}`. 게이트 종류 3분류(manifest 정의): `env-flag`(예: `git_status` QUANTA_GIT_TOOLS, gated-tools.ts:262), `config-slot`(예: `agent` subagent.enabled, :93), `resource`(예: `browser_snapshot` chrome-on-PATH, :189; `lsp_references` server-on-PATH, :304). risk 축: read-only / mutating / exec / network / meta / spawns-subagent(엔트리별 `risk:` 필드).

주요 GATED 대표(name / gate env / default / risk):
- `run_workflow`(QUANTA_WORKFLOW / {} 전-OFF / spawns-subagent, :46-51)
- `apply_patch_structured`(QUANTA_ENABLE_STRUCTURED_PATCH / cli:on / mutating, :77-88)
- `agent`+task_output+task_stop(QUANTA_SUBAGENT / cli:on / spawns-subagent, :90-98)
- `browser_snapshot`+13(chrome resource / cli·web:resource / exec, :171-194)
- `web_search`(BRAVE key resource / resource / network, :228-241)
- `git_status`+15(QUANTA_GIT_TOOLS / opt-in / mutating, :243-267)
- `lsp_references`+nav(server resource / cli:resource / read-only, :300-312)
- `code_cell`(QUANTA_CODE_MODE / opt-in / exec, :823-834)
- `ast_grep`(QUANTA_AST_GREP / opt-in / read-only, :836-842)
- `find_references`(QUANTA_BENCH_FIND_REFS / opt-in / read-only, :844-850)

**bench surface에서 실제 ON 되는 집합.** bench 드라이버는 manifest 게이트 해석을 **거치지 않는다**. `makeToolRegistry`류 경로가 아니라 driver.ts:2506-2512에서 직접 조립:

```
new ToolRegistry([
  ...buildDefaultTools(),          // = BASE 26종 (ports 없음 ⇒ GATED 0)
  ...lspNavTools,                  // opt.lspNav / opt.lspNavCheap 일 때만 (driver.ts:2496-2500)
  ...astGrepTools,                 // QUANTA_AST_GREP=on 일 때만 (driver.ts:2501)
  ...findRefsTools,                // QUANTA_BENCH_FIND_REFS=on 일 때만 (driver.ts:2502-2504)
  ...(benchVerifierTool),          // instance-bound test runner (driver.ts:2505)
])
```

즉 bench 기본 tool 메뉴 = **BASE 26종 고정** + (LSP-nav·ast_grep·find_refs·verifier) 노브별 추가. GATED 대부분(subagent/browser/git/gh/shadow/…)은 `buildDefaultTools()`에 포트를 안 넘기므로 bench에서 **부재**(index.ts:682~ 이후 모든 `if (ports.X !== undefined)` 분기가 거짓). 이는 gated-tools.ts의 default 정책(대부분 bench:"opt-in")과 정합.

### A2. description 스타일 정량

`src/tool` 서브트리 전수(테스트 제외), `description:` 필드 값의 시작 토큰 분류(perl 파싱, 188 매치):

| 스타일 | 건수 | 비율 |
|---|---|---|
| 정적 문자열 리터럴 (`"…"` / `'…'`, `+` 연결 포함) | 170 | ~90.4% |
| 템플릿 리터럴 (backtick `` ` ``) | 2 | ~1.1% |
| identifier/`spec.description` (플럼빙, tool 아님) | 16 | ~8.5% |

- 16건 identifier는 전부 **tool이 아니라 팩토리 배관**이다: `spec.description`(factory.ts:60, async-helper.ts:91), `t.description`(registry.ts:70), DAP exception의 `description` 필드(debug/inspect-driver.ts:388) 등. 실제 tool description 중 함수/런타임 조립은 **0건**.
- 2건 템플릿 리터럴도 **컴파일-타임 상수만 보간**한다: `lsp_nav/index.ts:246`은 tool 이름 파생(`${name.replace(...)}`), `browser/index.ts:252`은 정적 상수 배열(`${CDP_ALLOWED_METHODS.join(", ")}`). **런타임 상태(cwd/파일/세션) 주입 0**.

**description 길이(단어수) 실측 샘플** (직접 읽어 계수, base 도구):

| tool | file:line | 단어수(근사) | 스타일 |
|---|---|---|---|
| `grep` | grep/index.ts:89-93 | ~42 | 정적 리터럴 |
| `edit` | edit/index.ts:491-496 | ~55 | 정적 리터럴 |
| `bash` | bash/index.ts:632-643 | ~75 | 정적 리터럴 |
| `read` | read/index.ts:510-512 | ~18 | 정적 리터럴 |
| `apply_patch` | apply-patch.ts:608-609 | ~24 | 정적 리터럴 (1-라이너) |
| `glob` | glob/index.ts:56 | ~12 | 정적 리터럴 |
| `localize` | localize/index.ts:339 | ~8+ | 정적 리터럴 |

가장 긴 base 도구(bash)도 ~75단어로, OpenHands `task_tracker` 690단어(03 §4)나 file_editor 338단어(03 §3)의 1/5~1/9 수준. quanta description은 **압축된 능력+안티패턴 1문단**(예: bash "Do NOT use bash for cat/sed/awk…", edit "Do NOT use edit to create a new file"), OpenHands는 **절차서+few-shot**.

### A3. 동적 주입 유무 (working_dir / vision / cwd / 파일상태)

전수 grep 결과 **런타임 상태를 description·schema에 주입하는 지점 0건**:

- `working_dir` / "your current working directory" 를 description에 주입하는 곳 없음. 유일 매치 `ast-grep/index.ts:14`는 파라미터 기본값을 설명하는 **정적 영문 문구**("Default: current working directory")이지 실제 경로 보간이 아님. `pty/port.ts:24`는 포트 필드 주석.
- vision-조건부 description 조립 없음. `browser/index.ts:201` "returned as an image for vision"은 **정적 리터럴**(모델 vision 여부와 무관, 항상 동일 문자열).
- **OpenHands 대응물 부재**:
  - file_editor의 "Your current working directory is: {working_dir}"(03 §3, definition.py:245-251) → **quanta 무대응**.
  - terminal의 vision-조건부 이미지 view 줄 동적 삽입(03 §3, :232-239) → **quanta 무대응**.
  - terminal의 `_LITERAL_ARG_HINT_TEMPLATE` 런타임 교정(bash 자리에 Python dict 넣으면 실행 거부+"Write a script first with file_editor"를 is_error observation으로 되먹임, 03 §2.3, terminal/definition.py:42) → **quanta bash에 대응 hint 부재**(bash/index.ts에 "write a script"/"did you mean" 류 교정 없음).

`specs()`가 세션 부트스트랩 1회 계산되어 재사용됨(session-bootstrap.ts:198 `specs: cfg.registry.specs()`) — description은 **세션 내 정적**, 매 턴 재조립 없음.

### A4. few-shot in description

전수 grep: `Scenario` 0건, description 내 `Example`/`e.g.` few-shot 블록 0건. quanta의 안티패턴 문구(bash·edit의 "Do NOT …")는 **1문장 금지 규칙**이지 OpenHands task_tracker의 3-Scenario+2-Counter-example(03 §4, definition.py:307-368) 같은 완결 few-shot이 아니다. → **few-shot in description: 없음 확정**.

### A5. tool → LLM 전달 경로

정적·단일 파이프라인:

1. **정의**: 각 tool은 `{name, description(정적 리터럴), inputSchema(zod)}` (예: grep/index.ts:87-94).
2. **레지스트리 직렬화**: `ToolRegistry.specs()`가 `{name: t.name, description: t.description, input_schema: zodToJsonSchema(t.inputSchema)}`로 변환(registry.ts:67-72). zod→JSON schema는 `zodToJsonSchema`(schema.ts:122).
3. **부트스트랩 1회**: `specs()`는 세션 부트스트랩에서 계산되어 loop에 주입(session-bootstrap.ts:198). 매 턴 재계산 아님.
4. **provider 어댑터**: OpenAI 어댑터가 `input.tools.map(t => ({type:"function", function:{name, description, parameters: t.input_schema}}))`(openai.ts:399-402). description은 여기서 **가공 없이 그대로** 전달.

즉 quanta의 "행동 사양"은 description 문자열이 **작성 시점에 고정**되고 파이프라인은 순수 전달자다. OpenHands는 3번 위치(instance 생성)에서 conv_state 기반 조립이 일어난다(03 §3).

### A6. reproduce 3종이 bench에 무조건인지 확정 (코드)

- **실행 bash**: `bash`는 BASE(gated-tools.ts:18), `buildBaseDefaultTools`에서 `makeBashTool(...)` 무조건 push(index.ts:868-870). 게이트 없음.
- **편집 edit / apply_patch**: `edit`(gated-tools.ts:16, index.ts:854), `apply_patch`(gated-tools.ts:17, index.ts:863) 둘 다 BASE 무조건. (`apply_patch_structured`만 게이트, :77-88 — 그러나 원본 `apply_patch`는 무조건.)
- **검색 grep / glob**: `grep`(gated-tools.ts:22, index.ts:878), `glob`(gated-tools.ts:23, index.ts:879) BASE 무조건.
- bench 드라이버가 `buildDefaultTools()`를 무조건 spread(driver.ts:2507)하므로 위 5개는 bench에서 **항상 ON**. 드리프트 가드(terminal-surface.test.ts:85-89)가 base 집합 불변을 강제.

**확정**: reproduce 3종은 BASE라 gate 없음, bench 무조건 노출.

---

## B. OpenHands 대비 — 축별 대칭표

| 축 | quanta (file:line) | OpenHands (03-tools-dispatch.md 재인용) | 판정 |
|---|---|---|---|
| **tool 수(기본 노출)** | bench = BASE 26종 고정 + 노브별 4(lsp/ast/refs/verifier) (driver.ts:2506-2512) | preset별 ~16 function(default 3+builtins, gemini는 browser fanout 합 ~16) (03 §1 preset표) | quanta가 **더 많은 상시 tool**. parity 아님(quanta 우위, but 능력 중복 다수) |
| **description 길이** | base 최대 ~75단어(bash), 다수 8~55 (§A2) | file_editor 338 / task_tracker 690 (03 §4,§6) | **갭**: OpenHands가 3~10배 장문 |
| **description 스타일** | 정적 리터럴 90%, 나머지 컴파일-상수 보간 (§A2) | 정적+동적 조립+few-shot 혼합 (03 §3,§4) | **갭**: quanta 정적-only |
| **동적 주입(cwd/vision)** | 0건 (§A3) | file_editor working_dir 주입, terminal vision 삽입 (03 §3) | **갭**: quanta 무대응 |
| **런타임 교정 hint** | bash 리터럴-교정 부재 (§A3) | terminal literal-arg → "write a script" 되먹임 (03 §2.3) | **갭**: quanta 무대응 |
| **few-shot in desc** | 0건 (§A4) | task_tracker 3-Scenario+2-Counter (03 §4) | **갭**: quanta 무대응 |
| **reproduce-tool 구성** | bash+edit/apply_patch+grep/glob = BASE 무조건 (§A6) | 모든 preset 무조건 (03 §1) | **PARITY** |
| **전달 경로** | 정의→registry.specs()→adapter, 부트스트랩 1회 정적 (§A5) | definition.py→to_openai_tool→conv_state 동적조립→LLM (03 §5) | quanta 정적 / OpenHands 동적. 능력 노출 자체는 동형 |

---

## C. 다이어그램

### (1) "tool → LLM 도구정의" 파이프라인 나란히

```
 quanta                                        OpenHands
 ───────────────────────────────────────       ─────────────────────────────────────────────
 gated-tools.ts                                 <tool>/definition.py
   BASE_TOOL_NAMES[26]  (무-게이트)               register_tool(...)  전역 레지스트리 자동등록
   GATED_TOOLS[50+]     (env/slot/resource)        (03 §5, registry.py:113-147)
         │                                              │
         ▼                                              ▼
 buildDefaultTools(ports)                        preset(default/gpt5/gemini) 가 Tool spec 나열
   = buildBaseDefaultTools + if(port)++           (default.py:52 / gpt5.py:47 / gemini.py:67)
   (index.ts:677-923)                                   │
         │  [bench: driver.ts:2507                       ▼
         │   ports 없음 ⇒ BASE 26 고정]           resolve_tool(spec, conv_state)   ← conv_state!
         ▼                                          동적 인스턴스화 (registry.py:149-158)
 ToolRegistry.specs()                                   │  working_dir / vision / literal-hint
   {name, description(정적리터럴),                       ▼  런타임 주입 (definition.py:245-251)
    input_schema: zodToJsonSchema(inputSchema)}    to_openai_tool / to_responses_tool
   (registry.ts:67-72)                              {name, description(동적조립), parameters}
         │  세션 부트스트랩 1회                       (sdk/tool/tool.py:465-525)
         │  (session-bootstrap.ts:198)                    │
         ▼                                                ▼
 adapter: openai.ts:399-402                        LLM function-calling schema
   {type:function, function:{name,description,
    parameters: input_schema}}   ← 무가공 전달
         │
         ▼
 LLM function-calling schema
```

핵심 차이: quanta는 **작성-시점 고정 description**을 무가공 전달(부트스트랩 1회). OpenHands는 **resolve_tool(conv_state) 단계에서 런타임 상태를 description에 주입**한 뒤 직렬화.

### (2) description 스타일 대비 (실제 발췌)

```
 quanta — 정적 1문단, 안티패턴 금지규칙 (능력 서술)
 ───────────────────────────────────────────────────────────
 bash (bash/index.ts:632-643):
   "Run a shell command (bash). Returns combined stdout/stderr and exit
    code. Non-zero exit is reported, not thrown. Prefer `read`, `grep`,
    and `edit` … use bash ONLY when the task finishes in a single shell
    command … Do NOT use bash for cat/sed/awk over files …"
   → ~75단어, 정적 리터럴, few-shot 없음, cwd 없음

 edit (edit/index.ts:491-496):
   "Exact string replacement in an existing file. old_string must match
    verbatim. Do NOT use edit to create a new file — use `write` instead.
    Do NOT use edit when old_string is not unique …"
   → ~55단어, 정적 리터럴, 금지규칙 2개

 OpenHands — 절차서 + working_dir 동적주입 + few-shot
 ───────────────────────────────────────────────────────────
 file_editor (definition.py:160-190, +245-251 동적):
   "Before using this tool: 1. Use the view tool … 2. Verify the directory
    path is correct … EXACT MATCHING: old_str must match EXACTLY …
    UNIQUENESS: include 3-5 lines context …"
   + 런타임 삽입: "Your current working directory is: {working_dir} …"
   → ~338단어, 절차서, working_dir 주입 (03 §3)

 task_tracker (definition.py:270-400):
   "When to use / When NOT to use … Scenario 1: …  Scenario 2: …
    Counter-example: …  Never mark done when: Test suites are failing …"
   → ~690단어, 완결 정책 + 3 Scenario few-shot (03 §4)
```

---

## D. 판정 — 갭 vs parity, 크기, 효과 검증 여부

### 축 1 — reproduce-tool 구성 → **PARITY (갭 아님)**

quanta는 bash·edit/apply_patch·grep/glob을 BASE 무-게이트로 bench 무조건 노출(§A6, driver.ts:2507, gated-tools.ts:16-23), 드리프트 가드로 불변 핀(terminal-surface.test.ts:85-89). OpenHands도 전 preset 무조건(03 §1). 설계 의도 동일("협상 불가"). 오히려 quanta는 BASE 26종으로 상시 tool 수가 더 많다(read/glob/localize/test_runner/문서리더 등) — reproduce 최소셋 관점에선 **부족이 아니라 초과**. 이 축에서 추가 측정 불요.

### 축 2 — description 스타일 → **관찰된 방향성 갭, 효과 미검증 → 측정 필요(보수적 저-영향)**

관찰된 갭 3개(전부 §A3-A4로 quanta 부재 확정):
1. **동적 주입 부재**: quanta description·schema에 working_dir/vision 런타임 주입 0건. OpenHands는 file_editor에 cwd 주입(03 §3).
2. **런타임 교정 부재**: quanta bash에 리터럴-오용 되먹임 hint 없음. OpenHands terminal은 있음(03 §2.3).
3. **few-shot 부재**: quanta description에 Scenario/Example 0건. OpenHands task_tracker 690단어 few-shot(03 §4).

**갭 크기**: description 물리량으로는 크다(OpenHands file_editor 338 / task_tracker 690 vs quanta base 최대 75단어). 그러나 이는 **길이 차이**이지 능력 차이가 아니다.

**효과 검증 여부**: **미측정.** 이 3개 갭이 bench 점수에 영향 준다는 A/B 근거는 본 어딧 범위에 없다.

**5바퀴 어딧 결론과의 정합(보수적 평가)**:
- "description = 능력이지 시점 아님" — reproduce **능력**(bash/edit/grep)은 quanta에 이미 100% 존재(§A6). 갭은 능력이 아니라 **행동-유도 문구의 밀도/시점성**에 국한. 능력 동등이면 점수 하한은 이미 확보.
- "few-shot은 강모델 native-FC엔 미주입" — quanta bench는 강모델(gpt-5.x) native function-calling. task_tracker류 690단어 few-shot을 description에 넣는 것은 강모델에선 토큰 비용 대비 한계효용이 낮다는 것이 5바퀴 결론. 즉 few-shot 부재를 **의도적 설계**로 볼 여지가 크고, 갭이라 해도 강모델 조건에선 **영향 여지 낮음**.
- 동적 cwd 주입/런타임 교정은 "약모델이 bash 자리에 dict를 넣는" 실패를 tool층이 교정하는 장치(03 §2.3)인데, 강모델에선 그 실패율 자체가 낮아 교정 hint의 marginal 가치가 작을 개연 — **단, 미측정**.

**최종(처방 아님, 관찰+측정필요만)**:
- 축 1(reproduce 구성): **parity 확정, 조치·측정 불요**.
- 축 2(description 스타일): **방향성 갭 실재하나 능력 갭 아님**. 강모델 native-FC 조건 + 능력 동등을 감안하면 **점수 영향 여지는 보수적으로 낮음**. 영향 유무를 주장하려면 (a) working_dir 주입 on/off, (b) bash 리터럴-교정 hint on/off, (c) 편집 도구 description 장문화 on/off 각각을 default-OFF knob로 심고 bench A/B로 **측정 후에만** 결론. 현 시점 근거로는 갭을 점수 원인으로 귀속 불가.
