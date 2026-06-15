---
instance_id: django__django-16527
repo: django/django
base_commit: bd366ca2aeffa869b7dbc0b0aa01caea75e6dc31
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-02-05T22:05:00Z
fail_to_pass: 1
pass_to_pass: 6
gold_files: [django/contrib/admin/templatetags/admin_modify.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S4)
knowledge: K-Domain
flags: [overfit-risk, has-repro]
---

# django__django-16527

## 문제 요약
Django admin 변경 화면의 "Save as new"(저장하면서 새 객체 생성) 버튼은 사실상 add 동작인데, 노출 조건 `show_save_as_new`이 add 권한을 검사하지 않았다. `submit_row()`에서 이 값이 `not is_popup and has_change_permission and change and save_as`로 계산되어, change 권한만 가진 staff에게도 버튼이 노출 → add 권한 없이 새 레코드를 만들 수 있는 권한 우회가 발생한다. problem_statement는 파일 경로·라인(102)·키·수정안(`and has_add_permission`)까지 그대로 적어준다.

## 유형 (정형화)

**L (Localization) = L0 (Pinpointed)** — 이슈 본문이 파일(`django/contrib/admin/templatetags/admin_modify.py`), 라인 번호(102), 정확한 컨텍스트 키(`show_save_as_new`), 심지어 패치 코드까지 직접 제시. grep 한 방으로 끝나는 핀포인트.

**S (Repair Strategy) = S1 Direct-Map (+S4 Counterexample-Guided)** — 픽스는 한 줄 토큰 교체(`has_change_permission` → `has_add_permission`)로 정형 결함클래스(누락 권한 가드)에 템플릿 매칭되는 기계적 수리 → S1이 dominant. 보조로 S4가 붙는 이유: FAIL_TO_PASS 테스트가 "교체(replace)"와 "추가(append)"를 **구별하지 못한다**. 테스트의 양성 케이스 `add_user`는 add+change를 *둘 다* 부여하므로, `has_add_permission and has_change_permission`(둘 다 검사)으로 구현해도 그대로 통과한다. 즉 주어진 테스트는 픽스를 과소명세하며, 골드의 "add만으로 충분"한 일반화로 수렴하려면 구별용 입력(add만/change만)을 스스로 떠올려야 한다 — CEGIS적 함정.

**K (Knowledge) = K-Domain** — django admin의 권한 모델(add/change/delete 코드네임), `submit_row` 컨텍스트 게이팅, "Save as new = add 의미"라는 admin 시맨틱을 알아야 *왜* change가 아니라 add인지 판단 가능. 일반 파이썬 추론(K-Gen)만으로는 "둘 다 검사하면 안전하지 않나"에서 멈춘다.

**Primary type = T-DirectMap** — 위치가 명확하고(L0) 픽스가 기계적 권한 가드 교체(S1)이므로, 루브릭의 "위치 명확 + S1 기계적 픽스(가드)" 정의에 정확히 들어맞는다. T-LocTrivial이 아닌 이유는 픽스 자체가 K-Domain 판단(change→add 교체 방향)을 요구해 완전 자명(K-Gen)은 아니기 때문. T-GenValidate(S4 dominant)도 아니다 — 후보가 다수 반복으로 수렴하는 게 아니라 정답이 1토큰으로 정해져 있고, overfit은 부수 위험일 뿐이다.

## 난이도 티어
**Tier = T2 (쉬움).** 구조적 피처: 단일 파일·단일 라인(<5줄, ICLR 2024 컷에서 ~48% solve 구간), L0 핀포인트 localize, problem_statement가 사실상 픽스를 적어줌(has-repro에 준하는 강한 easiness 신호), PASS_TO_PASS=6으로 regression-trap 약함. 이 피처들은 T1~T2를 가리킨다.

T1이 아니라 T2인 이유: 픽스가 K-Gen 자명이 아니라 K-Domain 판단(왜 change가 아니라 add인가, 그리고 "둘 다"가 아니라 "교체"인가)을 요구하고, 테스트가 교체/추가를 구별 못 하는 overfit-risk가 얹혀 있어 "이슈가 픽스를 거의 적어주는" T1의 무난함보다 살짝 위다.

공식 difficulty 라벨("15 min - 1 hour")과의 차이: 공식 라벨은 개발자 구현시간(테스트 작성 포함, admin 권한 픽스처 설정 비용)이라 1시간 가까이 나오지만, 에이전트 관점의 *코드 수정* 난이도는 핀포인트 L0 + 1라인이라 그보다 낮은 T2가 맞다. 시간라벨은 localize 직접성과 픽스 한 줄짜리임을 반영하지 못한다.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/templatetags/admin_modify.py` : `submit_row(context)`
- 근본 원인: `show_save_as_new` 컨텍스트 값이 `not is_popup and has_change_permission and change and save_as`로 계산되어, "현재 객체를 새 레코드로 저장"하는 add 시맨틱임에도 `has_add_permission`을 전혀 보지 않았다. change 권한만으로 통과해 권한 게이트가 누락.
- 수정 요지: 단 한 줄 토큰 교체 — `and has_change_permission` → `and has_add_permission`. "Save as new"의 게이팅 권한 기준을 change에서 add로 *교체*. hints에서 "둘 다 검사할 필요 없이 has_add_permission만으로 충분"(Save as New는 현재 객체의 저장이기도 하나 권한 기준은 add로 통일)이라고 합의된 결론을 그대로 반영. 과거 #3817은 인접한 "Save and add another"만 고쳤던 부분 수정이었고, 이 패치가 누락된 "Save as new" 경로를 메운다.

## 검증 (test_patch)
- FAIL_TO_PASS(1): `test_submit_row_save_as_new_add_permission_required` — `submit_row()`가 반환하는 `show_save_as_new` 플래그가 add 권한 유무로 올바르게 토글되는지 검증.
- 픽스 증명 방식:
  - change 권한만 가진 `change_user`로 `UserAdmin.change_view`(`save_as=True`) 실행 → `submit_row(response.context_data)["show_save_as_new"]`가 `False`여야 함. 버그 코드에선 change만으로 `True`가 되어 실패 → 픽스 후 `has_add_permission`이 False라 `False`로 떨어짐. 이 음성 케이스가 회귀를 잡는 teeth.
  - add+change 둘 다 가진 `add_user`로 동일 실행 → `show_save_as_new`가 `True`. `get_perm(User, get_permission_codename("add"/"change", User._meta))`로 권한을 정밀 부여.
- overfit·regression 관점:
  - **overfit-risk(있음)**: 양성 케이스 `add_user`가 add+change를 *둘 다* 갖기 때문에, 잘못된 구현 `has_add_permission and has_change_permission`(둘 다 검사)도 두 어서션을 모두 통과한다. 테스트는 "교체"를 강제하지 못한다. 골드와 동치가 갈리는 입력(add만 있고 change 없는 사용자)은 테스트되지 않는다 → 주어진 슈트로는 "둘 다 검사" plausible 패치를 걸러낼 수 없다.
  - **regression(낮음)**: PASS_TO_PASS=6은 `test_submit_row`, `test_override_show_save_and_add_another`, date_hierarchy/검색패턴 등 인접 동작. 단일 키만 건드리므로 깰 위험 작음. 다만 인접 `show_save_and_add_another`/`can_save_and_add_another` 로직을 잘못 손대면 P2P가 깨진다.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement가 `admin_modify.py` 라인 102 + 키 `show_save_as_new` + 패치 초안을 직접 명시 → `submit_row` 컨텍스트 dict에서 `show_save_as_new` 항목 한 줄로 직행. 탐색 노력 사실상 0(L0).
2. **픽스와 왜 올바른 일반화인가**: `and has_change_permission`을 `and has_add_permission`으로 *교체*. "Save as new"는 새 객체를 생성하므로 권한 기준은 add여야 한다는 admin 시맨틱이 근거. 사용자 초안과 달리 change를 *남겨두지 않는* 이유는 hints의 결론("add만으로 충분") — 이미 change_view 진입 자체가 변경 컨텍스트를 보장하므로 change를 중복 검사할 필요가 없고, 권한 의미상 add 단일 게이트가 정확. 이것이 overfit이 아닌 올바른 일반화인 이유: add만 있는/change만 있는 모든 권한 조합에서 "add 권한 있을 때만 노출"이라는 단일 불변식을 만족시킨다(둘 다 검사하면 add는 있는데 change 없는 사용자에게 부당하게 숨겨짐).
3. **regression 안전**: P2P의 `test_submit_row`(기본 컨텍스트), `test_override_show_save_and_add_another`, `submit_row template tag should pass whole context`를 깨지 않아야 함. `show_save_as_new` 단일 키만 토큰 교체하고 인접 `show_save_and_add_another`/`can_save_and_add_another`는 손대지 않으면 안전. 컨텍스트 dict의 다른 키 계산을 건드리지 않는 것이 핵심.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점은 (a) "안전빵"으로 `has_add_permission and has_change_permission` 둘 다 끼워넣기 — FAIL_TO_PASS는 통과하지만(테스트가 교체/추가를 구별 못 함) 골드 의도(중복 제거, add-only)와 어긋남. 피하는 법: hints의 "Checking only has_add_permission should be enough"를 읽고 *교체*로 결정. (b) 과거 #3817 이력에 휩쓸려 인접 `show_save_and_add_another` 경로를 고치는 오localize. 피하는 법: 이슈가 지목한 정확한 키 `show_save_as_new`만 손대기.
