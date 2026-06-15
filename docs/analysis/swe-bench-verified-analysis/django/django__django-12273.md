---
instance_id: django__django-12273
repo: django/django
base_commit: 927c903f3cd25c817c21738328b53991c035b415
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2020-01-03T18:47:56Z
fail_to_pass: 2
pass_to_pass: 27
gold_files: [django/db/models/base.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro, underspecified]
---

# django__django-12273

## 문제 요약
멀티테이블 상속(MTI)에서 자식 모델의 PK를 `None`으로 리셋해도 동작하지 않는다. `Derived(Item)`처럼 부모를 상속한 객체에서 `self.pk = None`(또는 `self.uid = None`)을 한 뒤 `save()`를 호출하면, 새 객체가 INSERT되는 대신 기존 행이 그대로 UPDATE로 덮어써진다(silent data loss). 사용자 의도는 MTI 객체의 복제(copy)였으나, parent_link FK(`item_ptr_id`)가 여전히 옛 PK를 가리키고 있어 ORM이 이를 기존 row로 인식한다. 이슈 본문에 재현 코드(`Item`/`Derived`/`SaveTestCase`)가 첨부되어 있고, hints_text에서 메인테이너가 `_set_pk_val` 후보 패치를 직접 제시했다 — 단, 첫 후보(`while parent_link` 체인 추적)는 다단계 상속에서 깨졌다.

## 유형 (정형화)
- **L1 (Traceable)** — 이슈가 정확한 심볼을 지목하진 않지만 "setting the primary key to None", `self.pk = None`, `item_ptr`라는 강한 키워드가 `pk` descriptor로 좁은 단일파일(`base.py`) 후보를 만든다. `pk = property(_get_pk_val, _set_pk_val)`까지 grep 두어 번. grep 한 방(L0)은 아닌 이유는, 증상 표면(`save()`가 덮어씀)에서 출발하면 `save()`/`QuerySet`/`_do_update`로 새다가 PK setter라는 진짜 chokepoint로 수렴하는 데 약간의 추론이 필요하기 때문.
- **S2 (Constraint-Reasoning) +S5 (Spec-Inference)** — 고칠 지점(`_set_pk_val`)은 좁혀지지만, 올바른 식을 **추론으로 합성**해야 한다. 단순히 "한 줄 더 setattr"가 아니라, MTI에서 자식 pk가 곧 parent_link FK라는 불변식을 따져 `_meta.parents.values()` 전수 순회 + `parent_link and parent_link != self._meta.pk` 가드를 도출해야 한다. hints가 보여준 순진한 체인 추적(S1식 템플릿)은 다단계 상속에서 실패 — 즉 정형 결함클래스 매칭이 아니라 의미적 추론(S2)이 본질. +S5: `pk = None` 복제 트릭은 당시 Django 문서에 명세/embrace되지 않은(underspecified) 동작이라, "무엇이 올바른 동작인가"를 이슈 토론과 ORM 관례에서 재구성해야 한다(메인테이너도 "kind of break the symmetry with _get_pk"를 감수).
- **K-Domain** — `_meta.parents`(parent_link 매핑), `parent_link.target_field.attname`, MTI에서 PK==OneToOne parent FK라는 사실은 모두 django ORM 내부 지식. 일반 파이썬 추론(K-Gen)으로는 `parents` 맵의 존재와 의미를 알 수 없다 — 이게 병목이라 primary type을 K-Domain dominant로 본다.
- **Primary: T-DomainBound** — 위치는 한 줄짜리 setter로 좁고 패치도 3줄이지만, 진짜 난점은 "어떻게 고치나"의 프레임워크 내부지식(`_meta.parents` 구조, parent_link semantics)이다. constraint 추론(T-ConstraintReason)도 섞이나, 올바른 식을 막는 게 ORM 도메인지식이라 K-Domain을 dominant로 본다. APR 관점: 결함 위치가 명확하고 후보 패치 공간이 좁으므로 G&V(S3/S4)가 아니라 semantic synthesis(SemFix/Angelix 계열)가 맞고, 그 synthesis가 도메인 불변식에 의존한다.

## 난이도 티어
- **T4 (약간 어려움).** 구조적 피처:
  - **파일/줄수: 1파일·3줄** — scope만 보면 T2급(48% solve 구간).
  - **localize 직접성: L1** — repro가 있어 쉬워지지만, 증상→원인 chokepoint 전환에 약한 탐색 필요.
  - **K-Domain + S2 합성** — 티어를 끌어올리는 핵심. `_meta.parents` 순회와 가드 조건은 도메인지식 없이는 도출 불가. hints_text가 실증하듯 메인테이너조차 첫 두 후보(`while parent_link` 체인, 가드 없는 순회)가 다단계 상속·다중상속에서 깨졌다 — 즉 "그럴듯하지만 틀린" 패치가 다수인 overfit 인접 구간.
  - **regression-trap (P2P=27)** — `test_use_explicit_o2o_to_parent_as_pk`, `test_id_field_update_on_ancestor_change` 등 parent_link/pk 인접 동작 27개를 안 깨야 한다. 단, 이 P2P 테스트들은 `.pk =` 대입을 하지 않아(메타데이터 `assertEqual`만) `_set_pk_val`이 호출되지 않으므로 이 인스턴스에서 setter 변경으로 인한 회귀는 발생하지 않는다 — 가드(`parent_link != self._meta.pk`)는 방어적 정확성(`parents` 값 `None`·`parent_link==pk` 케이스 차단)으로 타당하나 '특정 P2P 회귀를 막는다'는 인과는 성립하지 않는다.
- **공식 라벨 "15 min - 1 hour"와의 차이**: 공식 라벨은 *정답을 아는 개발자의 구현시간*이라 3줄 수정에 부합한다. 그러나 그 라벨은 (a) 올바른 가드 식을 합성하는 추론비용과 (b) hints가 폭로한 "naive 패치가 다단계 상속에서 깨지는" 함정을 반영하지 못한다. 에이전트 관점에서는 이 두 요인이 T4로 민다(T3에 머무르지 않는 이유 = K-Domain 병목 + 검증된 naive-fail 사례).

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/base.py` : `Model._set_pk_val` (3줄 추가).
- **근본 원인**: `pk`는 `property(_get_pk_val, _set_pk_val)`인데, 기존 setter는
  ```python
  def _set_pk_val(self, value):
      return setattr(self, self._meta.pk.attname, value)
  ```
  단 한 줄로 자식 **자신의** pk attname만 세팅했다. MTI에서 자식의 PK는 실제로 부모를 가리키는 OneToOne parent_link(`*_ptr_id`, 예: `user_ptr_id`/`politician_ptr_id`)다. `pk=None`을 해도 parent_link FK는 옛 값을 유지 → `save()`가 해당 FK를 기존 PK로 보고 UPDATE → 원본 행을 덮어쓴다.
- **수정 요지**:
  ```python
  def _set_pk_val(self, value):
      for parent_link in self._meta.parents.values():
          if parent_link and parent_link != self._meta.pk:
              setattr(self, parent_link.target_field.attname, value)
      return setattr(self, self._meta.pk.attname, value)
  ```
  `_meta.parents`(즉시 부모 모델→parent_link 필드 매핑)를 순회하며 각 `parent_link.target_field.attname`(부모 측 PK attname)에 같은 값을 전파한다. `_meta.parents`는 **즉시(immediate) 부모만** 담으므로 이 루프가 직접 커버하는 것은 '여러 즉시부모'(breadth, 예: `Congressman`의 `Person`+`Politician` 동시 처리)이다. 먼 조상은 부모의 `_meta.parents`를 재귀해야 닿는다(`get_parent_list`가 `parent._meta`로 재귀하는 이유) — 다단계 깊이는 이 단일 루프의 '전수 순회'가 아니라 setter가 부모 인스턴스에 위임/재호출되는 경로로 커버된다. 가드 `parent_link and parent_link != self._meta.pk`는 (a) `parents` 값이 `None`인 케이스, (b) parent_link 자체가 자기 pk인 경우(explicit O2O를 pk로 쓰는 모델, 예: `test_use_explicit_o2o_to_parent_as_pk`)를 걸러 잘못된 덮어쓰기/회귀를 막는다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**:
  - `test_create_new_instance_with_pk_equals_none`: `Profile`(User 상속) 객체에서 `p2.pk = None; p2.user_ptr_id = None; p2.username='bill'; save()` → `Profile.objects.count()==2`, 원본 `User('john')` 보존 단언.
  - `test_create_new_instance_with_pk_equals_none_multi_inheritance`: **다중상속**(multiple inheritance) `class Congressman(Person, Politician)` — `Person`과 `Politician` 두 형제 concrete base를 동시에 상속(둘 다 `models.Model` 직속, `Politician`은 `Person`을 상속하지 않음)에서 `pk=None; id=None; politician_ptr_id=None` 후 save → `Congressman.count()==2`, 원본 `Person('John')`·`Politician('senator 1')` 데이터 보존. (테스트는 `Congressman`/`Politician` 모델을 import에 새로 추가.) 테스트 이름의 `_multi_inheritance`는 '여러 즉시부모'(다중)를 뜻하지 '테이블 깊이'(다단계)가 아니다 — 진짜 다단계 케이스는 `class Senator(Congressman)`이며 이 테스트에는 포함되지 않는다.
- **픽스 증명**: 픽스 전에는 자식 pk만 None이 되고 parent_link FK는 옛 PK 유지 → save가 UPDATE로 기존 row를 덮어 count가 1로 남고 원본이 'Bill'/'senator 2'로 오염 → 단언 실패. 픽스 후 `pk=None` 대입이 `parents` 순회로 모든 parent_link target_field까지 None을 전파 → save가 INSERT → 새 row 생성 + 원본 보존 단언 통과.
- **overfit 관점**: FAIL_TO_PASS가 2개로 얇지만, 단일상속(`Profile`)과 다중상속(`Congressman(Person, Politician)` — 여러 즉시부모, breadth) 두 케이스를 함께 잡아 special-case 패치를 배제한다. naive 체인 추적(`while parent_link`) 패치는 단일 경로만 따라가 형제 즉시부모 하나를 놓치므로 이 **다중상속** 케이스에서 깨진다 — 즉 두 번째 테스트가 사실상 구별용 입력(distinguishing input) 역할을 한다. (테이블 깊이=다단계 케이스 `Senator(Congressman)`는 이 테스트에 포함되지 않는다.) overfit 위험이 부분적으로 봉쇄됨(그래서 S4까지는 안 감).
- **regression 관점**: P2P 27개가 parent_link/pk 인접 동작을 광범위하게 커버. 다만 `test_use_explicit_o2o_to_parent_as_pk`/`test_use_explicit_o2o_to_parent_from_abstract_model`를 포함한 27개 P2P 어느 것도 `.pk =` 대입을 하지 않는다 — `_meta.pk.name`/`get_ancestor_link` 같은 메타데이터 `assertEqual`만 하므로 `_set_pk_val` 자체가 호출되지 않는다. 따라서 setter 변경에 따른 P2P 회귀는 이 테스트 인스턴스들에서 발생 불가다(전체 테스트파일에서 `.pk =` 대입은 신규 FAIL_TO_PASS 2개뿐: tests.py:567/578). 골드의 `parent_link != self._meta.pk` 가드는 (a) `parents` 값이 `None`인 케이스, (b) parent_link 자체가 자기 pk인 explicit-O2O 모델에서의 잘못된 덮어쓰기를 막는 **방어적 정확성**으로는 타당하나, 'hints의 "created some other test failures"를 막는 회귀 방지'라는 인과로 단정하기 어렵다(이 P2P들은 setter를 타지 않으므로).

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 `self.pk = None`·`item_ptr` 키워드 → `Model`에서 `pk = property(_get_pk_val, _set_pk_val)`를 찾는다. 증상("save가 덮어씀")이 아니라 *대입 지점*에서 출발하는 게 핵심: setter `_set_pk_val`이 자식 pk attname만 건드리고 parent_link FK를 안 건드린다는 걸 확인. `_meta.parents`가 MTI parent_link 매핑을 들고 있음을 ORM 지식으로 연결.
2. **픽스와 일반화 근거**: setter에서 `_meta.parents.values()`를 순회해 각 `parent_link.target_field.attname`에 같은 값을 전파. 이게 올바른 일반화인 이유 — (a) `parents` 맵은 모든 **즉시(immediate) 부모**를 담아 **다중상속(여러 즉시부모, breadth)을 구조적으로 커버**(특정 부모 개수 하드코딩 아님; `Congressman`의 `Person`+`Politician` 동시 처리), (b) chain-walk(`while parent_link`)의 단일 경로 추적과 달리 모든 즉시 부모를 분기 없이 순회해 다중상속에 안전, (c) `parent_link != self._meta.pk` 가드로 explicit-O2O-as-pk 모델을 정확히 배제. 다단계 깊이(예: `Senator(Congressman)`)는 이 단일 루프의 전수 순회가 아니라 부모 측 setter 위임/`_meta.parents` 재귀로 닿는다. 특정 테스트 통과용 special-case가 아니라 MTI PK 불변식("자식 pk 대입 == 모든 즉시 parent_link 동기화")을 코드화한 것.
3. **regression 안전**: 가드 두 조건(`parent_link` truthy + `!= self._meta.pk`)은 방어적 정확성을 보장한다 — (a) `parents` 값이 `None`인 케이스(base.py:266-268에서 실제 발생 가능), (b) parent_link 자체가 자기 pk인 explicit-O2O-as-pk 모델에서 target_field를 중복 세팅하는 오동작을 차단. 다만 P2P 27개는 어느 것도 `.pk =` 대입을 하지 않아 `_set_pk_val`을 타지 않으므로, '가드가 특정 P2P 회귀(예: `test_use_explicit_o2o_to_parent_as_pk`)를 막는다'고 단정할 수는 없다 — 그 테스트는 메타데이터 `assertEqual`만 한다. `test_id_field_update_on_ancestor_change`(parent_link 변경 시 id 갱신)는 전파 방향이 양립하므로 안전. 비-MTI 모델은 `parents`가 비어 setter가 byte-identical하게 동작.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 오답 — (i) 증상만 보고 `save()`/`_save_table`/`QuerySet`를 파다 길을 잃음(진짜 chokepoint는 PK descriptor). (ii) hints의 첫 후보처럼 `while getattr(field, 'parent_link', False)` 체인을 따라가는 패치 — 다단계/다중 상속에서 깨진다(메인테이너가 실증). (iii) `parents.values()`를 가드 없이 순회 — explicit-O2O-as-pk 모델에서 P2P 회귀. 회피법: `parents` 맵이 단일/다단계/다중을 모두 커버한다는 사실을 검증하고, `parent_link != self._meta.pk` 가드를 반드시 넣어 두 FAIL_TO_PASS와 27개 P2P를 동시에 만족시키는지 확인. `_get_pk_val`과의 대칭이 깨지는 건 의도된 trade-off로 받아들인다(getter는 미수정).
