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
---

# django__django-12273

## 문제 요약
멀티테이블 상속(MTI)에서 자식 모델의 PK를 `None`으로 리셋해도 동작하지 않는다. `Derived(Item)`처럼 부모를 상속한 객체에서 `self.pk = None` (또는 `self.uid = None`)을 한 뒤 `save()`를 호출하면, 새 객체가 생성되는 대신 기존 행이 그대로 덮어써진다. 사용자는 MTI 객체를 복제(copy)하려는 의도였으나, parent_link FK(`item_ptr_id`)가 여전히 옛 PK를 가리키고 있어 새 row가 만들어지지 않는다.

## 유형 분류
- 버그 카테고리: 누락처리 (MTI parent_link 동기화 누락)
- 서브시스템: django ORM / models.Model PK descriptor, 멀티테이블 상속
- 증상 타입: silent-wrong (예외 없이 기존 데이터가 덮어써짐, 데이터 손실 위험)
- 로컬라이제이션 신호: "setting the primary key to None", `self.pk = None`, parent_link, `item_ptr` 언급 → `pk` property setter인 `Model._set_pk_val`로 직결. hints_text에 base.py `_set_pk_val` diff가 거의 그대로 제시됨.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/base.py` : `Model._set_pk_val`
- 근본 원인: `pk`는 `property(_get_pk_val, _set_pk_val)`인데 기존 setter는 `setattr(self, self._meta.pk.attname, value)` 단 한 줄로 자식 자신의 pk attname만 세팅했다. MTI에서 자식의 PK는 사실 부모를 가리키는 OneToOne parent_link(`*_ptr_id`)이며, `pk=None`을 해도 부모 링크 FK는 옛 값을 유지 → save 시 UPDATE로 처리되어 기존 행을 덮어씀.
- 수정 요지: setter에서 `self._meta.parents.values()`를 순회하며 각 `parent_link`에 대해, 그것이 자기 pk가 아닐 때 `setattr(self, parent_link.target_field.attname, value)`로 부모 측 타깃 필드까지 함께 값을 전파한다. 다단계 상속(여러 parent)도 `parents` 맵 순회로 모두 커버되고, `parent_link != self._meta.pk` 가드로 자기 자신/비-parent 케이스의 잘못된 덮어쓰기를 방지한다.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_create_new_instance_with_pk_equals_none`: `Profile`(User 상속)에서 `p2.pk = None; p2.user_ptr_id = None`, username 변경 후 save → Profile.count()==2, 원본 User('john')이 보존됨.
  - `test_create_new_instance_with_pk_equals_none_multi_inheritance`: 다단계 상속 `Congressman(Politician(Person))`에서 `pk=None`, `id=None`, `politician_ptr_id=None` 후 save → Congressman.count()==2, 원본 Person/Politician 데이터('John', 'senator 1') 보존.
- 증명 방식: 픽스 전에는 parent_link FK가 옛 PK를 유지해 save가 기존 row를 UPDATE → count가 1로 남고 원본이 'Bill'/'senator 2'로 덮여 실패. 픽스 후 `pk=None` 전파로 parent_link도 None이 되어 INSERT가 일어나 새 row 생성, 원본 보존 단언이 통과.

## 공략 포인트 (뭘 조져야)
- localization 전략: `pk = property(...)`로 시작 → `_set_pk_val` 한 줄짜리 setter가 핵심 진입점. `_meta.parents`가 MTI parent_link 매핑을 들고 있다는 점을 알아야 한다.
- 함정/난이도 메모: hints_text가 보여주듯 순진한 첫 시도(`while getattr(field, 'parent_link', ...)` 체인 따라가기)는 다단계 상속과 일부 케이스에서 깨졌다. 정답은 체인 추적이 아니라 `parents.values()` 전수 순회 + `parent_link and parent_link != self._meta.pk` 가드. `_get_pk_val`과의 대칭이 깨지는 점(getter는 안 건드림)을 받아들여야 함. 단일 파일 3줄 수정이지만 _meta 내부 구조 이해가 관건.
- 우리 에이전트 관점: 증상("save가 덮어씀")만 보고 save()/QuerySet 쪽을 파면 길을 잃는다. PK descriptor setter라는 진짜 chokepoint로 좁히고, `parents` 맵이 단일/다단계 상속을 모두 커버한다는 사실을 검증해야 함. 가드 조건 누락 시 PASS_TO_PASS 회귀(예: `test_use_explicit_o2o_to_parent_as_pk`) 발생 위험.
