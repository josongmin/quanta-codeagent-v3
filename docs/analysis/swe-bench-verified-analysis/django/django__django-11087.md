---
instance_id: django__django-11087
repo: django/django
base_commit: 8180ffba21bf10f4be905cb0d4890dc2bcff2788
version: "3.0"
difficulty: 15 min - 1 hour
created_at: 2019-03-16T22:59:57Z
fail_to_pass: 1
pass_to_pass: 41
gold_files: [django/db/models/deletion.py]
---

# django__django-11087

## 문제 요약
`.delete()`가 연쇄(cascade) 삭제 그래프를 만들 때, 관련 객체를 SELECT하면서 모든 컬럼을 가져온다. 삭제에는 PK와 참조(FK)되는 필드만 필요한데도 큰 TextField 같은 불필요한 필드까지 fetch한다. 사용자(treeherder)는 Python 3 + mysqlclient 환경에서 `text_log_error.line`의 깨진 바이트를 디코드하다 `UnicodeDecodeError`로 `.delete()`가 크래시했고, 삭제에 필요 없는 필드는 애초에 SELECT하지 말아야 한다고 요청했다.

## 유형 분류
- 버그 카테고리: 누락처리 / 성능 최적화 (불필요한 컬럼 fetch)
- 서브시스템: django ORM — cascade deletion collector (`django.db.models.deletion`)
- 증상 타입: 크래시(UnicodeDecodeError) 겸 성능 저하 — 삭제에 불필요한 컬럼을 SELECT
- 로컬라이제이션 신호: traceback이 `deletion.py:223 collect` → `elif sub_objs:` → 전체 컬럼 SELECT을 정확히 가리킴. hints에서 메인테이너(charettes)가 "deletion collector가 SELECT로 그래프를 만들며, 참조되는 필드만 가져오면 된다"고 직접 위치를 짚어줌.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/deletion.py` — `Collector._has_signal_listeners` (신규), `Collector.can_fast_delete`, `Collector.collect`
- 근본 원인: `collect()`가 관련 객체를 `related_objects()`로 가져온 뒤 `on_delete` 핸들러에 그대로 넘기는데, 이 queryset이 모델의 전체 필드를 SELECT한다. 삭제 그래프 구축에는 PK와 자식이 참조하는 FK 필드만 있으면 충분하다.
- 수정 요지:
  - `pre_delete`/`post_delete` 리스너 존재 체크를 `_has_signal_listeners()` 헬퍼로 추출해 `can_fast_delete`와 공유.
  - `collect()`의 `elif sub_objs:` 분기를 `else:`로 바꾸고, 시그널 수신자가 없고 `select_related`도 안 걸린 경우에 한해, `get_candidate_relations_to_delete()`로 해당 모델을 참조하는 FK들의 `foreign_related_fields`만 모아 `sub_objs.only(*referenced_fields)`로 fetch 컬럼을 축소.
  - `from itertools import chain` 추가로 참조 필드 attname을 평탄화 수집.
  - 시그널 수신자가 연결되면 사용자에게 객체 전체가 노출되므로 최적화를 비활성화(전체 필드 유지).

## 검증 (test_patch)
- FAIL_TO_PASS: `test_only_referenced_fields_selected` — cascade 삭제 SELECT가 참조되는 필드만 선택하는지 확인.
- 증명 방식: `tests/delete/models.py`에 `Origin`/`Referrer`(`unique_field` unique, `large_field` TextField)/`SecondReferrer`(`referrer` FK + `to_field='unique_field'` FK)를 추가. `origin.delete()` 시 캡처된 첫 쿼리 SQL이 `Referrer.objects.only('id', 'unique_field')...`의 SQL과 정확히 일치해야 한다 — 즉 `large_field`는 SELECT되지 않음. 반대로 `pre_delete`/`post_delete` 시그널을 connect하면 SQL에 `large_field`가 포함됨을 `assertIn`으로 확인(subTest 2종). `to_field` FK 덕분에 PK뿐 아니라 `unique_field`도 참조 필드로 포함되는 점까지 검증.

## 공략 포인트 (뭘 조져야)
- 어디부터: traceback이 `deletion.py`의 `collect()` 내부 `elif sub_objs:` 라인을 직접 가리키므로 그 분기와 `related_objects()`가 만드는 queryset의 fetch 범위를 봐야 함.
- 함정/난이도 메모:
  - 단순히 `.only('id')`로 PK만 남기면 `to_field` FK(`SecondReferrer.other_referrer`가 `unique_field` 참조) 케이스가 깨진다 — 반드시 `get_candidate_relations_to_delete()`로 실제 참조되는 모든 필드를 수집해야 함.
  - 시그널(`pre_delete`/`post_delete`) 수신자가 있으면 객체가 사용자 코드에 노출되므로 deferring을 끄는 가드가 필수(안 그러면 시그널 핸들러에서 누락 필드 접근 시 추가 쿼리/오작동).
  - `select_related`가 걸린 경우도 제외 — `only()`와 상호작용이 까다로워 골드가 의도적으로 회피.
- 우리 에이전트 관점: PK-only로 끝내고 `to_field`/`select_related`/시그널 엣지케이스를 놓치면 PASS_TO_PASS(41건, 특히 OnDeleteTests/FastDeleteTests)에서 회귀가 터진다. 최적화 범위를 좁게 게이팅하는 세 조건을 모두 재현하는 게 난이도의 핵심.
