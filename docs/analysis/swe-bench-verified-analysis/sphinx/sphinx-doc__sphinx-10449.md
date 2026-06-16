---
instance_id: sphinx-doc__sphinx-10449
repo: sphinx-doc/sphinx
base_commit: 36367765fe780f962bba861bf368a765380bbc68
version: "5.1"
difficulty: "<15 min fix"
created_at: 2022-05-14T14:02:26Z
fail_to_pass: 1
pass_to_pass: 30
gold_files: [sphinx/ext/autodoc/typehints.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap]
---

## 문제 요약

`autodoc_typehints = "description"` 옵션을 켜고 `autoclass`로 클래스를 문서화하면, 클래스 본문에 의미 없는 "Return type: None"이 출력된다. 원인은 클래스의 `__init__(...) -> None` 시그니처에서 추출된 반환 어노테이션을 autodoc이 클래스 자체의 rtype으로 끌어올려 표시하기 때문이다. 사용자 기대는 "클래스에는 반환 타입이 없어야 한다"이다.

## 유형 (정형화)

- **L1 (Traceable)**: 이슈가 파일/함수를 직접 지목하지는 않지만 `autodoc_typehints="description"` + rtype 출력이라는 키워드가 `sphinx/ext/autodoc/typehints.py`의 `merge_typehints`/`modify_field_list`로 좁게 수렴한다. grep 한 방은 아니나 후보가 단일파일·소수 함수다.
- **S2 (Constraint-Reasoning, +S6)**: 고칠 지점은 분명하나, "어떤 조건에서 rtype 필드를 억제할지"를 정확히 추론해 합성해야 한다. 올바른 조건은 `objtype == 'class' AND return annotation == 'None'`이며, 이를 위해 함수 시그니처에 `suppress_rtype` 파라미터를 도입(소규모 구조변경 = S6)해 호출부에서 컨텍스트를 전달한다.
- **K-Domain**: sphinx autodoc 내부 모델(annotations temp_data, objtype, field_list 노드 트리, rtype/param 필드 의미)을 알아야 픽스가 가능. 일반 파이썬 추론만으로는 부족.
- **primary = T-ConstraintReason**: 위치는 좁게 잡히지만 난점은 "정확한 억제 조건식"을 도메인 불변식(클래스는 반환값 개념이 없음 + None은 무의미)에서 추론 합성하는 데 있다. 기계적 None-가드(S1)가 아니라 "어디서/언제만 억제"라는 조건 추론이 본질이라 S2.

## 난이도 티어

**T3 (중간)**. 구조적 피처: 1파일·실질 +9줄, 헌크 3개(호출부 분기 / 시그니처 확장 / 억제 분기). localize는 L1로 비교적 직접적이고 has-repro 성격의 명확한 재현이 있어 쉬움 쪽으로 당기지만, 픽스가 단순 상수/가드가 아니라 `objtype`와 `annotation=='None'` 두 조건을 함께 묶는 추론(S2) + 파라미터 도입(S6)을 요구한다. P2P 30개 중 `test_autodoc_typehints_description*` 계열이 다수라 "함수/메서드의 정당한 `-> None` rtype은 계속 출력되어야 한다"는 regression-trap이 존재 — 조건을 `objtype=='class'`로 정확히 좁히지 않으면 인접 테스트가 깨진다. 공식 라벨은 "<15 min fix"(T1~T2 prior)이지만, 조건 합성 + regression-trap 때문에 한 단계 올려 T3로 본다.

## 골드패치 분석

- **파일**: `sphinx/ext/autodoc/typehints.py`
- **함수**: `merge_typehints` (호출부), `modify_field_list` (시그니처 + 억제 로직)
- **근본원인**: `merge_typehints`는 `autodoc_typehints_description_target == "all"`일 때 `modify_field_list`를 호출하는데, 이 함수 말미의 `if 'return' in annotations and 'return' not in arguments:` 블록이 `__init__`의 `-> None` 어노테이션을 클래스 노드의 rtype 필드로 무조건 추가한다. 클래스에는 반환 타입 개념이 없으므로 이는 거짓 출력이다.
- **수정요지**:
  1. `modify_field_list`에 `suppress_rtype: bool = False` 파라미터 추가(기본값으로 기존 동작 보존).
  2. rtype 추가 블록 진입 시 `annotation == 'None' and suppress_rtype`이면 즉시 `return`하여 rtype 필드 생성을 건너뜀.
  3. `merge_typehints`에서 `objtype == 'class'`일 때만 `suppress_rtype=True`로 호출, 그 외(함수/메서드)는 기존대로 호출.

  즉 "클래스이고 반환이 None일 때만" rtype을 억제한다. 클래스의 `-> str` 같은 비-None은 억제하지 않는다(보수적 일반화).

## 검증 (test_patch)

- **FAIL_TO_PASS**: `test_autodoc_typehints_description_with_documented_init`. test_patch는 기대 출력에서 다음 3줄을 **삭제**한다.
  ```
  '   Return type:\n'
  '      None\n'
  '\n'
  ```
  즉 documented `__init__`을 가진 클래스 문서에서 "Return type: None"이 더 이상 나오지 않아야 통과. 픽스가 정확히 이 출력 경로를 차단하므로 증명된다.
- **overfit 관점**: 억제 조건이 `annotation=='None' and suppress_rtype(=class)`로 좁아, 테스트 너머의 일반 케이스(메서드 None 반환, 클래스의 비-None)에는 영향 없음 — special-case 과적합이 아니라 도메인적으로 옳은 좁힘. FAIL_TO_PASS는 1개로 얇지만 조건이 의미적으로 타이트해 overfit-risk 플래그는 미부여.
- **regression 관점**: P2P 30개에 `test_autodoc_typehints_description`, `..._no_undoc`, `..._documented_init_no_undoc_doc_rtype` 등 rtype 출력을 검증하는 인접 테스트가 다수. 기본값 `suppress_rtype=False`와 `objtype=='class'` 한정 덕분에 함수/메서드의 정당한 rtype은 보존되어 이들이 깨지지 않는다 → regression-trap 통과.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 "`autodoc_typehints="description"` → 클래스에 Return type 출력" 신호로 `sphinx/ext/autodoc/typehints.py`를 연다. `description_target=="all"` 분기에서 `modify_field_list`가 호출되고, 함수 끝의 `if 'return' in annotations and 'return' not in arguments:` 블록이 rtype 필드를 만든다는 것을 읽어낸다. autoclass 컨텍스트는 `merge_typehints(app, domain, objtype, ...)`의 `objtype`로 식별 가능함을 확인.
2. **픽스와 일반화 근거**: 무조건 억제(예: rtype 블록 통째 삭제)는 함수의 정당한 `-> None`까지 죽이므로 틀림. 올바른 일반화는 "클래스이고 반환이 None일 때만" 억제. 따라서 `modify_field_list`에 `suppress_rtype` 파라미터를 도입해 호출부(`merge_typehints`)에서 `objtype=='class'` 컨텍스트를 주입하고, 내부에서 `annotation=='None' and suppress_rtype`만 건너뛴다. 클래스는 반환 개념이 없고 None rtype은 정보가 0이라는 도메인 불변식이 근거.
3. **regression 안전**: 기본 인자 `False`로 기존 모든 호출(함수/메서드/`documented_params` 경로)을 byte-identical하게 유지. P2P의 rtype 검증 테스트군이 안 깨지는 이유가 바로 이 default 보존 + class 한정이다.
4. **함정 회피**: 오라클 없는 에이전트가 빠질 함정 — (a) rtype 블록을 무조건 제거해 메서드 None rtype까지 없앰(P2P 회귀), (b) `annotation` 검사 없이 클래스면 무조건 억제해 클래스 비-None 반환을 잃음, (c) `objtype` 대신 fullname 휴리스틱으로 클래스 판별 시도(부정확). 회피법: 억제를 `objtype=='class' AND annotation=='None'` 두 조건의 교집합으로만 좁히고, 시그니처 변경은 기본값으로 하위호환을 지킨다.
