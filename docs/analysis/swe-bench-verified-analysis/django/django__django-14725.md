---
instance_id: django__django-14725
repo: django/django
base_commit: 0af9a5fc7d765aa05ea784e2c3237675f3bb4b49
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2021-08-01T21:24:36Z
fail_to_pass: 3
pass_to_pass: 64
gold_files: [django/forms/models.py]
primary_type: T-SpecInference
tier: T4
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain
flags: [regression-trap, underspecified, cross-file-dep]
---

# django__django-14725

## 문제 요약
모델 폼셋(ModelFormSet)에는 "수정 전용(edit-only)" 뷰, 즉 기존 객체 편집만 허용하고 신규 객체 생성은 막는 방법이 없다. 사용자들은 `extra=0`으로 이를 흉내내려 하지만 `extra`는 단지 표시할 추가 폼 개수를 뜻할 뿐이라 JavaScript나 추가 POST 데이터로 폼을 더 보내면 새 객체가 생성된다. hints에서 길게 논의된 `max_num=0`+`validate_max` 조합도 `form-INITIAL_FORMS` 값을 조작하면 추가 인스턴스가 만들어지는 빈틈이 있다("Please submit 0 or fewer forms" 검증을 우회). 이슈는 결함 리포트가 아니라 **기능 요청**이며, 원하는 동작·API 형태·세 팩토리(`modelformset_factory`/`inlineformset_factory`/`save`)에 걸친 배선까지 본문이 직접 명세하지 않는다. 의도된 스펙("신규 생성을 원천 차단하는 1급 옵션")을 이슈 논의에서 재구성해야 한다.

## 유형 (정형화)

**L (Localization) = L1 (Traceable).** 이슈가 심볼을 직접 지목하지는 않지만 "model formsets / 신규 객체 생성 차단"이라는 키워드가 `django/forms/models.py`의 `BaseModelFormSet.save()`와 팩토리 함수들로 좁게 수렴한다. grep 한 방(L0)은 아니고, 신규 객체가 어디서 저장되는지(`save_new_objects`) 호출 경로를 한 단계 추적해야 하므로 L1이 정확하다.

**S (Repair Strategy) = S5 Spec-Inference (+S6 Design-Refactor).** 이건 버그 수정이 아니라 기능 추가다. 코드만 보면 "어떻게 고쳐야 맞는지"가 결정되지 않는다 — 이슈 본문·후속 논의·linked PR에서 **의도된 스펙을 먼저 재구성**해야 한다: (1) 새 옵션 이름은 `edit_only`, (2) `True`일 때 `save_new_objects()`를 아예 호출하지 않음, (3) `max_num` 같은 검증 레이어가 아니라 `save()` 경로에서 차단(queryset 밖 pk도 안전하게), (4) 두 팩토리 모두에 인자를 노출. 그래서 dominant가 S5다. 그 위에 보조로 S6(작은 구조 변경) — 단일 라인 픽스가 아니라 클래스 속성(`FormSet.edit_only`) 도입 + 팩토리 시그니처 확장 + `save()` 분기라는 조율된 배선이 필요하다.

**K (Knowledge) = K-Domain.** django forms/formsets 내부 지식이 병목이다. `save_existing_objects` vs `save_new_objects`의 역할 분리, 팩토리가 클래스 속성을 어떻게 주입하는지(`FormSet.model = model` 패턴), `inlineformset_factory`가 kwargs를 `modelformset_factory`로 위임하는 구조를 알아야 한다. 일반 파이썬 추론(K-Gen)으로는 "어디에 플래그를 박아야 inline까지 닿는지"를 도출할 수 없다.

**Primary type = T-SpecInference.** dominant 축이 S5(스펙 재구성)이고, 이슈가 underspecified한 기능 요청이라는 점이 본질적 난점이다. 픽스 코드 자체는 기계적이지만(가드 분기 + 인자 패스스루), 그 코드를 정당화하는 **스펙을 이슈에서 추론**하는 것이 핵심 작업이라 T-DirectMap이 아닌 T-SpecInference로 분류한다.

## 난이도 티어
**Tier = T4 (약간 어려움).** 공식 difficulty 라벨("15 min - 1 hour")과 대체로 정합하지만, 그 라벨은 "스펙이 PR로 이미 합의된 상태에서 개발자가 구현하는 시간"이다. 오라클 없는 에이전트 관점에서는 다음 구조적 피처가 T4로 민다:

- **단일 파일이지만 멀티 함수 조율(S6 색채):** `save()`/`modelformset_factory()`/`inlineformset_factory()` 세 곳을 일관되게 배선해야 한다. `save()`에만 분기를 넣고 팩토리 인자를 빠뜨리면 `edit_only`가 클래스에 닿지 않아 inline 케이스가 실패한다(cross-file-dep 성격의 암묵 의존).
- **underspecified 기능 요청:** repro 스택트레이스가 없고, hints가 `max_num`/`validate_max` 우회 가능성을 길게 논의하다 결국 "그걸로는 안 된다"로 수렴한다. 이 토론에 끌려가면 검증 레이어만 건드려 헛다리를 짚는다(스펙 재구성 비용).
- **넓은 P2P trap (64개):** model_formsets 전체 동작 — `max_num`/`min_num`/`validate_max`/inline/custom-pk/deletion 등 — 을 안 깨야 한다. `edit_only=False` 기본값과 else 분기로 기존 경로를 byte-identical하게 보존하는 것이 필수 조건.

T3가 아닌 이유: 단일 라인 추론이 아니라 세 함수 조율 + 스펙 재구성이 동시에 필요하고 regression 표면이 넓다. T5가 아닌 이유: 멀티파일 아님, overfit 고위험 아님(테스트가 생성/수정/queryset-밖 3각도로 충분히 명세), 픽스 줄 수가 작다(헌크 4개, ~10줄).

## 골드패치 분석
- **건드린 파일/함수:** `django/forms/models.py` — `BaseModelFormSet.save()`, `modelformset_factory()`, `inlineformset_factory()`.
- **근본 원인:** `save()`가 항상 `self.save_existing_objects(commit) + self.save_new_objects(commit)`를 반환해 신규 폼을 무조건 저장했다. 신규 생성을 원천 차단할 클래스 수준 스위치가 존재하지 않았고, 사용자가 시도하던 `extra=0`/`max_num`은 표시·검증 레이어라 데이터 조작으로 우회 가능했다.
- **수정 요지:**
  - `save()`에 `if self.edit_only:` 분기 추가 — `True`면 `save_existing_objects(commit)`만 반환하고 `save_new_objects()`를 **호출조차 하지 않는다**(검증이 아니라 저장 경로에서 차단). `else`는 기존 합산식을 그대로 유지.
  - `modelformset_factory()` 시그니처에 `edit_only=False` 추가, 생성된 클래스에 `FormSet.edit_only = edit_only` 속성을 박아(`FormSet.model = model`과 동일 패턴) 인스턴스 `save()`가 읽을 수 있게 한다.
  - `inlineformset_factory()`에도 `edit_only=False`를 추가하고 위임용 kwargs dict에 `'edit_only': edit_only`를 실어 `modelformset_factory()`로 전달한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (3개):** `tests/model_formsets/tests.py`의 `test_edit_only`, `test_edit_only_inlineformset_factory`, `test_edit_only_object_outside_of_queryset`.
- **픽스 증명 방식:**
  - `test_edit_only`: `modelformset_factory(Author, edit_only=True)`에 신규 폼 2개(`INITIAL_FORMS=0`)를 보내고 `save()` 후 Author 테이블에 기존 charles만 남는지 `assertSequenceEqual`. 이어서 기존 객체 수정 데이터를 보내면 `charles.name`이 'Arthur Rimbaud'로 갱신되되 신규는 생기지 않음을 확인 — **수정은 살리고 생성만 막음**을 동시에 못박는다.
  - `test_edit_only_inlineformset_factory`: `inlineformset_factory(... edit_only=True)`에서 기존 Book만 수정되고 신규 Book이 저장되지 않음을 검증 — 팩토리 위임 배선이 실제로 닿는지 증명(이게 패스스루 누락을 잡는 teeth).
  - `test_edit_only_object_outside_of_queryset`: queryset 밖의 pk(walt)를 보내도 새로 생성·수정되지 않고 charles·walt 둘 다 원본 유지됨을 `assertCountEqual`로 확인 — hints에서 지적된 "queryset 밖 pk" 코너를 봉인.
- **overfit 관점:** 세 테스트가 (정상 생성차단) × (수정보존) × (queryset-밖 안전)의 3각도를 커버해 special-case 통과가 어렵다. S4 수준의 underspecification은 아니다 — 다만 세 케이스의 인과는 동일하지 않다. `test_edit_only`/`test_edit_only_inlineformset_factory`는 `TOTAL>INITIAL`이라 extra(신규) 폼이 존재하고, 이를 막는 것은 `save_new_objects` 미호출이라는 일반해다. 반면 `test_edit_only_object_outside_of_queryset`는 `TOTAL_FORMS=1`/`INITIAL_FORMS=1`로 extra 폼이 0개라 `save_new_objects`가 빈 루프이고, walt 폼은 `_construct_form`에서 `i(0) < initial_form_count()(1)` → `pk_required=True`인 INITIAL(existing) 폼으로 분류된다. walt가 저장/수정되지 않는 진짜 이유는 골드패치가 건드리지 않은 base 코드 `save_existing_objects`의 기존 가드 `if obj.pk is None: continue`다(charles-only queryset에서 `_existing_object(walt.pk)` 조회 실패 → instance.pk=None). 즉 이 테스트는 `save_new_objects` 차단 분기를 전혀 타지 않는다.
- **regression 관점:** `edit_only=False` 기본값 + `else` 분기로 64개 P2P(max_num/min_num/validate_max/deletion/inline/custom-pk/unique 등)의 코드 경로가 변경 전과 동일하게 유지된다. 기본 미설정 호출자는 영향 0.

## 모범답안 (오라클 기반)

**1) Localize 경로.** 이슈 신호 "신규 객체 생성을 막는다"에서 출발 → `django/forms/models.py`에서 신규 객체가 *어디서 저장되는지* grep(`save_new_objects`). 호출처가 `BaseModelFormSet.save()`의 `save_existing_objects(commit) + save_new_objects(commit)` 한 줄임을 발견 — 이 합산이 정확히 chokepoint다. 그 다음 "옵션을 어떻게 노출하나"를 역추적: `save()`는 인스턴스 메서드이므로 클래스 속성이 필요 → 클래스를 만드는 `modelformset_factory`, 그리고 그것을 위임받는 `inlineformset_factory`까지 두 진입점을 식별.

**2) 픽스와 올바른 일반화인 이유.** `save()`에 `edit_only` 가드를 넣어 신규일 때 `save_new_objects()`를 호출하지 않는다. 이게 올바른 일반화인 이유: extra(신규) 폼에서 객체가 생성되는 **유일한 소스**가 `save_new_objects`이므로 그 호출을 끊으면 `extra` 조작이든 `INITIAL_FORMS` 조작으로 늘어난 extra 폼이든 정상 신규 생성 경로가 한 지점에서 차단된다(이게 `test_edit_only`/`test_edit_only_inlineformset_factory`처럼 `TOTAL>INITIAL`인 케이스를 막는 실제 메커니즘). 단, queryset 밖 pk(`test_edit_only_object_outside_of_queryset`의 walt)는 "신규로 분류"되지 않는다 — `_construct_form`에서 INITIAL 폼으로 분류되어 `save_existing_objects` 경로로 가고, 거기 기존 가드(`obj.pk is None → continue`)에서 떨어진다. 따라서 `save_new_objects` 차단은 이 코너와 무관하고, 그 테스트가 FAIL_TO_PASS인 진짜 이유는 base에서 `edit_only=True` kwarg가 `modelformset_factory`의 unknown argument라 `TypeError`를 내기 때문(배선 부재)이지 behavioral 차단 때문이 아니다. 검증 레이어(`max_num`/`validate_max`)를 손대는 대안은 데이터 조작으로 우회 가능하므로 근본 차단이 아니다. 팩토리에 인자를 노출하고 `FormSet.edit_only` 속성으로 주입하는 것은 django 기존 관례(`FormSet.model = model`)와 동형이라 자연스러운 일반화다.

**3) Regression 안전.** `edit_only=False` 기본값과 `else: return save_existing + save_new` 보존이 핵심. 이로써 64개 P2P가 손대지 않은 경로를 탄다 — 특히 `test_max_num`/`test_modelformset_validate_max_flag`/`test_deletion`/`test_inline_formsets*`/`test_simple_save` 등 기존 저장·검증 동작이 그대로여야 한다. 신규 분기는 opt-in이라 기존 호출자 위험 0.

**4) 함정 회피.** 오라클 없는 에이전트가 틀릴 지점:
- **함정 A (스펙 헛다리):** hints가 `max_num=0`/`validate_max` 우회를 길게 논의해 검증 레이어만 건드리게 유인한다. 회피법 — 그 토론의 결론이 "그걸로는 INITIAL_FORMS 조작으로 새 객체가 샌다"임을 읽고, 검증이 아닌 **저장 경로**를 차단해야 함을 인식.
- **함정 B (배선 누락):** `save()`에만 플래그를 넣고 `inlineformset_factory` 패스스루를 빠뜨리면 `test_edit_only_inlineformset_factory`만 빨갛게 남는다. 회피법 — 인자 → 클래스 속성 → 인스턴스 읽기의 3단 경로를 끝까지 추적하고, inline이 `modelformset_factory`에 kwargs로 위임하는 구조를 확인해 양쪽 팩토리에 모두 추가.
- **함정 C (과교정):** 신규 폼을 `is_valid()` 단계에서 막아 "데이터 보내면 에러"로 만들면 안 된다 — 오라클 테스트는 `is_valid()`가 `True`이고 신규는 **조용히 저장만 안 됨**을 요구한다(`self.assertIs(formset.is_valid(), True)`). 회피법 — 차단을 검증이 아닌 `save()` 단계에 둔다.
