# Round 3 적대 어딧 — "복잡 인프라 5계층"이 reproduce 논의에서 red herring인가

분석 소스: `/Users/songmin/Documents/code-new/competitor-scaffolds/openhands-agent-sdk/`
대상 결론(Round 2): "OpenHands는 '그냥 프롬프트'가 아니라 동적 프롬프트 합성 인프라 5계층이다."
이 라운드의 임무: 그 "복잡 인프라" 주장을 **반대 방향**으로 공격 — *reproduce에 한정하면* 그 복잡도가 헛다리인지 검증.
모든 file:line은 위 트리 기준. 추측 없이 Read/Grep으로 확인한 것만.

---

## 0. 판정 요약 (먼저)

**복잡 인프라 5계층은 reproduce 행동을 설명하는 데 거의 전부 잉여다.** reproduce 시점/품질을 미는 실제 구성요소는 오컴의 면도날을 적용하면 단 셋으로 환원된다:

1. **정적 워크플로 텍스트 15줄** (`<PROBLEM_SOLVING_WORKFLOW>`, `static.py:178-196` / `system_prompt.j2:60-75`) — conversation당 1회 렌더되는 정적 상수 안의 한 섹션.
2. **Terminal + FileEditor tool** (default preset의 base 3개 중 2개, `preset/default.py:52-55`) — repro 스크립트를 쓰고 실행할 능력.
3. **모델 자율** — 위 15줄은 MUST가 아니라 환경 조건부 nudge라(04-reproduce-flow §1-1), 실제 시점은 모델이 정함.

5계층(condenser / repo-context(AGENTS.md) / skills / secrets / section-registry cache-tiering) 중 reproduce 시점·품질에 **직접 기여하는 것은 0개**다. 전부 (a) reproduce와 무관한 일반 인프라이거나, (b) 기본 설정에서 비활성이거나, (c) repro 행동이 *이미 일어난 뒤* long-horizon 생존을 돕는 2차 효과다. "복잡 인프라"는 그 15줄을 배달하는 봉투이고, reproduce를 설명하는 인과 사슬에 들어오지 않는다.

다만 정직성 단서 둘(과대공격 방지): (i) condenser는 **bare `Agent` 클래스에선 OFF지만 `get_default_agent` 팩토리에선 ON**으로 배선된다(§2). (ii) condenser의 요약 프롬프트는 TESTS/CHANGES를 강제 보존하므로 *long-horizon repro 세션의 생존*엔 간접 기여한다(05 §1.5). 그래도 "repro를 언제·어떻게 할지" 결정엔 무관하다.

---

## 1. 공격 각도 1 — 5계층이 reproduce와 무관함 (계층별 판정)

Round 2가 센 "동적 합성 5계층"(05 §5.3): (a) view/property/manipulation-index history 압축, (b) 별도 LLM 요약 condenser, (c) project/third-party skill 로더, (d) trigger 매칭 + progressive disclosure, (e) section registry 정적/동적 cache tiering. 01의 "변수 5소스"(SOUL/datetime/AGENTS.md/skills/security)도 같이 본다. 각각이 *reproduce 시점 또는 품질*에 인과 기여하는지 판정:

| 계층/소스 | 코드 근거 | reproduce 시점에 영향? | reproduce 품질에 영향? | 판정 |
|---|---|---|---|---|
| **condenser (a)(b)** | `agent/base.py:402` `condenser=None`; `utils/condenser`; `llm_summarizing_condenser.py` | 무관 — history가 길어졌을 때만 발화, repro를 트리거/억제 안 함 | 간접 — 요약 프롬프트가 TESTS/CHANGES 보존(05 §1.4) → *이미 시작된* 긴 repro 세션 생존 | **2차/조건부.** repro "언제/할지" 결정엔 무관 |
| **secrets** | `dynamic.py:108-135` `CustomSecretsSection`; guard `bool(ctx.secret_infos)` | 무관 — credential env export 안내일 뿐 | 무관 — repro 스크립트 작성/실행 방식과 직교 | **완전 무관 일반 인프라** |
| **datetime** | `dynamic.py:28-42`; guard `bool(ctx.now)` | 무관 — 현재 시각 한 줄 | 무관 | **완전 무관 일반 인프라** |
| **security policy / risk assessment** | `system_prompt.j2:82-91`; `static.py:287-294` | 무관 — repo-context 출처 action을 HIGH risk escalate(05 §3.4)지 repro 강제 아님 | 무관(오히려 마찰) | **완전 무관 일반 인프라** |
| **AGENTS.md / repo-context (c)** | `dynamic.py:45-71`; guard `bool(ctx.repo_skills)` | 조건부 — repo에 AGENTS.md가 repro 지침을 담으면 영향 가능, but **SDK가 ship하는 repro 지침 자산 없음**(04 §4, microagents/ 부재) | 조건부 — 사용자가 공급해야만 | **워크스페이스 의존, SDK 기본 0** |
| **skills + progressive disclosure (d)** | `skill.py:600-647`; `dynamic.py:75-92`; guard `bool(ctx.available_skills_prompt)` | 조건부 — trigger="reproduce"류 skill을 사용자가 깔아야; SDK 기본 repro skill 없음(04 §3.4) | 조건부 | **워크스페이스 의존, SDK 기본 0** |
| **section registry cache tiering (e)** | `section.py:24-31`; `system.py:81-85` | 무관 — 같은 텍스트를 static/dynamic 2블록으로 쪼개 prompt-cache 최적화. 바이트 동일 | 무관 — 순수 캐시 최적화 | **전달층 최적화, 의미 무관** |
| **SOUL.md** | `base.py:106-130` `_DEFAULT_SOUL` "You are OpenHands agent, a helpful AI assistant…" | 무관 — identity 한 단락 | 무관 | **완전 무관, 기본은 일반 문구** |
| **model_family/variant `<IMPORTANT>`** | `model_prompt_spec.py:21-51`; `static.py:393-439` | 무관 — vendor별 행동 가이드(방어적 프로그래밍 피하라 등) 3줄, repro 단계 아님 | 미미 | **무관 일반 가이드** |

**소계:** 9개 항목 중 reproduce 시점에 **직접** 영향 = **0개**. 조건부(워크스페이스가 repro 지침을 공급할 때만) = 2개(AGENTS.md, skills) — 그나마 SDK 기본 자산은 0. 나머지 7개는 secrets/datetime/security/SOUL/cache-tier/model-IMPORTANT처럼 reproduce와 **직교하는 범용 에이전트 인프라**다. 즉 "복잡 인프라 5계층"을 reproduce 논의에 끌고 오는 것은 **red herring이 맞다** — 그 복잡도는 멀티 LLM provider·credential 관리·prompt-cache·supply-chain 가드를 위한 것이지 repro를 미는 장치가 아니다.

---

## 2. 공격 각도 2 — condenser 기본 OFF, 가동 계층 재계산

05 §1.6이 "메인 Agent의 `condenser` 필드는 기본 `None` (`agent/base.py:402`)"이라 했다. 직접 확인:

```python
# openhands-sdk/openhands/sdk/agent/base.py:402
condenser: CondenserBase | None = Field(
    default=None,
    description="Optional condenser to use for condensing conversation history.",
```

→ **bare `Agent()`에선 condenser OFF 확정.** 그러면 5계층 중 (a)+(b)(history 압축 + 요약 LLM)는 **기본 설정에서 빠진다.**

**그러나 정직성 정정(과대공격 방지):** convenience 팩토리 `get_default_agent`는 condenser를 **명시 배선**한다:

```python
# openhands-tools/openhands/tools/preset/default.py:73-89
def get_default_agent(llm, cli_mode=False):
    ...
    agent = Agent(
        llm=llm, tools=tools,
        condenser=get_default_condenser(           # ← 여기서 ON
            llm=llm.model_copy(update={"usage_id": "condenser"})),
    )
# :68  get_default_condenser → default_condenser(llm)  (max_size=80, keep_first=4)
```

즉 condenser ON/OFF는 **진입점 의존**이다: 날 `Agent` 생성자 = OFF, `get_default_agent` 팩토리 = ON. Round 2가 "기본 None"만 인용한 건 절반의 진실이다.

**그래도 가동 계층 재계산 결론은 불변:** condenser가 ON이든 OFF든, condenser는 history가 길어졌을 때만 발화하는 **history 관리기**이지 reproduce 트리거가 아니다(05 §1.2의 3 트리거 = REQUEST/TOKENS/EVENTS, 전부 길이/요청 기반, repro 무관). 따라서 reproduce 시점 결정에 가동되는 계층은 condenser 포함 여부와 무관하게 동일하다. **repro를 설명하는 가동 계층 = (15줄 워크플로 텍스트가 들어간) 정적 system_prompt 1개 + tool 능력.** condenser는 repro 인과에서 빠진다.

---

## 3. 공격 각도 3 — 렌더 1회 + 정적 바디, "복잡 파이프라인은 봉투"

01 §5가 "system message는 conversation당 1회 만들어져 SystemPromptEvent로 freeze, 매 턴 재렌더 아님"(`agent.py:408-415,443-454`)이라 했고, §7이 "바디 텍스트는 거의 정적 상수 1장"이라 했다. 그리고 reproduce 행동을 미는 텍스트 `<PROBLEM_SOLVING_WORKFLOW>`는 직접 세보면 **정확히 15 content 줄**(태그 제외, `static.py:179-195` / `system_prompt.j2:60-74`):

```
1. EXPLORATION            (1줄)
2. ANALYSIS               (1줄)
3. TESTING                (헤더 + 서브 6줄 = 7줄)  ← repro 신호의 본체는 :182 "Create tests to verify issues before implementing fixes"
4. IMPLEMENTATION         (헤더 + 서브 3줄 = 4줄)
5. VERIFICATION           (1줄)
                          ──────
                          15줄
```

이 15줄은 `_StaticTextSection.body`의 **하드코딩 Python 상수**다(`static.py:178` `class ProblemSolvingSection(_StaticTextSection)`, `body = """..."""`). guard 없음(무조건 static에 포함). Jinja 경로의 `system_prompt.j2:60-75`와 byte-identical.

**공격 성립:** Round 2가 센 "2엔진·guard 9개·변수 5소스·OS refine·2블록 캐시"(01 §7)는 전부 **이 15줄 상수를 모델에게 배달하는 봉투**다. 봉투의 정교함(Jinja↔registry 미러, prompt-cache tiering, model_family include 체인)은 *어떤 텍스트가 들어가느냐*를 거의 안 바꾼다 — repro 신호 줄(`:182`)은 어느 경로로 렌더해도 동일 바이트로 나온다. 봉투를 다 걷어내도 모델이 받는 repro 지시는 그 15줄 그대로다. **파이프라인 복잡도는 reproduce 행동의 원인이 아니라 전달 메커니즘**이며, 1회 렌더 후 freeze되므로 매 턴 동적이지도 않다(repro 관련해선).

반례 점검: dynamic 블록이 매 호출 달라지므로 "정적 아님"이라 반박할 수 있나? → repro에 한정하면 No. dynamic 5섹션(datetime/repo/skills/suffix/secrets)은 §1에서 본 대로 repro 신호를 담지 않는다. repro를 미는 텍스트는 100% **static 블록의 그 15줄**에 있고, static 블록은 정의상 cross-conversation 고정이다.

---

## 4. 공격 각도 4 — 양쪽 과장의 경계, 정확한 표현

- **"그냥 프롬프트"(너무 단순):** 부정확. system_prompt는 단일 문단 cat이 아니라 다중 섹션 guard 조립 + static/dynamic cache 분리다(01 §7). repro 신호 자체는 프롬프트가 맞지만, "그냥"이 인프라 존재를 부정하면 틀림.
- **"복잡 인프라 5계층"(너무 거창):** *reproduce 논의에 한정하면* 부정확. 5계층은 repro 인과에 0~2차로만 닿고(§1), 기본 가동도 진입점 의존이며(§2), repro 신호는 1회-렌더 정적 15줄이다(§3). 5계층을 reproduce 설명에 끌어오면 red herring.

**reproduce에 한정한 정확한 표현(코드로 확정):**

> "OpenHands의 reproduce 행동 = **정적 워크플로 프롬프트 15줄**(`<PROBLEM_SOLVING_WORKFLOW>`, 비강제 nudge) + **Terminal·FileEditor tool 능력**(default preset base, `preset/default.py:52-55`) + **모델 자율**(15줄이 MUST 아님, 04 §1-1). 동적 합성 인프라는 이 셋의 전달·생존을 돕는 주변 장치이고, reproduce를 *발생*시키지 않는다."

tool 수 정정: 04나 프롬프트에서 흔히 말하는 "16 tool"은 **레지스트리 총량(실측 18개 등록, `register_tool` grep)** 이지 default 바인딩이 아니다. default preset이 실제 바인딩하는 base는 **3개**(Terminal/FileEditor/TaskTracker, `preset/default.py:52-55`) + 옵션(Browser, TaskToolSet). reproduce에 직접 쓰이는 건 **Terminal + FileEditor 2개**다. 따라서 "16 tool 능력"보다 "터미널+파일편집 2 tool"이 repro 환원에 더 정확하다.

---

## 5. 공격 각도 5 — 오컴의 면도날, 최소 구성요소

reproduce 행동을 설명하는 데 **필요한 최소 집합**만 남긴다(없으면 repro 설명이 무너지는 것 = 필요, 빼도 설명 그대로 = 잉여):

**필요(3):**
1. **정적 워크플로 15줄** — 빼면 모델에게 "고치기 전 테스트로 재현" 권장 신호가 사라짐. repro 시점의 유일한 명시 레버(04 §6 (b)). `static.py:182`.
2. **Terminal + FileEditor tool** — 빼면 repro 스크립트를 쓰고/돌릴 수단이 없음. `preset/default.py:52-55`.
3. **모델 자율** — 15줄이 비강제(04 §1-1, MUST 부재 + 환경 출구 `:68-69,:74`)라 실제 시점은 모델이 흡수. 빼면 시점이 미결정.

**잉여(repro 설명에 불필요):**
- condenser(history 압축/요약) — repro 시점·내용 결정 무관, 길이 관리만(§1,§2). *long-horizon 생존엔 보조적*이나 repro 발생 설명엔 불필요.
- secrets / datetime / security policy / SOUL / model_family `<IMPORTANT>` — 전부 repro와 직교(§1).
- AGENTS.md repo-context / skills progressive-disclosure — SDK 기본 repro 자산 0(04 §3.4,§4). 사용자가 repro skill을 깔 때만 작동하는 **선택적 외부 입력**이지 OpenHands가 제공하는 repro 메커니즘 아님.
- section-registry 2엔진 / cache tiering / OS refine — 순수 전달·캐시·이식 최적화(§3). repro 바이트 불변.

**최종 판정: 인프라 복잡도는 reproduce 설명에 잉여다.** reproduce 행동은 "정적 15줄 + 2 tool + 모델 자율" 3요소로 완전히 환원된다. 5계층 인프라는 (i) reproduce와 직교하는 범용 에이전트 기능이거나(secrets/datetime/security/cache), (ii) 기본 비활성·진입점 의존이거나(condenser bare-OFF), (iii) repro가 이미 일어난 뒤의 2차 생존 보조(condenser 요약 보존)이거나, (iv) 사용자가 채워야 작동하는 빈 슬롯(AGENTS.md/skills)이다. 어느 것도 "OpenHands가 언제·어떻게 reproduce하는가"의 인과에 들어오지 않는다. **Round 2의 "복잡 인프라 5계층" 프레이밍은 reproduce 논의에서 red herring이다 — 정확한 프레이밍은 "비강제 워크플로 15줄을 모델에 권하고 터미널 줘서 맡긴다".**

단, Round 2 자체가 틀린 건 아니다: Round 2는 "매 LLM 호출 context 합성물 전반"을 논했고 그 맥락에선 5계층이 실재한다(01·05 확인). **틀린 건 그 5계층을 reproduce 인과로 전용하는 것**이다. 5계층은 일반 에이전트 인프라, reproduce는 그 위에 얹힌 15줄짜리 프롬프트 nudge — 둘은 다른 층위다.

---

## 6. 적대적 자기검증 (이 라운드가 과대공격했나)

- "condenser 무관"이 과한가? → 부분 인정. condenser 요약 프롬프트의 TESTS/CHANGES 강제 보존(05 §1.4)은 *긴 repro 세션이 context-overflow로 죽지 않게* 돕는다. 이건 repro **품질**(완주율)에 간접 기여. 그러나 repro를 *시작/억제*하는 결정엔 무관하고, 기본 진입점(bare Agent)에선 아예 OFF라 "시점" 논의엔 잉여 유지. 품질 각주로 남김.
- "tool 2개" 환원이 과한가? → TaskTracker도 default base에 있고(`preset/default.py:55`) long-horizon repro에서 단계 추적에 쓰일 수 있다. 그래도 repro 스크립트 작성·실행의 핵심은 Terminal+FileEditor 2개. TaskTracker는 보조.
- AGENTS.md를 "빈 슬롯"으로 깐 게 과한가? → 아니다. 04 §4 grep + SDK 트리에 microagents/ 부재 확인. SDK가 repro 지침을 ship하지 않음은 사실. 사용자가 채우면 작동하나 그건 OpenHands의 repro 메커니즘이 아니라 사용자 입력.
- 반대편 과소공격: "15줄도 repro 안 미는 거 아니냐(MUST 아님)"? → 04 §1-1이 이미 비강제 입증. 그래서 (d) 모델 자율을 필요 집합에 넣음. 15줄은 *유일한 명시 레버*라 잉여는 아니고 약한 필요.

세 각도 모두에서 핵심 결론(인프라 복잡도 = reproduce 설명에 잉여)은 견딤. 정정은 condenser 진입점 배선·tool 총량(18 vs default 3) 두 군데로, 둘 다 결론을 강화하거나 무해.

---

## 7. 10줄 요약

1. **판정: 복잡 인프라 5계층은 reproduce 설명에 잉여(red herring).** reproduce 행동은 "정적 워크플로 15줄 + Terminal·FileEditor 2 tool + 모델 자율" 3요소로 완전 환원된다.
2. 5계층 중 reproduce **시점**에 직접 기여 = **0개**(§1 표 9항목). secrets/datetime/security/SOUL/cache-tier/model-`<IMPORTANT>`는 repro와 직교하는 범용 인프라.
3. condenser는 bare `Agent`에서 **OFF**(`agent/base.py:402` `default=None`) — 단 `get_default_agent` 팩토리는 **ON 배선**(`preset/default.py:73-89`). ON/OFF는 진입점 의존(Round 2의 "기본 None"은 절반의 진실).
4. condenser는 ON이든 OFF든 history 길이 관리기일 뿐 repro 트리거 아님(트리거=REQUEST/TOKENS/EVENTS, 05 §1.2). repro 가동 계층 = 정적 system_prompt 1개 + tool, condenser 무관.
5. reproduce를 미는 텍스트 `<PROBLEM_SOLVING_WORKFLOW>`는 **정확히 15 content 줄**의 하드코딩 상수(`static.py:178-196`), guard 없이 static 블록에 무조건 포함, conversation당 1회 렌더 후 freeze(`agent.py:408-415`).
6. 2엔진·9 guard·5 변수소스·OS refine·2블록 캐시(01 §7)는 그 15줄을 배달하는 **봉투**다. 봉투를 걷어도 모델이 받는 repro 지시 바이트는 불변. 복잡도는 원인이 아니라 전달.
7. tool 정정: 레지스트리 총 **18개 등록**(`register_tool` 실측)이나 default preset base는 **3개**(Terminal/FileEditor/TaskTracker, `preset/default.py:52-55`). repro 직접 사용은 **Terminal+FileEditor 2개** — "16 tool"보다 정확.
8. AGENTS.md repo-context와 skills progressive-disclosure는 SDK 기본 repro 자산 **0**(04 §3.4,§4, microagents/ 부재). 사용자가 채워야 작동하는 빈 슬롯이지 OpenHands가 제공하는 repro 메커니즘 아님.
9. **양쪽 과장 경계:** "그냥 프롬프트"(인프라 부정)도 "복잡 인프라 5계층"(repro로 전용)도 부정확. reproduce 한정 정확표현 = "비강제 워크플로 15줄을 모델에 권하고 터미널 줘서 맡긴다".
10. 정직성 각주: condenser 요약의 TESTS/CHANGES 강제 보존(05 §1.4)은 *긴 repro 세션 완주율*에 간접 기여 — repro **품질**의 2차 보조이나 repro **시점/발생**엔 무관. Round 2가 틀린 게 아니라, 그 일반 인프라를 reproduce 인과로 전용한 것이 red herring.
