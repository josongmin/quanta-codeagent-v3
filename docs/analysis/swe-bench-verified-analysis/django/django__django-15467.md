---
instance_id: django__django-15467
repo: django/django
base_commit: e0442a628eb480eac6a7888aed5a86f83499e299
version: "4.1"
difficulty: <15 min fix
created_at: 2022-02-27T03:00:31Z
fail_to_pass: 1
pass_to_pass: 62
gold_files: [django/contrib/admin/options.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-15467

## 문제 요약
`radio_fields`가 지정된 `ModelAdmin`에서 ForeignKey 필드의 `empty_label`을 커스텀으로 설정해도 무시된다. 사용자가 `formfield_for_foreignkey`를 오버라이드해 `kwargs['empty_label']`을 직접 넣어주거나 `formfield_overrides = {ForeignKey: {"empty_label": ...}}`를 줘도, radio_fields 분기 내부의 무조건 대입 `kwargs["empty_label"] = _("None") if db_field.blank else None`이 그 값을 항상 폐기한다. 결과적으로 사용자가 지정한 "I WANT TO SET MY OWN EMPTY LABEL" 같은 라벨이 절대 적용되지 않고 늘 기본 라벨(`_('None')`)이 렌더된다. 예외 없이 조용히 잘못된 결과가 나오는 silent-wrong 버그.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed)** — problem_statement가 파일·라인·정확한 한 줄(`django/contrib/admin/options.py`, row 234, `kwargs['empty_label'] = _('None') if db_field.blank else None`)을 직접 지목하고 심지어 수정안까지 제시한다. grep 한 방, 탐색 비용 0.
- **S (Repair Strategy) = S1 Direct-Map (+S2)** — 결함 클래스가 정형적이다: "호출자가 제공한 값을 무조건 덮어쓰는 대입" → "키 부재일 때만 기본값" 가드 삽입. 이슈가 사실상 픽스를 명세하므로 dominant는 S1(template/direct-map). 다만 이슈가 베끼라고 준 `kwargs.get('empty_label') or _('None')`은 **falsy 라벨(빈 문자열 등)을 다시 `_('None')`으로 덮는 미묘한 버그**를 품고 있어, 올바른 식 `kwargs.get("empty_label", _("None"))`(키 부재만 기본값)을 추론으로 골라내야 한다 — 이 한 토막이 S2(constraint-reasoning) 보조다.
- **K (Knowledge) = K-Domain** — 일반 파이썬으로 dict 가드 자체는 자명하나, `formfield_for_foreignkey` 안의 `db_field.blank` 조건, radio_fields 분기, `formfield_overrides`→`kwargs` 전달 경로 등 django admin formfield 생성 파이프라인의 내부 계약을 알아야 "blank가 아니면 `None` 유지"라는 의도를 깨지 않는다.
- **primary type = T-DirectMap** — 위치가 명확하고(L0) 픽스가 기계적 가드 삽입(S1)이라 T-DirectMap이 정확히 맞는다. T-LocTrivial이 아닌 이유는 `or` vs `get(default)` 구분이라는 비자명 엣지가 끼어 픽스가 완전 자명하지는 않기 때문. T-ConstraintReason도 아니다 — 추론은 한 토막 보조일 뿐, 주된 작업은 명세된 가드의 기계적 적용이다.

## 난이도 티어
**T2 (쉬움)**. 이 티어로 미는 구조적 피처: 단일 파일(`options.py`)·단일 라인 변경, L0 핀포인트(localize 직접성 최대), has-repro(이슈 본문에 재현 ModelAdmin 코드 포함), 가벼운 엣지추론만 요구. 

공식 difficulty 라벨 `<15 min fix`(T1 영역)와 한 티어 올린 이유: T1(존나쉬움)은 "이슈가 픽스를 거의 적어주고 픽스가 완전 자명"이어야 하는데, 여기선 이슈가 준 코드(`get(...) or _('None')`)를 그대로 쓰면 falsy-label에서 미세하게 틀린다. 즉 "제시된 수정안이 함정"이라는 점 + PASS_TO_PASS 62개라는 넓은 regression-trap(같은 메서드/admin formfield 인접 동작을 안 깨야 함)이 순수 T1보다 살짝 무겁다. 다만 cross-file·diffuse 요소가 전혀 없어 T3까지 올라가지는 않는다.

## 골드패치 분석
- **건드린 파일·함수**: `django/contrib/admin/options.py` → `ModelAdmin.formfield_for_foreignkey`의 radio_fields 분기 내부.
- **근본 원인**: radio_fields 분기에서 `kwargs["empty_label"]`을 **무조건 대입**으로 설정했다. `db_field.blank`일 때 `_('None')`을 강제로 넣어, 호출자(`formfield_for_foreignkey` 오버라이드 또는 `formfield_overrides`)가 미리 `kwargs`에 넣어둔 `empty_label`을 항상 폐기했다. 즉 "blank이면 기본 라벨" 규칙이 호출자 의도보다 부당하게 우선권을 가졌다.
- **수정 요지**: 무조건 대입을 `kwargs.get("empty_label", _("None"))` 기반으로 교체.
  ```python
  kwargs["empty_label"] = (
      kwargs.get("empty_label", _("None")) if db_field.blank else None
  )
  ```
  `db_field.blank`일 때 호출자가 이미 제공한 `empty_label`이 있으면 그 값을, 키가 없으면 `_("None")`을 쓴다. blank가 아니면 종전대로 `None`. 한 줄(헌크 1개) 변경으로 기본 동작은 보존하면서 오버라이드만 허용한다. 이슈가 제안한 `or` 대신 `get(default)`를 써서 falsy 라벨도 살린다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_radio_fields_foreignkey_formfield_overrides_empty_label`. `radio_fields = {"parent": admin.VERTICAL}` + `formfield_overrides = {ForeignKey: {"empty_label": "Custom empty label"}}`를 동시에 가진 `MyModelAdmin`을 만든다.
- **픽스 증명**: `Inventory._meta.get_field("parent")`(blank=True인 self-FK)에 대해 `formfield_for_dbfield`를 호출하고 생성된 formfield의 `ff.empty_label`이 `"Custom empty label"`과 같은지 단언한다. 패치 전엔 무조건 대입이 `_('None')`으로 덮어 실패, 패치 후엔 `kwargs.get`이 override 값을 살려 통과.
- **overfit 관점**: FAIL_TO_PASS가 1개뿐이라 얇아 보이지만 골드 픽스는 special-case가 아니라 일반 가드(키 있으면 보존)라 overfit-risk는 실질적으로 낮다. 다만 이 단일 테스트는 "blank=True + 비어있지 않은 라벨"만 검증하므로 falsy-label 엣지는 미검증 — 이슈 제안 `or` 버전도 이 테스트는 통과시킨다(테스트가 그 차이를 구별 못함). 그래서 flag에 overfit-risk를 굳이 달지는 않되, 정답 일반화는 테스트가 아니라 의도 추론에서 나온다.
- **regression 관점**: PASS_TO_PASS 62개 — 특히 `test_radio_fields_ForeignKey`(blank가 아닐 때 `empty_label is None`)와 `test_ForeignKey`, `test_formfield_overrides`가 핵심 회귀 가드. blank=False 경로의 `None` 유지와 override 미지정 시 `_('None')` 디폴트가 둘 다 보존되어야 통과한다. regression-trap 플래그를 다는 이유.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 파일·라인·정확한 코드 라인을 직접 준다(`options.py` row 234, `kwargs['empty_label'] = _('None') if db_field.blank else None`). `formfield_for_foreignkey`로 바로 진입해 radio_fields 분기의 무조건 대입을 짚는다. 탐색 사실상 불필요(L0).

2. **픽스 (올바른 일반화인 이유)**: 무조건 대입을 `kwargs.get("empty_label", _("None")) if db_field.blank else None`으로 바꾼다. 이게 special-case 하드코딩이 아니라 올바른 일반화인 근거: (a) "호출자가 명시한 인자는 보존, 없을 때만 디폴트"라는 일반 dict-override 계약을 따른다, (b) blank=False 경로의 `None`을 그대로 둬 기존 의미를 안 바꾼다, (c) `or` 대신 `get(default)`라서 사용자가 일부러 빈 문자열을 empty_label로 줘도 디폴트로 되덮지 않는다 — 가능한 입력공간 전체에서 "사용자 의도 우선" 불변식을 만족.

3. **regression 안전**: PASS_TO_PASS 62개 중 깨면 안 되는 핵심은 `test_radio_fields_ForeignKey`(blank=False → `empty_label is None`)와 override를 안 줬을 때 `_('None')` 디폴트를 기대하는 케이스들(`test_ForeignKey`, `test_formfield_overrides`). 삼항의 `else None` 가지와 `get`의 두 번째 인자 디폴트를 둘 다 보존해야 이들이 안 깨진다.

4. **함정 회피**: 오라클 없는 에이전트의 두 가지 오답 경로. (1) 이슈가 친절히 준 `kwargs.get('empty_label') or _('None')`을 **그대로 복붙** — falsy 라벨(빈 문자열)을 `_('None')`으로 되덮는 미묘한 버그. FAIL_TO_PASS 테스트는 이걸 못 잡으므로 "테스트 초록 = 정답"이라 믿으면 틀린다. 의도("내가 준 값을 존중하라")를 코드 계약 수준에서 읽어 `get(key, default)`를 골라야 한다. (2) blank=False 분기의 `None` 유지를 깜빡하고 모든 경우에 `get`을 적용하면 `test_radio_fields_ForeignKey`가 깨진다 — 삼항의 양쪽 가지를 분리해서 봐야 한다.
