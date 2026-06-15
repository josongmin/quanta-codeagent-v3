---
instance_id: django__django-12143
repo: django/django
base_commit: 5573a54d409bb98b5c5acdb308310bed02d392c2
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2019-11-25T14:38:30Z
fail_to_pass: 1
pass_to_pass: 52
gold_files: [django/contrib/admin/options.py]
primary_type: T-LocTrivial
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [overfit-risk, has-repro]
---

# django__django-12143

## 문제 요약
admin changeform 뷰에서 `list_editable` 일괄 편집 시, 수정된 객체의 PK를 골라내기 위해 POST 키를 정규식으로 매칭한다(`ModelAdmin._get_edited_object_pks`). 이 정규식을 formset `prefix` 값으로 문자열 포매팅해 만드는데(`r'{}-\d+-{}$'.format(prefix, ...)`), formset prefix에는 정규식 특수문자(`$`, `.`, `*` 등) 제약이 없다. prefix에 메타문자가 들어가면 패턴이 의도와 다르게 해석되어 일부 행이 매칭에서 누락되고, 결국 편집된 객체가 저장 대상에서 빠져 데이터 손실(silent-wrong)이 발생한다. 보고자는 `re.escape()` 한 줄 수정을 제안했고, 이 버그는 명시적으로 회귀(b18650a2에서 도입)다.

## 유형 (정형화)

- **L0 (Pinpointed)** — problem_statement가 파일(`admin/options.py`), 라인(L1634), 그리고 문제의 코드 한 줄(`pk_pattern = re.compile(r'{}-\d+-{}$'.format(prefix, self.model._meta.pk.name))`)을 그대로 인용한다. `_get_edited_object_pks` 또는 `re.compile(r'{}-\d+-` grep 한 방이면 도달. 탐색 비용 0.
- **S1 (Direct-Map)** — 정형 결함클래스(신뢰 불가 입력의 raw 정규식 주입 = unescaped-regex-injection)에 `re.escape()` 템플릿이 곧바로 매칭된다. 이슈 본문이 픽스("use `re.escape()`")를 사실상 명세한다. 새 조건식을 추론 합성(S2)할 필요도, 테스트로 후보를 수렴(S3/S4)할 필요도 없다. 어느 인자를 escape할지만 정하면 끝.
- **K-Gen** — 필요한 지식은 "정규식 메타문자와 `re.escape`"라는 일반 파이썬 표준라이브러리 상식이다. django ORM/query-compiler 같은 프레임워크 내부 도메인지식(K-Domain)은 불필요. admin/formset은 맥락일 뿐 픽스 도출에 도메인 추론이 들어가지 않는다.

**primary type = T-LocTrivial**: L0 + S1, 픽스가 이슈에 적혀 있고 위치가 핀포인트. 찾으면 끝, 픽스 자명한 전형. APR 관점에서 이건 template-based repair(PAR/TBar 계열) 중에서도 가장 깨끗한 케이스 — 결함 패턴(format-into-regex without escape)이 곧 수리 트랜스폼(`re.escape(arg)` 삽입)으로 1:1 사상된다. S2의 "각도(angelic) 조건 합성"이나 G&V의 반복 검증이 전혀 개입하지 않으므로 S1이 dominant.

## 난이도 티어

**T2 (쉬움)**. 이 티어로 미는 구조적 피처:
- patch scope: 1파일, 실질 1헌크, 효과적 1줄 변경(format 인자에 `re.escape(prefix)` 적용 — 골드는 가독성상 멀티라인으로 풀었을 뿐). 1파일·<5줄 컷(≈48% solve 구간)의 가장 쉬운 쪽.
- localize 직접성: L0(이슈가 라인까지 인용) — 거의 모든 easiness를 만든다.
- has-repro: test_patch가 `prefix='form$'`라는 결정적 재현 입력을 제공(가장 강한 easiness 신호).

T1이 아니라 T2인 이유: (1) **escape 범위를 골라야 하는 미세 판단** — `prefix`만 escape하고 `self.model._meta.pk.name`은 그대로 둬야 한다. pk.name은 식별자 규칙상 안전하므로 escape하면 안 되고, 패턴 전체를 escape하면 `-\d+-`·`$` 앵커까지 죽는다. (2) **과잉수정 유혹** — 이슈가 "git grep으로 ~200개 re.compile 사이트가 있다, 다른 데도 있을지 모른다"고 명시하므로, 골드가 이 한 곳만 고치는 절제를 놓치면 오답. 이 두 트랩이 순수 T1(이슈가 픽스를 완전히 받아쓰게 해주는)보다는 한 칸 위다.

공식 라벨("15min-1hour")과의 차이: 공식은 개발자 구현시간 기준이라 PR 작성·테스트 추가·회귀 확인 시간을 포함한다. 에이전트 난이도 기준으로는 localize가 공짜이고 픽스가 이슈에 적혀 있어 T2가 적정 — 공식 라벨이 약간 과대다.

## 골드패치 분석

- **건드린 파일·함수**: `django/contrib/admin/options.py` → `ModelAdmin._get_edited_object_pks(self, request, prefix)`
- **근본 원인**: `prefix`를 `re.escape` 없이 정규식 패턴 문자열에 직접 박아 넣음. prefix가 `form$`처럼 메타문자를 포함하면 `r'form$-\d+-uuid$'` 같은 패턴이 되어 중간의 `$`가 라인 앵커로 해석된다. 그 결과 `form$-0-uuid` 같은 실제 POST 키가 매칭 실패 → 편집된 PK가 수집되지 않음 → `_get_list_editable_queryset`이 해당 객체를 누락 → 저장 시 그 행이 빠지는 데이터 손실.
- **수정 요지**: format 인자 중 `prefix`만 `re.escape(prefix)`로 감싸 메타문자를 리터럴로 처리.
  ```python
  pk_pattern = re.compile(
      r'{}-\d+-{}$'.format(re.escape(prefix), self.model._meta.pk.name)
  )
  ```
  `self.model._meta.pk.name`은 Python 식별자 규칙을 따라 정규식 안전하다고 보고 의도적으로 escape하지 않음. 정규식 구조(`-\d+-`, 끝 `$` 앵커)는 그대로 유지.

## 검증 (test_patch)

- **FAIL_TO_PASS (1개)**: `test_get_list_editable_queryset_with_regex_chars_in_prefix` (admin_changelist.tests.ChangeListTests)
- **픽스 증명**: 테스트가 prefix를 `'form$'`로 두고 POST 데이터 키도 `form$-TOTAL_FORMS`, `form$-0-uuid=<a.pk>`, `form$-0-load=10` 등 동일 prefix로 구성한 뒤 `_get_list_editable_queryset(request, prefix='form$')`의 결과 `queryset.count()`가 1(편집된 Swallow A 하나)인지 검증. 패치 전: `$`가 앵커로 해석되어 `form$-0-uuid` 키 매칭 실패 → PK 미수집 → count≠1. 패치 후: `re.escape('form$')='form\$'`로 `$`가 리터럴이 되어 정확히 1개 매칭.
- **overfit 관점**: FAIL_TO_PASS가 1개이고 메타문자 `$` 한 종류만 직접 검사하므로 테스트 스위트가 얇다(`overfit-risk`). 원리상 `prefix.replace('$','\\$')` 같은 special-case로도 이 단일 테스트는 통과할 수 있다. 그러나 골드의 `re.escape`는 모든 정규식 메타문자(`. * + ? [ ] ( ) { } | ^`)를 일괄 처리하는 올바른 일반화이므로 overfit이 아니다.
- **regression 관점**: PASS_TO_PASS 52개 중 핵심 짝은 `test_get_list_editable_queryset`(prefix=`'form'`, 메타문자 없음) — escape를 적용해도 평범한 식별자 prefix는 그대로 매칭되어야 함을 보증한다. 나머지는 changelist 전반(검색/필터/페이지네이션/distinct 등) 광범위 회귀 가드. `re.escape`는 메타문자 없는 입력에 대해 항등에 가깝게 동작하므로 이 회귀 표면을 건드리지 않는다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 `admin/options.py` L1634와 문제 라인을 인용 → `re.compile(r'{}-\d+-` 또는 `_get_edited_object_pks`를 grep → 단일 함수 `ModelAdmin._get_edited_object_pks` 한 곳으로 즉시 수렴. cross-file 추적 불필요.
2. **픽스와 일반화 근거**: format 인자 `prefix`를 `re.escape(prefix)`로 감싼다. prefix는 사용자가 자유롭게 지정 가능(formset prefix 제약 없음)하므로 신뢰 불가 입력이고, `re.escape`가 모든 메타문자 클래스를 리터럴화하므로 `$` 한 종류가 아니라 입력공간 전체를 커버하는 올바른 일반화다. pk.name은 식별자 규칙상 안전 + escape하면 식별자 매칭이 깨질 수 있으므로 의도적으로 손대지 않는 것이 정확한 최소수정.
3. **regression 안전**: `test_get_list_editable_queryset`(prefix=`'form'`)을 비롯한 메타문자 없는 기존 경로가 깨지지 않아야 한다. `re.escape`는 영숫자·`-`·`_`에 대해 결과를 바꾸지 않으므로(항등에 가까움) 안전. 광범위한 changelist P2P(52개)는 이 함수와 무관하거나 평범한 prefix를 쓰므로 영향 없음.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) "데이터 손실"이라는 문구에 끌려 트랜잭션/`save_related`/formset save 경로를 뒤지면 오답 방향. 실제 발생점은 PK 수집 정규식 단 한 곳. (b) 패턴 전체나 `pk.name`까지 escape하면 `-\d+-`·끝 `$` 앵커가 죽어 회귀. **`prefix`만** escape해야 함. (c) 이슈가 언급한 "~200개 다른 re.compile 사이트"를 따라 다른 파일까지 광범위 수정하면 과잉수정 — 골드는 이 한 곳만 고친다(보고자도 다른 동일 패턴은 못 찾았다고 명시). 최소·국소 수정을 지키는 것이 핵심.
