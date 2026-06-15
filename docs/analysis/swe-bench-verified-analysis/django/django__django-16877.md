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
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [overfit-risk]
---

# django__django-16877

## 문제 요약
`#34574`의 후속으로, 보안팀 논의 끝에 새 템플릿 필터 `escapeseq`를 추가해 달라는 기능 요청이다. `safeseq`가 `safe`의 시퀀스 버전인 것처럼, `escapeseq`는 `escape`의 시퀀스 버전이어야 한다. 즉 `{{ some_list|escapeseq|join:"," }}`처럼 join 전에 리스트의 각 원소를 개별적으로 이스케이프할 수 있어야 하며, 특히 autoescape가 꺼진 컨텍스트에서 유용하다. 핵심 결함은 단일값용 `escape`와 시퀀스용 `safeseq`는 있지만, 시퀀스 각 원소를 이스케이프하는 대응물이 부재한다는 점이다(누락 기능).

## 유형 (정형화)
- **L (Localization) = L0** — problem_statement가 "template filter", "safeseq", "escape"를 직접 지목한다. `safeseq`/`escape_filter`가 정의된 `django/template/defaultfilters.py` 단일 파일로 grep 한 방에 수렴한다. cross-file 추적 없음, 신규 1심볼 추가.
- **S (Repair Strategy) = S2 (+S5)** — 위치는 자명하지만 올바른 픽스가 "기계적 가드/상수"가 아니다. `escape` vs `force_escape` vs `conditional_escape` 중 어느 escape 함수를 원소에 적용할지를 **이스케이프 불변식**으로 추론 합성해야 한다. autoescape on/off 동등성 + `mark_safe` 원소 보존(이중 이스케이프 금지)이라는 두 제약을 만족시키는 함수는 `conditional_escape` 하나뿐이다. 의도 자체("`escapeseq` is to `escape` what `safeseq` is to `safe`")는 이슈 본문/관례에서 재구성해야 하므로 S5가 보조로 붙는다. 단순히 후보를 던지며 테스트로 수렴하는 S3가 아니라, safe-string 불변식을 따져 "생각으로" 정답을 고르는 SemFix류 추론이라 S2가 dominant.
- **K (Knowledge) = K-Domain** — django 템플릿 엔진의 safe-string 모델(`mark_safe`/`conditional_escape`/`is_safe`/autoescape 컨텍스트) 내부 지식이 병목이다. 일반 파이썬 추론만으로는 `conditional_escape`와 `is_safe=True` 등록 관례를 도출할 수 없다.
- **primary type = T-ConstraintReason** — 위치는 명확(L0)하나 진짜 난점이 "올바른 escape 함수·등록 플래그를 불변식으로 합성"하는 S2 추론에 있다. T-LocTrivial(S1 자명)도, T-DiffuseLoc(L2/L3)도 아니다.

## 난이도 티어
**T3 (중간).** 구조적 피처:
- 파일수 1 / 추가 줄수 약 10줄(신규 함수 1개) — scope는 T1~T2급으로 작다.
- localize 직접성 L0 — 이슈가 파일·이웃 심볼을 지목해 탐색 비용 거의 0.
- **그러나** repro 없음(`has-repro` X, 신규 테스트를 직접 작성해야 함), 그리고 `escape`/`force_escape`/`conditional_escape` 3지선다에서 safe-string 불변식 추론(S2)이 요구되는 K-Domain 문제 — 이 추론·지식 결합이 T2(쉬움, S1 기계적)를 넘어 T3로 민다.
- P2P가 비어 있어(`pass_to_pass: 0`) regression-trap은 약하다. 따라서 T4(넓은 P2P trap/멀티파일)까지는 가지 않는다.

공식 difficulty 라벨은 "15 min - 1 hour"로 T3와 정합적이다. 다만 공식 라벨은 개발자 구현시간 기준이라 scope의 작음을 반영하는데, 에이전트 관점에서는 escape-함수 선택 오류 가능성(overfit 함정)이 추가 난이도를 만든다 — 그래서 scope만 보면 T2처럼 보여도 추론·도메인 축이 T3를 정당화한다.

## 골드패치 분석
- **건드린 파일/함수**: `django/template/defaultfilters.py` — 신규 `escapeseq(value)`, `@register.filter(is_safe=True)`로 등록, `escape_filter` 정의 바로 뒤에 삽입.
- **근본 원인**: 단일 값용 `escape`/`force_escape`와 시퀀스용 `safeseq`(각 원소 `mark_safe`)는 존재했지만, 시퀀스 각 원소를 이스케이프하는 대칭 필터가 없었다. autoescape off 컨텍스트에서 리스트를 `join`하면 원소가 이스케이프 없이 그대로 출력되어 XSS 표면이 된다.
- **수정 요지**: 구현은 `return [conditional_escape(obj) for obj in value]`. 시퀀스를 순회하며 각 원소에 `conditional_escape`를 적용한 리스트를 반환한다. `conditional_escape`이므로 이미 `mark_safe`된 원소는 이중 이스케이프하지 않는다. `is_safe=True`로 등록해 반환 원소들이 autoescape 단계에서 재이스케이프되지 않게 한다(결과는 이미 안전).

## 검증 (test_patch)
- **FAIL_TO_PASS 동작** (4개, 신규 파일 `tests/template_tests/filter_tests/test_escapeseq.py`):
  - `test_basic`: autoescape on. `a=["x&y","<p>"]`, `b=[mark_safe("x&y"), mark_safe("<p>")]` → `"x&amp;y, &lt;p&gt; -- x&y, <p>"`. safe 원소(`b`)는 그대로 보존됨을 검증.
  - `test_autoescape_off`: `{% autoescape off %}` 안에서도 동일 출력 → escape가 autoescape 단계가 아니라 필터 자체에서 일어남을 증명.
  - `test_chain_join` / `test_chain_join_autoescape_off`: `escapeseq|join:"<br/>"` 체인이 두 모드 모두 `"x&amp;y<br/>&lt;p&gt;"`.
- **픽스 증명**: 동일 입력을 autoescape on/off 두 환경에서 렌더해 결과가 같은지 대조한다. `conditional_escape`가 원소 단위로 적용되어 autoescape 설정과 무관하게 일관되고, `mark_safe` 원소가 이스케이프되지 않는 분기까지 커버한다.
- **overfit·regression 관점**: P2P가 비어 있어 regression 표면은 없다. overfit 위험은 약하지만 존재 — 만약 에이전트가 `escape`(force-escape 계열)를 쓰면 `test_basic`의 4개 중 3개는 통과하나 `b`(mark_safe) 케이스에서 깨진다. 즉 `test_basic`의 `b`/`mark_safe` 입력이 `escape` vs `conditional_escape`를 구별하는 결정적 반례 역할을 한다. 다만 테스트가 mark_safe·autoescape off·join-chain까지 세 축으로 입력공간을 갈라놓아 weak-suite overfit은 상당히 차단된다(그래서 `overfit-risk`는 약, S4까지는 아님).

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 "template filter", "`safeseq`", "`escape`" 신호 → `django/template/defaultfilters.py`를 열어 `safeseq`와 `escape_filter`/`force_escape`를 grep. 세 심볼이 한 파일에 모여 있어 즉시 수렴(L0). 등록 패턴(`@register.filter(is_safe=True)`)과 `safeseq`의 시퀀스 컴프리헨션 형태를 레퍼런스로 잡는다.
2. **픽스와 일반화 근거**: `safeseq`(`[mark_safe(obj) for obj in value]`)를 미러링하되 `mark_safe`를 `conditional_escape`로 치환한다. `conditional_escape`를 고르는 것이 핵심 일반화 — `escape`/`force_escape`는 입력을 무조건 escape하므로 이미 `mark_safe`된 원소를 이중 이스케이프해 `b` 케이스를 깬다. `conditional_escape`는 "안전하지 않은 것만 escape"라는 정확한 불변식을 구현하므로 autoescape on/off·mark_safe 보존 두 제약을 동시에 만족한다. `is_safe=True` 등록으로 결과 재이스케이프를 막아 autoescape on에서도 동등성을 유지 — 이게 특정 테스트가 아닌 safe-string 모델 전체에 맞는 올바른 일반화다.
3. **regression 안전**: P2P가 비어 있어(`pass_to_pass: 0`) 깨뜨릴 인접 동작은 명시되지 않는다. 단, 신규 필터를 추가만 하고 기존 `escape_filter`/`force_escape`/`safeseq`를 건드리지 않으므로 인접 필터 회귀 가능성 자체가 없다(additive 변경). 등록 순서·`is_safe` 플래그를 기존 관례대로 따르면 필터 레지스트리 일관성도 유지된다.
4. **함정 회피**: 오라클 없는 에이전트의 주 실패점은 (a) `escape`/`force_escape`를 골라 `mark_safe` 원소를 이중 이스케이프 → `test_basic`의 `b` 회귀, (b) `is_safe=True`를 빠뜨려 결과 리스트가 autoescape 단계에서 재이스케이프 → 출력 틀어짐, (c) FAIL_TO_PASS가 "아직 존재하지 않는 신규 테스트 파일"임을 인지 못함. 회피법: "autoescape off에서도 동일 출력 + safe 원소 보존"이라는 의도를 먼저 스펙으로 못 박고, 그 불변식을 만족하는 escape 함수가 `conditional_escape`임을 safe-string 모델에서 역산한다. `safeseq`를 직접 구조 미러로 삼으면 등록 플래그·시퀀스 형태를 관례대로 끌고 와 (b)도 자연히 막힌다.
