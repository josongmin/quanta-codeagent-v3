---
instance_id: django__django-12713
repo: django/django
base_commit: 5b884d45ac5b76234eca614d90c83b347294c332
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2020-04-13T23:57:12Z
fail_to_pass: 1
pass_to_pass: 58
gold_files: [django/contrib/admin/options.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-12713

## 문제 요약
Django admin의 `ModelAdmin.formfield_for_manytomany()`에서 호출자가 넘긴 `widget`(예: `formfield_overrides = {ManyToManyField: {'widget': ...}}`로 주입된 위젯)이 무시된다. 같은 클래스의 ForeignKey 버전(`formfield_for_foreignkey()`)은 사용자 지정 위젯을 존중하는데 M2M 버전은 `autocomplete_fields`/`raw_id_fields`/`filter_vertical`/`filter_horizontal` 분류에 걸리면 무조건 admin 기본 위젯으로 덮어쓴다. problem_statement가 "formfield_for_foreignkey()와 다르다"고 직접 짚어 비대칭이 곧 버그임을 명시한다. 에러 없이 조용히 잘못된 위젯이 나오는 silent-wrong 결함.

## 유형 (정형화)

- **L0 (Pinpointed)** — 이슈 본문이 함수명 `formfield_for_manytomany()`를 그대로 적어주고, 정상 동작하는 짝(`formfield_for_foreignkey()`)까지 지목한다. `formfield_for_manytomany`를 grep하면 `django/contrib/admin/options.py` 단 한 군데로 수렴, 추가 데이터플로우 추적이 필요 없다. localize는 사실상 공짜.
- **S1 Direct-Map (+S2)** — dominant는 S1: 결함 클래스가 "이미 채워진 kwargs를 무조건 덮어씀"이라는 정형 missing-guard 패턴이고, 픽스는 바로 아래 `queryset` 처리의 `if 'queryset' not in kwargs:`를 그대로 미러링한 `if 'widget' not in kwargs:` 가드 추가다. 템플릿 매칭 수준. 보조로 S2가 약하게 붙는 이유는, "어디에 가드를 거느냐"가 식 합성을 요구하기 때문 — 세 `elif` 분기를 개별로 막으면 안 되고 블록 전체를 한 가드로 감싸야 올바르다는 불변식 판단(개별 가드 vs 전체 가드)이 한 단계 들어간다.
- **K-Domain** — 일반 파이썬으로 "kwargs 있으면 건너뛴다"는 패턴 자체는 K-Gen이지만, 무엇이 위젯 덮어쓰기를 유발하는지(`formfield_overrides`→`formfield_for_dbfield`→`formfield_for_manytomany`의 admin 위젯 결정 체인, `RelatedFieldWidgetWrapper` 래핑) 이해와 "FK와 M2M의 계약이 같아야 한다"는 admin API 관례 인지는 django admin 도메인 지식이다.

primary type = **T-DirectMap**: 위치 명확(L0) + 기계적 가드 추가(S1). T-LocTrivial이 아닌 이유는 픽스가 "조건 추가"라는 정형 결함클래스이지 이슈가 코드를 한 줄 적어주는 자명 수준은 아니고, 올바른 가드 범위 판단(전체 블록)이 들어가서다.

## 난이도 티어
**T2 (쉬움)**. 이 티어로 미는 구조적 피처:
- **1파일·소규모**: gold가 `options.py` 한 파일, 로직 변경 0줄(세 분기 보존), 들여쓰기 한 단계 + 가드 한 줄 추가가 본질.
- **L0 직접 localize**: 함수명과 비교 대상이 이슈에 박혀 있어 탐색 비용 거의 없음.
- **가벼운 엣지추론**: "가드를 전체 블록에 감싼다"는 판단(S2 약하게)이 있어 순수 T1 자명은 아님.
- **regression-trap이 티어를 T1이 아닌 T2로 고정**: PASS_TO_PASS 58개 중 `test_filtered_many_to_many`, `test_raw_id_many_to_many`, `test_many_to_many`, `test_formfield_overrides*` 등 기존 autocomplete/raw_id/filtered 위젯 선택 동작이 안 깨져야 한다. 분기 로직을 보존하지 않고 재작성하면 회귀.

공식 라벨 "15 min - 1 hour"는 개발자 구현시간 기준으로 admin 도메인 맥락 파악·테스트 작성을 포함한 값이다. 에이전트 난이도(localize 직접성 높음 + 픽스 정형 + has-repro 부재이나 비교대상 명시)로 재조정하면 T2가 적정. 라벨이 T3쪽으로 보이는 것은 도메인 친숙도가 없는 개발자의 admin 위젯 체인 학습 비용 때문이며, 오라클 관점에서 구조적 픽스 자체는 minimal하다.

## 골드패치 분석
- **건드린 파일/함수**: `django/contrib/admin/options.py` : `ModelAdmin.formfield_for_manytomany()`
- **근본 원인**: 함수가 `db_field.name`의 `autocomplete_fields` / `raw_id_fields` / `[*self.filter_vertical, *self.filter_horizontal]` 멤버십을 검사해 무조건 `kwargs['widget']`을 자기 위젯(`AutocompleteSelectMultiple`, `widgets.ManyToManyRawIdWidget`, `widgets.FilteredSelectMultiple`)으로 설정했다. 호출자가 이미 `kwargs['widget']`을 채워 넣었어도(예: `formfield_overrides`가 주입) 검사 없이 갈아치움. `formfield_for_foreignkey()`는 동일 상황에서 사용자 위젯을 존중하므로 계약 비대칭.
- **수정 요지**: 세 분기로 이루어진 위젯 결정 블록 전체를 `if 'widget' not in kwargs:` 가드로 감쌌다. 호출자가 위젯을 명시하지 않은 경우에만 admin이 필드 분류에 따라 위젯을 선택하고, 이미 위젯이 있으면 그대로 둔다. 바로 아래 `if 'queryset' not in kwargs:` 패턴과 동일하며 FK 버전과 계약이 일치한다. 분기 로직 자체는 불변, 들여쓰기 한 단계만 추가(diff의 멀티라인 인자 포맷 변경은 cosmetic).

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_formfield_overrides_m2m_filter_widget` — `filter_vertical = ['members']`이면서 동시에 `formfield_overrides = {ManyToManyField: {'widget': forms.CheckboxSelectMultiple}}`를 지정한 `BandAdmin`을 만든다. 즉 admin이 위젯을 덮어쓸 조건(`filter_vertical` 멤버십)과 사용자 위젯 주입이 충돌하는 상황.
- **픽스 증명**: `ma.formfield_for_dbfield(Band._meta.get_field('members'), request=None)`로 필드를 생성한 뒤 `field.widget.widget`이 `CheckboxSelectMultiple` 인스턴스인지 단언한다. admin이 `RelatedFieldWidgetWrapper`로 한 겹 감싸므로 내부 위젯은 `.widget.widget`. 버그 상태에선 `filter_vertical` 분기가 `FilteredSelectMultiple`로 덮어써 단언 실패 → 가드 추가 후 `formfield_overrides`가 넣은 위젯이 생존해 통과. 테스트는 `ManyToManyField` import도 추가.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇지만, 테스트가 "덮어쓰기 조건과 사용자 위젯이 동시 존재"라는 정확히 충돌하는 케이스를 잡아 가드의 핵심 의미를 검증한다. special-case 픽스(예: `filter_vertical`만 가드)로도 이 단일 테스트는 통과 가능 → 약한 S4성 overfit 여지는 존재하나, 골드의 전체 블록 가드가 올바른 일반화. `overfit-risk` 플래그를 달 만큼 위험하진 않음(결함 패턴이 정형이라 자연스레 전체 가드로 수렴).
- **regression 관점**: `regression-trap` 플래그. PASS_TO_PASS 58개가 widget 없이 호출되는 기존 경로(autocomplete/raw_id/filtered/일반 m2m)를 모두 커버하므로, 가드가 `'widget' not in kwargs`일 때만 분기를 타게 보존하면 안전. 분기 로직 재작성·조건 반전은 즉시 회귀.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 함수명 `formfield_for_manytomany()`와 비교 대상 `formfield_for_foreignkey()`를 직접 적어준다 → `django/contrib/admin/options.py`에서 두 함수를 grep해 나란히 diff. FK 함수는 위젯 결정을 `if 'widget' not in kwargs:`(또는 동등 가드)로 감싸고 있고 M2M 함수는 무방비로 `kwargs['widget'] = ...`을 실행하는 차이가 즉시 보인다.
2. **픽스와 일반화 근거**: M2M의 세 분기(`autocomplete_fields`/`raw_id_fields`/`filter_vertical`+`filter_horizontal`) 위젯 설정 블록 전체를 `if 'widget' not in kwargs:`로 감싼다. 개별 분기마다 가드를 거는 대신 블록 단위로 감싸는 것이 올바른 이유: (a) 의도가 "호출자가 위젯을 줬으면 admin은 손대지 않는다"는 단일 불변식이고, (b) 바로 아래 `queryset` 처리가 동일 패턴(`if 'queryset' not in kwargs:`)을 이미 쓰며, (c) FK 버전과 계약을 일치시켜 비대칭을 제거한다. 이는 단일 테스트를 노린 special-case가 아니라 모든 위젯 주입 경로를 일관 처리하는 일반화.
3. **regression 안전**: 위젯을 명시하지 않은 호출(PASS_TO_PASS의 `test_filtered_many_to_many`, `test_raw_id_many_to_many`, `test_many_to_many`, autocomplete 관련 등)에선 `'widget' not in kwargs`가 참이라 기존 분기가 그대로 실행돼 동작 불변. 분기 내부 로직과 위젯 클래스 인자(`db_field.remote_field`, `self.admin_site`, `using=db`, `db_field.verbose_name`, `db_field.name in self.filter_vertical`)를 한 글자도 바꾸지 말 것 — 들여쓰기만 추가하는 minimal change가 58개 P2P 보존의 핵심.
4. **함정 회피**: 오라클 없는 에이전트의 실패 지점 — (a) 세 `elif`를 개별 가드로 분산해 일부 경로만 막아 다른 위젯 주입 케이스를 놓침(전체 블록 가드가 정답). (b) 테스트가 기대하는 위젯 접근 경로 오해 — admin이 `RelatedFieldWidgetWrapper`로 감싸므로 검증은 `field.widget.widget`이지 `field.widget`이 아니다. 이를 모르고 픽스 검증 로직을 잘못 짜면 자기 검증이 헷갈림(단, gold 픽스 자체는 정확하면 통과). (c) 분기 로직을 "개선"한답시고 재작성해 P2P 회귀 유발. 정답은 로직 보존 + 가드 한 겹.
