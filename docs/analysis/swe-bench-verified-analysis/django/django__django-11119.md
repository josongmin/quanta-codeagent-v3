---
instance_id: django__django-11119
repo: django/django
base_commit: d4df5e1b0b1c643fe0fc521add0236764ec8e92a
version: "3.0"
difficulty: <15 min fix
created_at: 2019-03-24T21:17:05Z
fail_to_pass: 1
pass_to_pass: 7
gold_files: [django/template/engine.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-11119

## 문제 요약
`Engine`을 `autoescape=False`로 생성한 뒤 `render_to_string()`을 호출해도 결과가 항상 자동 이스케이프된다. 즉 엔진의 `autoescape` 속성이 무시되어, 사용자가 끈 설정과 무관하게 `<script>` 같은 값이 `&lt;script&gt;`로 변환된다. `Engine.render_to_string`에서 비-`Context` 입력을 받았을 때 새 `Context`를 만드는데 엔진의 autoescape를 넘기지 않은 것이 원인. 사용자는 엔진 설정대로 이스케이프가 꺼진 raw 출력을 기대했다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement가 함수명(`render_to_string`)·생성 클래스(`Context`)·속성(`autoescape`)을 직접 명시하고, 회귀를 일으킨 커밋 해시(`19a5f6da329d58653bcda85`)까지 지목한다. grep 한 방으로 단일 메서드에 도달. 후보 탐색 비용 사실상 0.
- **S (Repair Strategy) = S1 Direct-Map (+S2 보조)**: 결함 클래스가 정형(생성자에 옵션 전파 누락)이고 픽스가 사실상 명세되어 있다 — "엔진 autoescape를 Context에 전달". 한 키워드 인자 추가의 기계적 수정이라 S1이 dominant. 다만 두 분기(`isinstance(context, Context)` vs `else`) 중 **어느 쪽만 고칠지**를 의미적으로 판별해야 하는 미세한 제약 추론이 있어 S2를 보조로 표기 — 호출자가 직접 넘긴 `Context`의 autoescape는 존중해야 하고 else 분기에서 새로 만드는 `Context`에만 전파해야 한다.
- **K (Knowledge) = K-Domain**: django 템플릿 서브시스템 내부 계약 지식이 필요하다. `Context` 생성자가 `autoescape` 키워드 인자를 받는다는 것, 그 기본값이 `True`라는 것, 엔진의 `autoescape`가 의미상 컨텍스트로 흘러가야 한다는 것을 알아야 한다. 일반 파이썬 추론(K-Gen)만으론 "기본값이 True라 누락이 곧 버그"라는 연결을 못 짚는다.
- **Primary type = T-DirectMap**: 위치가 L0로 명확하고 픽스가 S1 기계적(생성자 인자 전파)이라 T-DirectMap에 정확히 부합. T-LocTrivial이 아닌 이유는 픽스가 완전 자명한 가드/상수가 아니라 도메인 인자 이름·기본값 지식과 분기 선택 절제를 요구하기 때문. T-ConstraintReason도 아닌 것은 올바른 식을 추론 합성하는 게 아니라 이미 존재하는 속성을 그대로 넘기면 되기 때문.

## 난이도 티어
- **티어 = T2 (쉬움)**: L0 + S1, 단일 파일 1줄 수정, has-repro(이슈가 정확한 재현 시나리오와 회귀 커밋까지 제공), K-Domain은 가볍다(인자 하나의 이름·기본값만 알면 됨). 이 프로파일은 T2의 전형(L0/L1 + S1/S2, 1파일 소규모, 가벼운 엣지추론).
- **이 티어로 미는 구조적 피처**: (1)파일 1개·실수정 1줄 → 구조적 컷 "1파일·<5줄 ≈ 48% solve" 구간. (2)localize 직접성 최상(파일·함수·속성·회귀커밋 모두 명시). (3)has-repro 존재 → 가장 강한 easiness 신호.
- **T1이 아니고 T2인 이유**: 픽스가 픽스를 적어준 수준의 완전 자명한 1라인이 아니다. (a)두 분기 중 else만 고쳐야 하는 분별이 필요하고, 양쪽 다 덮으면 `regression-trap`(호출자 명시 Context의 autoescape 무시 → PASS_TO_PASS 위험)에 빠진다. (b)`Context(autoescape=...)` 키워드 인자라는 django 도메인 지식(K-Domain)을 요구한다. 이 두 요소가 순수 K-Gen·무조건반사 T1보다 한 단계 위.
- **공식 라벨과의 정합**: 공식 difficulty는 `<15 min fix`(T1~T2 prior). 개발자 구현시간 기준으론 거의 T1이지만, 에이전트 관점에선 분기 선택 실수로 인한 회귀 가능성이 시간라벨에 안 잡히므로 T2로 한 칸 올림.

## 골드패치 분석
- **건드린 파일·함수**: `django/template/engine.py` — `Engine.render_to_string` (1 hunk, 1 effective line).
- **근본 원인**: 비-`Context` 입력(dict/None)을 받는 `else` 분기에서 `Context(context)`로 새 컨텍스트를 생성하는데, `Context`의 기본 `autoescape`가 `True`다. 엔진의 `self.autoescape`를 생성자에 넘기지 않아 엔진 설정이 통째로 누락됐다. 회귀 커밋(`19a5f6da329d58653bcda85`)에서 render 경로를 정리할 때 이 전파가 빠진 것으로 이슈에 명시.
- **수정 요지**: `t.render(Context(context))` → `t.render(Context(context, autoescape=self.autoescape))`. dict/None 입력 경로에서만 엔진의 `autoescape` 속성을 새 `Context`로 전파한다. 이미 `Context` 인스턴스가 넘어온 위 분기(`if isinstance(context, Context): return t.render(context)`)는 호출자가 명시한 인스턴스의 autoescape를 그대로 존중하므로 손대지 않는다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_autoescape_off (template_tests.test_engine.RenderToStringTest)`.
- **동작/픽스 증명**: 신규 테스트가 `Engine(dirs=[TEMPLATE_DIR], autoescape=False)`로 엔진을 만들고 `render_to_string('test_context.html', {'obj': '<script>'})`를 호출한다. 픽스 전에는 새 `Context`가 기본 autoescape=True라 `obj:&lt;script&gt;\n`이 나와 assert 실패, 픽스 후엔 `autoescape=self.autoescape`(=False)가 전파되어 기대값 `obj:<script>\n`이 그대로 출력되어 통과. dict 입력 + autoescape=False 조합이 정확히 else 분기를 친다.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇긴 하나, 픽스가 special-case 하드코딩이 아니라 속성을 일반 전파하는 형태라 overfit 위험은 낮다. autoescape=False 한 케이스만 검증하지만 메커니즘상 True/False 모두 올바르게 흐른다. CEGIS(S4)가 필요한 과소명세 상황이 아니므로 `overfit-risk` 플래그는 미부착.
- **regression 관점**: PASS_TO_PASS 7개 중 핵심은 `test_basic_context` — 기본 autoescape=True의 dict 경로를 그대로 통과시켜야 한다. 골드패치가 `self.autoescape`(엔진 기본 True)를 전파하므로 기본 경로 출력은 불변. 나머지 6개(LoaderTests 3, GetDefaultTests 3)는 무관 영역이라 영향 없음. `regression-trap` 플래그는 "else만 고쳐야" 제약 때문에 부착 — 만약 `if` 분기까지 autoescape를 덮으면 호출자 Context 설정이 깨질 수 있다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `Engine.render_to_string`(함수)·`Context`(생성 객체)·`autoescape`(누락 속성)·회귀 커밋 해시를 모두 명시 → `django/template/engine.py`의 `render_to_string` 한 메서드로 직행. grep `render_to_string` 또는 회귀 커밋 diff 확인이면 충분. L0이므로 탐색 단계에서 헤맬 여지가 없다.
2. **픽스와 왜 올바른 일반화인가**: else 분기의 `Context(context)`에 `autoescape=self.autoescape`를 추가. special-case(autoescape=False일 때만 분기)가 아니라 엔진 속성을 무조건 컨텍스트로 전파하는 구조적 픽스라 True/False 양쪽에 옳다. 엔진의 `autoescape` 의도가 모든 render 경로로 흘러야 한다는 불변식을 복원하는 것이므로 overfit이 아닌 정당한 일반화.
3. **regression 안전**: `test_basic_context`(기본 autoescape=True, dict 입력)가 깨지지 않아야 한다. `self.autoescape` 기본값이 True이므로 전파해도 기본 경로 출력은 동일 → 안전. `Context` 인스턴스를 직접 넘기는 `if` 분기는 절대 건드리지 않아 호출자 명시 설정을 보존.
4. **함정 회피**: 오라클 없는 에이전트가 빠질 함정은 (a)**두 분기 모두 수정** — `isinstance(context, Context)` 분기까지 autoescape를 강제로 덮으면 호출자가 명시한 Context 설정을 무시해 회귀. else 분기만 고치는 절제가 핵심. (b)**잘못된 인자 이름/방식** — `Context(context, autoescape=...)` 키워드를 모르고 `context['autoescape']` 같은 dict 조작이나 render 시점 override로 우회하면 틀린다. `Context` 생성자 시그니처(K-Domain)를 정확히 확인할 것. (c)과대 수정(엔진 전체 리팩터/다른 render 메서드 동시 수정)은 불필요하며 새 회귀 표면만 늘린다 — 최소 1라인 수정이 정답.
