---
instance_id: django__django-16877
repo: django/django
base_commit: 98f6ada0e2058d67d91fb6c16482411ec2ca0967
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-05-19T23:11:10Z
fail_to_pass: 4
pass_to_pass: 0
gold_files: [django/template/defaultfilters.py]
---

# django__django-16877

## 문제 요약
`#34574`의 후속으로, 보안팀 논의 끝에 새 템플릿 필터 `escapeseq`를 추가해 달라는 기능 요청이다. `safeseq`가 `safe`의 시퀀스 버전인 것처럼, `escapeseq`는 `escape`의 시퀀스 버전이어야 한다. 즉 `{{ some_list|escapeseq|join:"," }}`처럼 join 전에 리스트의 각 원소를 개별적으로 이스케이프할 수 있어야 하며, 특히 autoescape가 꺼진 컨텍스트에서 유용하다.

## 유형 분류
- 버그 카테고리: 누락처리 (missing feature — 신규 필터 부재)
- 서브시스템: django template engine / default filters
- 증상 타입: 잘못된 출력 (autoescape off에서 리스트 원소가 이스케이프되지 않음, 또는 필터 자체가 없어 `Invalid filter`)
- 로컬라이제이션 신호: problem_statement가 "template filter", "safeseq", "escape"를 명시 → 기존 `safeseq`/`escape_filter`가 정의된 `django/template/defaultfilters.py`로 직결된다.

## 골드패치 분석
- 건드린 파일/함수: `django/template/defaultfilters.py` : 신규 `escapeseq(value)` (`@register.filter(is_safe=True)`)
- 근본 원인: 단일 값용 `escape`/`force_escape`와 시퀀스용 `safeseq`는 있었지만, 시퀀스 각 원소를 이스케이프하는 대응물이 없었다. autoescape off에서 리스트를 join하면 원소가 그대로 노출되어 XSS 위험이 있다.
- 수정 요지: `escape_filter` 정의 바로 뒤에 `escapeseq` 필터를 추가한다. 구현은 `[conditional_escape(obj) for obj in value]` — 시퀀스를 순회하며 각 원소에 `conditional_escape`를 적용한 리스트를 반환한다. `conditional_escape`를 쓰므로 이미 `mark_safe`로 안전 표시된 원소는 이중 이스케이프하지 않는다. `is_safe=True`로 등록해 결과가 다시 이스케이프되지 않도록 한다.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작: 신규 파일 `tests/template_tests/filter_tests/test_escapeseq.py`의 4개 테스트.
  - `test_basic`: autoescape on, `["x&y","<p>"]`와 `[mark_safe("x&y"), mark_safe("<p>")]` → `"x&amp;y, &lt;p&gt; -- x&y, <p>"` (safe 원소는 그대로).
  - `test_autoescape_off`: `{% autoescape off %}`에서도 동일 출력 → escape가 필터 자체에서 일어남을 증명.
  - `test_chain_join` / `test_chain_join_autoescape_off`: `escapeseq|join:"<br/>"` 체인이 두 모드 모두 `"x&amp;y<br/>&lt;p&gt;"`.
- 픽스 증명 방식: 같은 입력을 autoescape on/off 두 환경에서 렌더해 동일 결과가 나오는지 비교한다. `conditional_escape`가 원소 단위로 적용되므로 autoescape 설정과 무관하게 일관되며, `mark_safe` 원소는 이스케이프되지 않는 분기까지 커버한다.

## 공략 포인트 (뭘 조져야)
- 어디부터: `defaultfilters.py`에서 `safeseq`와 `escape_filter`/`force_escape`를 grep해 등록 패턴(`@register.filter`, `is_safe=True`)을 그대로 따른다. `safeseq`(각 원소 `mark_safe`)를 미러링하되 `mark_safe`를 `conditional_escape`로 바꾸는 게 핵심.
- 함정/난이도: 단일파일·소규모지만 (1) `escape`(force-escape)가 아닌 `conditional_escape`를 써야 safe 원소 보존과 이중 이스케이프 방지가 동시에 성립한다. (2) `is_safe=True`를 빠뜨리면 결과 리스트가 다시 이스케이프돼 출력이 틀어진다. (3) 신규 테스트 파일을 만들어야 하므로 FAIL_TO_PASS가 "존재하지 않는 테스트"임을 인지해야 한다.
- 우리 에이전트 관점: 기능 추가형이라 localization은 쉽지만, `escape` vs `force_escape` vs `conditional_escape` 중 정확한 함수 선택에서 막힐 수 있다. autoescape off 동등성이라는 의도를 놓치면 `escape`를 골라 mark_safe 케이스(`test_basic`의 `b`)에서 회귀한다.
