---
instance_id: django__django-15368
repo: django/django
base_commit: e972620ada4f9ed7bc57f28e133e85c85b0a7b20
version: 4.1
difficulty: <15 min fix
created_at: 2022-01-27T13:44:35Z
fail_to_pass: 1
pass_to_pass: 29
gold_files: [django/db/models/query.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-15368

## 문제 요약
모델 인스턴스 필드에 평범한 `F('...')` 표현식을 할당한 뒤 `bulk_update()`로 저장하면, F()가 컬럼명으로 resolve되지 않고 `F(name)`라는 문자열 repr 그대로 SQL에 박혀버린다. 즉 `SET "c8" = 'F(name)'` 같은 잘못된 UPDATE가 생성된다(silent-wrong: 예외 없이 데이터만 틀림). 사용자는 `o.c8 = F('name')` 후 bulk_update하면 c8 컬럼이 name 컬럼 값으로 갱신되길 기대했다. problem_statement는 GitHub 퍼머링크로 `django/db/models/query.py` L673의 type check를 범인으로 직접 지목하고, 해결책 후보 두 개(`hasattr(attr, 'resolve_expression')` 혹은 `isinstance(attr, (Expression, F))`)까지 명시한다.

## 유형 (정형화)
- **L = L0 (Pinpointed)** — 이슈가 파일(`django/db/models/query.py`)·정확한 라인(L673)·범인 표현(`isinstance(attr, Expression)`)을 퍼머링크로 지목. localize는 grep 한 방, 사실상 노력 0.
- **S = S1 (Direct-Map)** — 이슈가 픽스를 그대로 적어준다. "너무 좁은 nominal 타입 체크"라는 정형 결함클래스(type-check too narrow)에 템플릿 매칭되며, 수정은 가드 조건 한 줄 교체. 후보 추론·반복 탐색 불필요. APR 관점에서 PAR/TBar식 결함패턴-수정템플릿("isinstance를 capability(hasattr) 체크로 완화")에 1:1 대응하므로 S2(식 합성)가 아니라 S1이다. 골드가 두 후보 중 더 일반적인 duck-typing을 택한 것도 "조건을 합성"한 게 아니라 기성 관용구(`resolve_expression` 보유 여부) 적용일 뿐.
- **K = K-Domain** — 일반 파이썬 추론만으론 부족. `F`가 `Expression`의 서브클래스가 아니라는 점, 그리고 django ORM에서 "표현식인지"를 nominal 타입이 아니라 `resolve_expression` 메서드 보유(duck-typing)로 판별하는 게 코드베이스 전반의 관례("check resolve_expression like elsewhere", hints_text)라는 도메인 지식이 올바른 일반화를 결정한다.
- **primary type = T-DirectMap** — 위치 명확(L0) + 기계적 픽스(S1, 타입체크 완화). T-LocTrivial은 K-Gen 전제라 배제(여기는 K-Domain). T-DomainBound는 "지식이 병목"일 때인데, 여기선 지식이 *어느 후보가 더 robust한가*만 좌우할 뿐 픽스 위치·형태는 이슈가 다 줘서 병목이 아니다 → DirectMap이 dominant.

## 난이도 티어
- **티어 = T2 (쉬움).** 구조적 피처: 1파일·1헌크·핵심 1줄 변경, `has-repro`(네이티브 SQL 덤프까지 포함된 강한 easiness 신호), L0 직접 localize, S1 기계적 수정. 이 조합은 T1~T2 구간이다.
- **T1이 아닌 이유:** T1 프로파일은 K-Gen 전제. 이 문제는 "F가 Expression 서브클래스가 아니다 + resolve_expression이 관용 판별자"라는 django ORM 도메인 지식(K-Domain)이 올바른 일반화를 가르므로 순수 일반추론(T1)보다 반 칸 위. 또한 PASS_TO_PASS 29개(BulkUpdateTests/BulkUpdateNoteTests 전반: null 처리, FK, functions, custom pk, batch_size, json/ip/boolean field 등)가 인접 동작을 폭넓게 검증하므로 `regression-trap`이 약하게 존재 — Value 래핑 가드를 잘못 넓히면 기존 동작이 깨질 여지가 있다.
- **공식 라벨(<15 min fix)과의 정합:** 일치한다. 개발자 구현시간 기준 최소 구간이고, 에이전트 입장에서도 이슈가 픽스를 적어줘 막힐 여지가 거의 없다. 다만 공식 라벨은 "어느 후보가 더 robust한가"(overfit 회피)나 import 정리 같은 미세 품질축을 안 잡으므로, 그걸 반영해 T1이 아닌 T2로 둔다.

## 골드패치 분석
- **건드린 파일·함수:** `django/db/models/query.py` → `QuerySet.bulk_update()` (그리고 모듈 상단 import 한 줄).
- **근본 원인:** bulk_update는 각 객체의 필드 값을 `When(pk=obj.pk, then=attr)`로 감싸 `Case` statement를 만들기 전에 "이미 표현식이면 `Value`로 감싸지 말자"를 판단한다. 그 가드를 `if not isinstance(attr, Expression):`로 했는데, `F`는 `Expression`의 서브클래스가 아닌 별도 클래스다. 따라서 `F('name')`이 표현식이 아닌 일반 스칼라로 오판되어 `Value(F('name'), output_field=field)`로 감싸지고, F의 `__repr__`("F(name)")이 리터럴 문자열로 SQL에 들어간다.
- **수정 요지:** 좁은 nominal 체크를 capability(duck-typing) 체크로 교체.
  `if not isinstance(attr, Expression):` → `if not hasattr(attr, 'resolve_expression'):`
  `resolve_expression`을 가진 모든 객체(F·Expression·Func·Combinable 등 ORM 표현식 전반)를 Value 래핑에서 제외한다. 이로써 `attr`은 When절에서 그대로 컬럼 참조 표현식으로 resolve된다. 부수적으로 더 이상 참조되지 않는 `Expression`을 `from django.db.models.expressions import ...` 줄에서 제거했다(테스트엔 무관, lint/관용 정리).

## 검증 (test_patch)
- **FAIL_TO_PASS (1):** `test_f_expression (queries.test_bulk_update.BulkUpdateTests)`.
- **픽스 증명:** `note='test_note', misc='test_misc'`인 `Note` 10개를 만든 뒤 각 인스턴스에 `note.misc = F('note')`를 설정하고 `Note.objects.bulk_update(notes, ['misc'])` 실행. 픽스 전에는 misc 컬럼에 `'F(note)'` 리터럴이 들어가 `filter(misc='test_note')`가 0건 → 실패. 픽스 후 `F('note')`가 note 컬럼으로 resolve되어 misc가 `'test_note'`로 갱신, `assertCountEqual(Note.objects.filter(misc='test_note'), notes)`가 10개 전부 매칭 → 통과.
- **overfit 관점:** FAIL_TO_PASS는 1개로 얇지만, 골드의 duck-typing 수정은 F 한 케이스를 넘어 `resolve_expression`을 가진 모든 표현식으로 일반화되므로 special-case overfit이 아니다. 단, `isinstance(attr, (Expression, F))`로도 이 테스트는 통과하므로 단일 테스트는 픽스를 약간 과소명세(S4적 측면)한다 — 그럼에도 골드는 더 넓은 capability 체크를 택해 overfit을 회피했다. `overfit-risk` 플래그를 굳이 켜지 않은 이유: 이슈 본문이 올바른 일반화(`resolve_expression`)를 직접 제시하기 때문.
- **regression 관점:** PASS_TO_PASS 29개가 bulk_update의 인접 동작(null set, mixed null, functions, FK lookup, custom pk/db_columns, batch_size, json/ip/boolean/datetime field 등)을 검증한다. 가드를 `isinstance(Expression)` → `hasattr(resolve_expression)`로 *넓히는* 방향이므로, 기존에 Value 래핑되던 스칼라들은 여전히 래핑되고(스칼라는 resolve_expression 없음), 기존에 표현식으로 처리되던 것들도 그대로 표현식으로 남는다 → 회귀 없음. 핵심은 "기존 통과 케이스를 더 좁히지 않는다"는 점.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈가 퍼머링크로 `django/db/models/query.py` L673을 직접 준다. 신호 없이도, `bulk_update` 본문에서 `when_statements`/`When`/`Case`를 구성하는 루프를 찾고, 값을 `Value(...)`로 감쌀지 결정하는 가드 조건 `if not isinstance(attr, Expression):`에 도달한다. 증상("F의 repr이 리터럴로 박힘")이 곧 "표현식이 Value로 잘못 래핑됨"을 가리키므로 가드 조건이 유일 용의자.
2. **픽스와 올바른 일반화:** nominal `isinstance(attr, Expression)`을 capability `hasattr(attr, 'resolve_expression')`로 교체. 이게 올바른 일반화인 이유 — django ORM에서 "쿼리에 합성 가능한 표현식"의 진짜 계약은 `Expression` 상속이 아니라 `resolve_expression()` 메서드 보유다(코드베이스 다른 곳도 이 관례를 씀). `F`뿐 아니라 `Func`, 조합식 등 어떤 표현식도 한 번에 커버되어 미래의 표현식 타입까지 견고. `isinstance(attr, (Expression, F))`는 F만 땜질하는 special-case라 같은 클래스의 다음 버그를 재발시킬 수 있다.
3. **regression 안전:** PASS_TO_PASS의 null/mixed-null/functions/FK/custom-pk/batch 케이스를 안 깨야 한다. 수정이 가드를 *완화*(더 많은 것을 "표현식"으로 인정)하는 방향이고 스칼라 값은 `resolve_expression`이 없어 여전히 Value로 감싸지므로, 기존 스칼라 경로·null 경로가 그대로 보존됨을 확인하면 안전.
4. **함정 회피:** (a) 더 좁은 후보 `isinstance(attr, (Expression, F))`로 끝내면 FAIL_TO_PASS는 green이지만 overfit — `resolve_expression` duck-typing을 택해야 robust(오라클 없는 에이전트가 빠지기 쉬운 함정). (b) 수정 후 `Expression`이 미사용 import가 되므로 import 줄에서 제거해야 관용/lint에 맞는다(테스트 통과엔 무관하나 골드와 동등한 품질을 내려면 필요). (c) 가드를 과하게 넓혀(예: 모든 객체를 표현식 취급) 스칼라 Value 래핑을 깨면 PASS_TO_PASS가 무너진다 — `resolve_expression` 보유 여부라는 정확한 경계를 지킬 것.
