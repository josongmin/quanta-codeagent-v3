---
instance_id: sphinx-doc__sphinx-11445
repo: sphinx-doc/sphinx
base_commit: 71db08c05197545944949d5aa76cd340e7143627
version: "7.1"
difficulty: "15 min - 1 hour"
created_at: 2023-05-28T19:15:07Z
fail_to_pass: 2
pass_to_pass: 8
gold_files: [sphinx/util/rst.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`rst_prolog`가 설정되어 있고 문서의 첫 제목이 `:mod:`처럼 도메인 디렉티브(role)로 시작하면, 그 제목이 렌더링되지 않고 toctree에도 포함되지 않는다. 원인은 prolog 삽입 코드가 `:mod:`foo`` 라인을 docinfo 필드로 오인하여, 제목 텍스트 라인과 그 밑줄(`===`) 사이에 prolog를 끼워 넣어 제목 구조를 깨뜨리는 것이다. `rst_prolog`가 없거나 제목이 일반 텍스트면 정상 동작한다. v4.0.0부터 재현되는 오래된 버그다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈 본문이 직접 코드 위치를 지목하지는 않지만, hints에 `sphinx/util/rst.py` L81-91(`prepend_prolog`)이 명시되고, "prolog가 잘못된 위치에 삽입된다"는 인과가 분명해 단일 함수로 즉시 수렴한다.
- **S2 (Constraint-Reasoning)**: 고칠 지점(`docinfo_re.match`로 docinfo 라인 카운트하는 루프)은 자명하나, 올바른 픽스는 "무엇이 진짜 docinfo 필드 마커인가"라는 *정확한 인식 조건*을 합성해야 한다. 임의 정규식을 새로 짜는 게 아니라 docutils의 정본 `field_marker` 패턴을 채택하는 의미적 추론이다.
- **K-Domain**: docutils의 RST 파싱 내부(`Body.patterns['field_marker']`, docinfo/field-list 문법, role 문법 `:mod:`...``)를 알아야 "왜 기존 `:\w+:.*?`가 role을 오인하는가"를 이해할 수 있다.
- **primary = T-ConstraintReason**: 위치는 좁게 특정되지만 핵심은 "올바른 매칭 조건을 추론·합성"하는 데 있다(틀린 정규식이 근본원인). 그래서 S2.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 단일 파일(`sphinx/util/rst.py`) 단일 함수, 골드 패치 실질 변경 ~10줄로 작다. `has-repro`(완전한 shell 재현 + 최소 RST 예시)가 강한 easiness 신호다. 그러나 T2가 아닌 이유는 픽스가 기계적 가드 추가(S1)가 아니라 "기존 정규식이 왜 틀렸나 → docutils 정본 패턴으로 교체"라는 도메인 추론(S2+K-Domain)이기 때문이다. `regression-trap`도 약하게 존재: `test_prepend_prolog`, `test_prepend_prolog_with_CR/without_CR` 등 기존 docinfo 처리 경로(P2P)를 깨면 안 된다. 공식 라벨("15분~1시간")과 일치하며, 멀티파일/조율(L3)이나 overfit 고위험(S4)이 없어 T4 이상은 아니다.

## 골드패치 분석
- **파일·심볼**: `sphinx/util/rst.py` — `prepend_prolog()` 및 모듈 수준 정규식.
- **근본원인**: `docinfo_re = re.compile(':\\w+:.*?')`. 이 패턴은 `.*?`가 너무 관대해 `:mod:`mypackage2``(role 문법)까지 docinfo 필드로 매칭한다. 그 결과 `prepend_prolog`의 docinfo 스킵 루프(`if docinfo_re.match(line): pos += 1`)가 제목 텍스트 라인을 docinfo로 카운트해, prolog를 *제목 라인과 밑줄(`===`) 사이*에 삽입 → RST 파서가 제목을 인식 못 함.
- **수정요지**: (1) 직접 만든 `docinfo_re`를 폐기하고 docutils 정본 패턴 `FIELD_NAME_RE = re.compile(Body.patterns['field_marker'])`로 교체. 이 패턴은 필드 마커 뒤에 공백/EOL을 요구하므로 백틱이 따라오는 `:mod:`foo``는 매칭하지 않는다. (2) 루프 변수 `lineno`를 사전 초기화(`lineno = 0`)하여 prolog가 빈 splitlines를 가질 때의 미정의 참조를 방어. (3) 부수적으로 deprecated jinja2 import 정리(`pass_environment`를 `jinja2`에서 직접 import).

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**: `test_prepend_prolog_with_roles_in_sections_with_newline`, `..._without_newline`. 둘 다 `content = StringList([':mod:`foo`', '-'*10, '', 'hello'])`에 prolog를 붙인 뒤, prolog가 `:mod:`foo`` *앞*에 오고 `('dummy.rst', 0, ':mod:`foo`')`와 밑줄이 인접 유지되는지(`xitems()` 시퀀스)를 단언한다. 픽스 전엔 `:mod:` 라인이 docinfo로 오인되어 prolog가 그 뒤에 끼므로 실패한다.
- **픽스 증명**: 새 `FIELD_NAME_RE`는 `:mod:`foo``를 필드로 안 봐서 `pos`가 0으로 남고 prolog가 맨 앞에 삽입 → 기대 시퀀스 일치.
- **overfit/regression**: P2P의 `test_prepend_prolog_with_roles_in_sections`(진짜 docinfo `:title:`/`:author:` + 그 다음 role 제목 혼합 케이스)가 *동시에* 통과해야 하므로, "role을 무조건 스킵 안 함"식 과적합 픽스는 막힌다. 즉 진짜 docinfo는 여전히 스킵하고 role 제목만 스킵 안 하는 정확한 경계가 강제된다. overfit-risk 낮음.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "rst_prolog 설정 시 제목 사라짐 + 제목이 일반 텍스트면 정상" 대조에서, 문제는 제목 *텍스트 형태*에 따라 prolog 삽입 위치가 달라진다는 것 → prolog 삽입 로직(`grep rst_prolog` / `prepend_prolog` in `sphinx/util/rst.py`). hints가 정확히 L81-91을 지목.
2. **픽스와 일반화**: docinfo 스킵 루프가 `:mod:`...``을 필드로 오판하는 게 원인. 직접 정규식을 땜질(`:\w+:(\s|$)` 등)하기보다 **docutils 자신이 docinfo/field를 인식하는 정본 패턴** `Body.patterns['field_marker']`를 재사용 → RST 문법과 항상 동기화되는 올바른 일반화(임의 임계값/휴리스틱 아님).
3. **regression 안전**: `test_prepend_prolog`(docinfo 없는 일반 케이스), `_with_CR`/`_without_CR`(개행 변형), 그리고 진짜 docinfo+role 혼합(`_with_roles_in_sections`)을 모두 보존해야 한다. 정본 패턴 채택은 docinfo는 그대로 스킵하면서 role만 배제하므로 이 P2P들을 깨지 않는다.
4. **함정 회피**: 오라클 없는 에이전트는 (a) hints의 "prolog 뒤에 빈 줄 추가" 제안을 곧이곧대로 따라 *증상*만 가리는 과적합 픽스로 빠지기 쉽다(근본원인=오인 매칭이지 빈 줄 부재가 아님). (b) 정규식을 직접 손보다 진짜 docinfo 케이스를 깨기 쉽다 → docutils 정본 패턴 채택이 안전한 일반화. (c) `lineno` 사전 초기화 누락 시 빈 prolog 엣지케이스에서 `NameError` 잠복.
