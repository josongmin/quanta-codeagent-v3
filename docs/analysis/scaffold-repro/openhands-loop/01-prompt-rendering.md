# OpenHands agent-sdk — 프롬프트 렌더링 파이프라인 (코드 레벨)

분석 소스: `/Users/songmin/Documents/code-new/competitor-scaffolds/openhands-agent-sdk/`
모든 file:line은 그 트리 기준. 모든 주장은 실제 Read/Grep으로 확인. 추측 없음.

---

## 0. 핵심 판정 (요약)

"OpenHands는 그냥 프롬프트다"는 **부분적으로만 맞다**. 최종 system message의 *텍스트 바디*는 거의 정적인 장문 한 장(블록 ~17개)이지만, 그게 만들어지기까지의 파이프라인은 **동적 합성물**이다. 근거:

- **두 개의 병렬 렌더 엔진**이 존재한다. (a) Jinja2 템플릿 (`system_prompt.j2`), (b) 타입드 section registry (`create_registry()` + 순수 Python 섹션). 같은 출력을 byte-for-byte 재현하도록 둘이 미러링되어 있고, default 경로는 (b)가, escape-hatch는 (a)가 탄다 (`base.py:483-494`).
- system message는 **두 개의 content block** (static / dynamic) 으로 쪼개진다. static은 cross-conversation prompt-cache 대상, dynamic은 per-conversation (`system.py:12-42`, `base.py:434-453`).
- static 블록 안에서 **조건부 include / guard가 최소 6곳** (security policy, security risk assessment, browser, model_family, model_variant, SOUL override). dynamic 블록은 **5개 섹션** 전부 guard로 켜고 끈다.
- 주입 변수 출처가 **5개 서로 다른 소스**: SOUL.md 파일(`~/.openhands/SOUL.md`), LLM 모델명 휴리스틱(family/variant), 바인딩된 tool 목록(`enable_browser`), AgentContext(skills/suffix/datetime), conversation secret registry.

즉 바디 텍스트는 정적이지만, **어떤 블록이 들어가고 어떤 model_specific 가이드가 붙는지는 런타임 입력에 따라 분기**한다. "정적 텍스트 한 장"이 아니라 "정적 블록들의 guard-기반 조건부 조립 + per-conversation dynamic 합성"이다.

---

## 1. 전체 경로: system_prompt.j2 → 최종 system message

### 1.1 진입점과 두 갈래

`AgentBase.static_system_message` (`base.py:458-494`) 가 static 블록을 만든다. 세 갈래:

```
static_system_message  (base.py:459)
│
├─ self.system_prompt is not None  ──► 그 문자열 verbatim 반환          (base.py:476-477)
│      (inline override; system_prompt_filename과 상호배타, base.py:263-283)
│
├─ ESCAPE HATCH (아래 셋 중 하나라도 참)                                (base.py:483-487)
│      • system_prompt_filename != "system_prompt.j2"
│      • realpath(prompt_dir) != _BUILTIN_PROMPT_DIR   (서브클래스가 자기 prompts/ 가짐)
│      • security_policy_filename != "security_policy.j2"
│   └─► render_template(prompt_dir, system_prompt_filename, **_resolved_template_kwargs())
│                                                                      (base.py:488-492)  ← Jinja 경로
│
└─ DEFAULT  ──► create_registry().build(self._build_prompt_context()).static
                                                                       (base.py:494)      ← 타입드 registry 경로
```

`prompt_dir` (`base.py:444-451`) 은 "이 클래스 모듈 파일이 있는 디렉터리 / prompts". 즉 서브클래스가 자기 `prompts/system_prompt.j2`를 두면 escape-hatch로 빠져 Jinja를 탄다. `_BUILTIN_PROMPT_DIR` (`base.py:114-116`) = sdk/agent/prompts 의 realpath.

### 1.2 Jinja 경로 (escape-hatch) — render_template 실제 구현

`context/prompts/prompt.py`:

- **Loader**: `FlexibleFileSystemLoader` (`prompt.py:16-45`). 상대경로면 searchpath 기준, 절대경로면 그대로. `{% include %}`도 이 loader로 해석되므로 `model_specific/anthropic_claude.j2` 같은 상대 include가 prompt_dir 기준으로 풀린다.
- **Environment**: `_get_env` (`prompt.py:57-74`). `@lru_cache(maxsize=64)` 로 prompt_dir별 env 캐시. 설정:
  - `autoescape=False` (`prompt.py:70`) — HTML escape 안 함. 프롬프트 텍스트라 당연.
  - `bytecode_cache = FileSystemBytecodeCache(~/.openhands/cache/jinja)` (`prompt.py:64-69`) — 컴파일된 템플릿 bytecode를 디스크 캐시(프로세스 간 재파싱 회피).
  - **undefined 처리**: 명시 설정 없음 → Jinja 기본 `Undefined` (정의 안 된 변수는 빈 문자열로 렌더, 에러 안 남). 그래서 `{% if enable_browser is defined %}` 같은 방어가 템플릿에 들어가 있음 (`system_prompt.j2:93`).
  - `env.filters["refine"]` 등록 (`prompt.py:73`).
- **Template 캐시**: `_get_template` (`prompt.py:77-85`), `@lru_cache(maxsize=256)`.
- **render_template** (`prompt.py:88-114`): 절대경로면 dir/filename 분해, 아니면 prompt_dir 기준. 최종적으로 `refine(tpl.render(**ctx).strip())` 반환.
- **refine** (`prompt.py:48-54`): **Windows에서만** 텍스트 post-process — `terminal`→`execute_powershell`, `bash`→`powershell` 정규식 치환. 즉 같은 템플릿이 OS별로 다른 바이트를 낸다 (정적 아님의 한 증거).

### 1.3 타입드 registry 경로 (default) — Jinja 없이 Python 조립

`context/prompts/registry.py` + `presets.py` + `sections/{static,dynamic}.py`.

- `create_registry()` (`presets.py:44-71`): 22개 섹션을 **system_prompt.j2가 내보내는 순서 그대로** 등록. 주석에 "ported verbatim from system_prompt.j2 (#3610)" 명시 (`presets.py:46`).
- `PromptRegistry.build(ctx)` (`registry.py:45-64`): 각 섹션에 대해 `guard(ctx)` 통과한 것만 `render(ctx)` → strip → 빈 거 버림 → `cache_tier`별 버킷(STATIC/DYNAMIC)에 모음 → `"\n\n".join` (`registry.py:23,62-63`). 결과는 `PromptBlocks(static: str, dynamic: str|None)` (`section.py:132-142`).
- 각 섹션은 `_StaticTextSection` 서브클래스 (`sections/static.py:60-75`)로, 대부분 `body` 상수 텍스트를 그대로 반환. **즉 default 경로는 Jinja를 전혀 안 타고**, Python 문자열 상수들을 guard로 골라 `\n\n`로 잇는다.

이 이중화는 의도적이다: `test_default_registry.py`가 두 경로 출력을 "Phase 0 snapshot oracle" 대비 byte-for-byte 핀 (`sections/static.py:4-6`). registry는 prompt-cache 친화적 static/dynamic 분리를 위한 재구현이고, Jinja는 커스터마이즈 escape-hatch로 잔존.

---

## 2. 주입되는 변수 전부 — 출처 추적

static 경로 kwargs는 `_resolved_template_kwargs()` (`base.py:496-525`)가 만든다. 이게 Jinja(`render_template(**...)`) 와 registry(`PromptContext.template_kwargs`) 양쪽에 동일하게 들어가 drift 방지 (`base.py:499-501`).

| 변수 | 출처 (file:line) | 설명 |
|---|---|---|
| `soul_content` | `_load_soul_md()` ← `~/.openhands/SOUL.md` 파일, 없으면 `_DEFAULT_SOUL` (`base.py:505-506`, `:106-130`) | **SOUL = 에이전트 정체성 파일.** 파일 있으면 그 내용이 `<SOUL>` 안에 들어가 default identity를 대체. 기본값은 `"You are OpenHands agent, a helpful AI assistant..."` (`base.py:107-110`). `system_prompt_kwargs`에 이미 있으면 안 덮음. |
| `enable_browser` | 바인딩된 tool 중 `name == "browser_tool_set"` 존재 여부 (`base.py:508-511`) | tool 목록에서 파생. `<BROWSER_TOOLS>` 블록 on/off. setdefault라 kwargs로 강제 가능. |
| `security_policy_filename` | `self.security_policy_filename` 필드 (default `"security_policy.j2"`, 빈 문자열이면 disable) (`base.py:512`, `:247-256`, `:268-272`) | `<SECURITY>` 안에 `{% include %}`될 파일명. |
| `model_name` | `self.llm.model` (`base.py:513`) | setdefault. |
| `model_family` | `get_model_prompt_spec(llm.model, model_canonical_name).family` (`base.py:514-522`) | **모델명 substring 휴리스틱** (§3). kwargs에 이미 있으면 건드리지 않음. |
| `model_variant` | 같은 spec의 `.variant` (`base.py:523-524`) | 위와 동일. |
| `llm_security_analyzer` | `system_prompt_kwargs`에 validator가 **항상 True 시드** (`base.py:339-348` in agent.py) | `_normalize_kwargs`류 validator가 setdefault로 강제 → `<SECURITY_RISK_ASSESSMENT>` 항상 켜짐 (단, registry 쪽 guard는 `template_kwargs["llm_security_analyzer"]` 본다, `sections/static.py:287-288`). |
| `cli_mode` | `system_prompt_kwargs`로 외부 주입 (default 없음; 예시 `{"cli_mode": True}`, `base.py:260`) | security risk assessment 티어를 CLI/SANDBOX로 스왑 (`sections/static.py:290-294`). registry default는 True (`:293`). |

dynamic 블록 변수는 `_build_prompt_context()` (`base.py:527-592`)가 `AgentContext._resolve_dynamic_data()`를 호출해 채운다 (§6):

| dynamic 변수 | 출처 |
|---|---|
| `now` (datetime) | `AgentContext.get_formatted_datetime()` ← `data.formatted_datetime` (`base.py:567`, `agent_context.py:388-392`) |
| `repo_skills` | model-family로 gated된 legacy `trigger=None` skill의 (name, content) (`base.py:569`, `agent_context.py:349-368`) |
| `available_skills_prompt` | AgentSkills-format/triggered skill의 progressive-disclosure 목록 (`base.py:570`, `agent_context.py:372-374`) |
| `custom_suffix` | `agent_context.system_message_suffix` (`base.py:571`) |
| `secret_infos` | agent_context secrets + conversation `secret_registry` 머지 (`base.py:572-578`, `agent_context.py:379-386`) — 이름만 노출, 값은 안 들어감 |

---

## 3. model_specific 분기 — family/variant 선택 메커니즘

### 3.1 family/variant 결정 — `get_model_prompt_spec`

`llm/utils/model_prompt_spec.py`:

- **family**: 모델명을 lower-case 정규화 후 substring 매칭 (`:58-66`). 패턴 (`:21-34`):
  - `openai_gpt` ← `gpt-`, `o1`, `o3`, `o4`
  - `anthropic_claude` ← `claude`
  - `google_gemini` ← `gemini`
  - 그 외 meta_llama / mistral / deepseek / alibaba_qwen
- **variant**: family가 잡힌 뒤에만, 그 family의 ordered 패턴으로 매칭 (`:69-87`). 현재 `openai_gpt`만 variant 가짐 (`:37-51`):
  - `gpt-5-codex` ← `gpt-5-codex`, `gpt-5.1-codex` … (더 구체적인 게 우선)
  - `gpt-5` ← `gpt-5`, `gpt-5.1`, `gpt-5.4`, `gpt-5.5`
- canonical_name 우선, 없으면 model_name (`:79`).

순수 substring 휴리스틱 — **answer-key 아니고 vendor 라우팅용**. (우리 메모리의 no-answer-key 관점에서: 이건 모델별 가이드 선택일 뿐 정답 키워드 매칭 아님.)

### 3.2 Jinja 경로의 조건부 include

`system_prompt.j2:137-152`:

```jinja
{%- set _imp -%}
{%- if model_family -%}
{%- include "model_specific/" ~ model_family ~ ".j2" ignore missing -%}
{%- if model_variant -%}
{%- include "model_specific/" ~ model_family ~ "/" ~ model_variant ~ ".j2" ignore missing -%}
{%- endif -%}
{%- endif -%}
{%- endset -%}
{%- if _imp | trim %}<IMPORTANT>{{ _imp_trimmed }}</IMPORTANT>{%- endif %}
```

즉 **family 파일 + (있으면) variant 파일을 이어붙여** `<IMPORTANT>` 블록 생성. `ignore missing`이라 파일 없으면 조용히 스킵. 실제 파일:
- `model_specific/anthropic_claude.j2` (`base.py` 인접) — "instructions 정확히 따르라 / 방어적 프로그래밍 피하라 / 하위호환 불확실하면 confirm" (3줄).
- `model_specific/google_gemini.j2`, `openai_gpt/gpt-5.j2`, `openai_gpt/gpt-5-codex.j2`.
- gpt-5는 family 파일(`openai_gpt.j2`)이 **없어서** variant 파일만 들어감 (`ignore missing` 덕).

### 3.3 registry 경로의 동일 분기

`ModelSpecificSection` (`sections/static.py:385-439`): family/variant 텍스트를 Python dict 상수로 보유 (`_IMPORTANT_BY_FAMILY`, `_IMPORTANT_BY_VARIANT`, `:393-425`). `guard = bool(ctx.model_family)` (`:427-428`). render는 `family 텍스트 + variant 텍스트` 이어붙여 `<IMPORTANT>` 래핑 (`:430-439`). Jinja의 include 체인을 dict lookup으로 재현 — byte 동일하게 맞춰둠.

---

## 4. include 체인 전부 (Jinja 경로 기준)

`system_prompt.j2`가 직접 `{% include %}` 하는 것:

```
system_prompt.j2
├─ {% include 'self_documentation.j2' %}                          (:78)  무조건
├─ {% if security_policy_filename %}
│     {% include security_policy_filename %}                       (:82-84)  조건부 (기본 security_policy.j2)
├─ {% if llm_security_analyzer %}
│     {% include 'security_risk_assessment.j2' %}                  (:87-91)  조건부 (기본 항상 True 시드)
├─ {% if enable_browser is defined and enable_browser %}<BROWSER_TOOLS> 인라인  (:93-103)
└─ <IMPORTANT> set/include 블록                                    (:137-152)
      ├─ model_specific/<family>.j2          (ignore missing)
      └─ model_specific/<family>/<variant>.j2 (ignore missing)
```

`<SOUL>{{ soul_content }}` 은 include가 아니라 변수 치환 (`:1-3`). `security_risk_assessment.j2`, `security_policy.j2`, `self_documentation.j2` 는 leaf (추가 include 없음 — 본문 확인).

추가로 **사용되지만 system_prompt.j2 외부**: `context/prompts/templates/system_message_suffix.j2` — dynamic 블록 전용, `AgentContext.get_system_message_suffix()`가 별도 render (`agent_context.py:326-334`). 그리고 **존재하지만 default 경로 미사용** 변종: `system_prompt_interactive.j2`, `system_prompt_long_horizon.j2`, `system_prompt_tech_philosophy.j2`, `in_context_learning_example*.j2`. `system_prompt_planning.j2`만 planning preset이 `system_prompt_filename`으로 명시 사용 (`openhands-tools/.../preset/planning.py:172`) — escape-hatch로 Jinja를 타게 됨.

---

## 5. 렌더링은 언제 1회 일어나고 캐시되나

**system message는 conversation 당 1회 만들어져 SystemPromptEvent로 고정된다. 매 턴 재렌더 아님.**

근거:
- `init_state` → `_initialize` → SystemPromptEvent 1회 생성 (`agent.py:434-454`). `static_system_message`와 `get_dynamic_context(state)`를 각각 1회 호출해 event의 `system_prompt` / `dynamic_context` 필드에 박는다 (`:443-453`).
- **재초기화 가드**: prefix에 이미 SystemPromptEvent가 있으면 init 스킵 (`agent.py:396, 408-415`). 즉 resume/restore 시 다시 안 만든다. event는 conversation 이벤트 로그에 영속되므로, 한 번 만든 system message가 그대로 재생된다.
- SystemPromptEvent (`event/llm_convertible/system.py:12-42`): `system_prompt: TextContent` (static, cacheable) + `dynamic_context: TextContent | None` (per-conversation, **두 번째 content block**). docstring 명시: cache marker는 여기서 안 붙이고 `LLM._apply_prompt_caching()`이 caching 켜졌을 때 붙임 (`:18-21`). 즉 static 블록만 provider prompt-cache 대상.

**렌더 자체의 캐시 (별개 층)**:
- Jinja env / 컴파일된 template: `lru_cache` (`prompt.py:57,77`) + 디스크 bytecode cache (`:64-69`). 텍스트 결과 캐시가 아니라 *컴파일* 캐시.
- registry 경로: `create_registry()`는 호출마다 새 PromptRegistry 인스턴스를 만든다 (`presets.py:44-71`) — 출력 캐시는 없지만, init_state에서 사실상 1회만 호출되므로 비용 무관.

정리: **렌더 1회 → SystemPromptEvent에 freeze → 매 턴 그대로 재생**, static 블록은 cross-conversation prompt-cache, dynamic 블록은 cache 제외.

---

## 6. AgentContext / microagent / skill 이 system message에 합쳐지는 법

전부 **dynamic 블록**으로 들어간다 (static 아님). 경로:

```
get_dynamic_context(state)                                        (agent.py:456-476)
└─ secret_infos = state.secret_registry.get_secret_infos()        (:473)
└─ ctx = _build_prompt_context(additional_secret_infos=secret_infos)  (base.py:527-592)
   └─ agent_context._resolve_dynamic_data(model, canonical, secrets)  (base.py:558-562 / agent_context.py:340-392)
      ├─ _partition_skills()  →  (repo_skills, available_skills)  (agent_context.py:263-284)
      │     • AgentSkills-format(SKILL.md) or trigger!=None → available_skills (progressive disclosure)
      │           단, disable_model_invocation이면 제외
      │     • legacy trigger=None → repo_skills (REPO_CONTEXT, 항상 active)
      ├─ model-family gating: name=="claude"는 anthropic계열 아니면 drop,
      │     name=="gemini"는 gemini 아니면 drop                   (agent_context.py:352-368)
      ├─ available_skills_prompt = to_prompt(available_skills)    (:372-374)
      └─ secret_infos 머지 (additional override by name)          (:379-386)
└─ create_registry().build(ctx).dynamic                           (agent.py:476)
```

dynamic 섹션 5개 (`presets.py:65-70`, `sections/dynamic.py`), 각자 guard:
- `DateTimeSection` ← `ctx.now` 있을 때 `<CURRENT_DATETIME>` (`dynamic.py:28-42`)
- `RepoContextSection` ← `repo_skills` 있을 때 `<REPO_CONTEXT>` + `<UNTRUSTED_CONTENT>` 경고 (`:45-72`). **microagent/repo skill 본문이 통째로 여기 박힘.**
- `AvailableSkillsSection` ← `available_skills_prompt` 있을 때 `<SKILLS>` (invoke_skill 안내) (`:75-92`)
- `CustomSuffixSection` ← `agent_context.system_message_suffix` raw 텍스트 (`:95-105`)
- `CustomSecretsSection` ← `secret_infos` 있을 때 `<CUSTOM_SECRETS>` (이름/설명만, 값 X) (`:108-136`)

**skill 분류 규칙 핵심** (`agent_context.py:263-284`): AgentSkills-format(SKILL.md) 또는 trigger 가진 skill은 "available skills"로 목록만 노출하고 모델이 `invoke_skill()`로 끌어옴 (progressive disclosure). trigger 없는 legacy skill은 본문 전체가 REPO_CONTEXT에 상주. 즉 **skill은 두 가지 방식으로 system message에 합류**: (1) 항상-on 본문(REPO_CONTEXT), (2) 목록만+lazy invoke(SKILLS). AGENTS.md 같은 repo memory도 이 경로의 repo skill로 들어간다 (`static.py:104` MEMORY 블록이 그걸 가리킴).

Jinja 등가물: `AgentContext.get_system_message_suffix()`가 `system_message_suffix.j2`를 render (`agent_context.py:326-334`). registry의 dynamic 섹션들이 이 `.j2`를 "ported verbatim"한 것 (`dynamic.py:1-9`).

---

## 7. 복잡도 정량화 — "정적 한 장 vs 동적 합성물" 판정

| 차원 | 수치 | 근거 |
|---|---|---|
| 렌더 엔진 | **2개** (Jinja + 타입드 registry, 미러링) | `base.py:483-494` |
| system message content block | **2개** (static cacheable + dynamic per-conv) | `system.py:30-42`, `base.py:443-453` |
| static 섹션 (registry) | **17개** 등록, 그중 **guard로 조건부 4개** (security, security_risk, browser, model_specific) | `presets.py:47-64` |
| dynamic 섹션 | **5개**, 전부 guard 조건부 | `presets.py:65-70`, `dynamic.py` |
| Jinja `{% include %}` 지점 | **5곳** (self_doc 무조건 + policy/risk/2× model_specific 조건부) | `system_prompt.j2:78,83,89,139,141` |
| 변수 주입 소스 | **5종** (SOUL 파일 / 모델명 휴리스틱 / tool 목록 / AgentContext / secret registry) | §2 |
| model_specific 분기 | family 7종 + variant(현 gpt 2종), substring 휴리스틱 | `model_prompt_spec.py:21-51` |
| OS 의존 후처리 | Windows에서 bash→powershell 치환 (`refine`) | `prompt.py:48-54` |
| 렌더 빈도 | **conversation당 1회**, SystemPromptEvent로 freeze, 재init 스킵 | `agent.py:408-415,443-454` |

**판정**: 최종 *바디 텍스트*만 보면 거의 정적인 장문 1장(대부분 `_StaticTextSection`의 하드코딩 상수)이라 "그냥 프롬프트다"가 절반은 맞다. 그러나 *파이프라인*은 명백히 동적 합성물이다 — (1) static/dynamic 2-block 분리로 prompt-cache 최적화, (2) guard 기반 조건부 블록 9개(static 4 + dynamic 5), (3) 모델 family/variant에 따라 `<IMPORTANT>` 가이드가 갈림, (4) skill/microagent/secret/datetime이 per-conversation으로 dynamic 블록에 합성, (5) Jinja↔registry 이중 엔진 + OS별 refine. 단순 텍스트 파일 cat이 아니라 **런타임 입력 5종을 받아 조건부로 조립**하는 빌더다.

다만 우리(quanta) 관점에서 흡수 ROI를 따지면: 동적 부분의 *내용*은 대부분 정책/가이드 산문(정적 상수)이고, 진짜 메커니즘 가치는 (a) static/dynamic 2-block prompt-cache 분리, (b) skill의 progressive-disclosure(목록만 노출 후 lazy invoke), (c) UNTRUSTED_CONTENT로 repo-context를 격리하는 supply-chain 가드 정도다. "프롬프트 엔지니어링"보다 "프롬프트 *조립 + 캐시 + 신뢰경계* 인프라"가 본체.

---

## 8. ASCII 파이프라인 다이어그램

```
                          ┌──────────────────────── 입력 소스 (런타임) ────────────────────────┐
   ~/.openhands/SOUL.md ──┤ self.llm.model ── self.tools ── AgentContext ── secret_registry    │
                          └───────────┬──────────────┬────────────┬───────────────┬────────────┘
                                      │              │            │               │
                          _load_soul_md  get_model_prompt_spec  _resolve_dynamic_data
                          (base.py:119)  (model_prompt_spec.py)  (agent_context.py:340)
                                      │              │            │               │
                                      ▼              ▼            ▼               ▼
                         ┌─────────────────────────────┐   ┌──────────────────────────────┐
                         │ _resolved_template_kwargs() │   │ _build_prompt_context()      │
                         │ soul_content, enable_browser│   │ now, repo_skills,            │
                         │ model_family/variant,       │   │ available_skills_prompt,     │
                         │ security_policy_filename,   │   │ custom_suffix, secret_infos  │
                         │ llm_security_analyzer,cli   │   │ (base.py:527-592)            │
                         │ (base.py:496-525)           │   └──────────────┬───────────────┘
                         └──────────────┬──────────────┘                  │
                                        │                                 │
          ┌─────────────────────────────┴──────────┐                      │
          │ static_system_message (base.py:458)    │                      │
          │  ├ inline system_prompt?  → verbatim   │                      │
          │  ├ escape-hatch?  → render_template ───┼── Jinja2 ───┐        │
          │  │   (custom filename / prompt_dir /   │   system_prompt.j2   │
          │  │    security_policy)                 │   {%include%}×5,refine│
          │  └ DEFAULT → create_registry().build() │   (prompt.py:88)     │
          │                .static  ◄── 17 sections│◄── byte-mirror ──────┘
          │                guarded, "\n\n".join    │
          │  (registry.py:45)                      │
          └──────────────────┬─────────────────────┘                      │
                             │ STATIC block                               │ DYNAMIC block
                             │ (cacheable cross-conv)                     │ create_registry().build().dynamic
                             ▼                                            ▼ (5 dynamic sections, guarded)
                   ┌──────────────────────────────────────────────────────────────┐
                   │  SystemPromptEvent  (system.py:12 / agent.py:443)            │
                   │    system_prompt = TextContent(static)   ← cache marker 대상  │
                   │    dynamic_context = TextContent(dynamic) ← cache 제외        │
                   │    tools = [...]                                              │
                   └──────────────────────────────┬───────────────────────────────┘
                                                  │  init_state에서 1회 emit,
                                                  │  이미 있으면 스킵 (agent.py:408-415)
                                                  ▼
                                     LLM 호출 시 system message로 재생
                                     (_apply_prompt_caching이 static에만 cache marker)
```

---

## 9. 적대적 메모 (검증된 것만)

- "model_family = answer-key 아니냐?" → 아님. substring으로 vendor 라우팅 후 모델별 *행동 가이드*(`<IMPORTANT>`)만 선택. 태스크 정답 키워드 매칭 아님 (`model_prompt_spec.py:21-51`, `static.py:393-425`).
- "Jinja와 registry 두 벌이면 drift 위험?" → snapshot oracle 테스트로 byte-pin (`static.py:4-6`). 단 default는 registry만 타므로 Jinja 변종(`system_prompt_interactive.j2` 등)은 escape-hatch 통해서만 활성 — 그 경로는 registry 미러가 없어 변경 시 둘이 갈릴 수 있는 구조적 함정(코드상 두 소스 존재 확인, 동기화는 default 블록만 보장).
- "정적이니 측정 의미 없다?" → dynamic 블록(skill/secret/datetime)과 OS refine, model_specific 분기 때문에 *실행 컨텍스트별로 system message 바이트가 달라진다*. reproduce 시 SOUL.md 존재/모델명/tool 바인딩/OS를 고정해야 동일 프롬프트 재현됨.

---

## 10. 10줄 요약

1. OpenHands의 최종 system message는 **static(캐시) + dynamic(per-conversation) 두 content block**으로 SystemPromptEvent에 담긴다 (`system.py:12`, `agent.py:443-453`).
2. static 블록은 **두 엔진**으로 만들어진다: default는 타입드 section registry(순수 Python 상수 조립), escape-hatch는 Jinja2 `system_prompt.j2` — byte-mirror로 동기화 (`base.py:483-494`).
3. `render_template`(`prompt.py:88`)은 autoescape=False·기본 Undefined·디스크 bytecode 캐시·Windows전용 `refine`(bash→powershell) 후처리를 갖는다.
4. 주입 변수는 **5개 소스**에서: SOUL.md 파일, 모델명 휴리스틱(family/variant), 바인딩 tool(enable_browser), AgentContext(skills/suffix/datetime), secret registry (§2).
5. model_specific은 `get_model_prompt_spec`의 substring 매칭(`gpt-`/`claude`/`gemini`…)으로 family+variant를 뽑아 `<IMPORTANT>` 가이드를 조건부 include (`model_prompt_spec.py`, `system_prompt.j2:137-152`).
6. include 체인: self_documentation(무조건) + security_policy + security_risk_assessment + model_specific family/variant(ignore missing) — static 4개 guard, dynamic 5개 guard 전부 조건부 (`system_prompt.j2`, `presets.py`).
7. 렌더는 **conversation당 1회**, init_state에서 emit 후 SystemPromptEvent로 freeze, 이미 있으면 재생성 스킵 — 매 턴 재렌더 아님 (`agent.py:408-415`).
8. skill/microagent는 전부 **dynamic 블록**으로 합류: trigger 없는 legacy는 REPO_CONTEXT 본문 상주, AgentSkills/triggered는 SKILLS 목록만+lazy `invoke_skill` (progressive disclosure), claude/gemini skill은 model-family로 gating (`agent_context.py:263-368`).
9. **판정**: 바디 텍스트는 거의 정적 상수 1장이라 "그냥 프롬프트다"가 절반 맞지만, 파이프라인은 guard 9개·변수 5소스·2엔진·OS 후처리·2-block 캐시 분리를 갖는 **동적 합성 빌더**다.
10. 흡수 가치의 본체는 산문이 아니라 (a) static/dynamic prompt-cache 분리, (b) skill progressive-disclosure, (c) UNTRUSTED_CONTENT supply-chain 가드 — "프롬프트 엔지니어링"이 아니라 "프롬프트 조립+캐시+신뢰경계 인프라".
```
