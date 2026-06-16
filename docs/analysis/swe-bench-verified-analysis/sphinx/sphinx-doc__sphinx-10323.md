---
instance_id: sphinx-doc__sphinx-10323
repo: sphinx-doc/sphinx
base_commit: 31eba1a76dd485dc633cae48227b46879eda5df4
version: "5.0"
difficulty: "<15 min fix"
created_at: 2022-04-02T14:42:24Z
fail_to_pass: 1
pass_to_pass: 40
gold_files: [sphinx/directives/code.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`literalinclude` 디렉티브에서 `:prepend:`/`:append:`로 추가한 코드 예제의 들여쓰기가 깨진다. docutils가 디렉티브 옵션의 선행 공백을 제거하므로 prepend 텍스트의 들여쓰기를 직접 줄 수 없고, 우회책으로 `dedent`를 쓰면 dedent가 prepend/append 줄까지 함께 처리해 `non-whitespace stripped by dedent` 경고로 `-W` 빌드가 실패한다. 의도는 dedent를 포함 파일 본문에만 적용하고 prepend/append에는 적용하지 않는 것이다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `literalinclude`·`prepend`·`dedent`라는 명확한 키워드를 주므로 `sphinx/directives/code.py`의 `LiteralIncludeReader`로 한 번에 수렴한다. 단, "어느 줄"이 아니라 "필터 적용 순서"가 문제라 grep 한 방(L0)은 아니다.
- **S2 (+S6)**: 고칠 지점(`read()`의 `filters` 리스트)은 자명하나, 올바른 픽스는 "dedent가 prepend/append보다 *먼저* 실행되어야 한다"는 데이터플로우 불변식을 추론으로 합성해야 한다. 한 줄 값 변경이 아니라 파이프라인 단계의 재배치라 보조로 S6(소규모 구조 변경) 성격을 띤다.
- **K-Domain**: literalinclude 필터 체인(start/end/lines/prepend/append/dedent)이 순차 변환 파이프라인이라는 sphinx 내부 동작과, docutils가 옵션 선행공백을 strip한다는 도메인 사실을 알아야 "왜 dedent를 앞으로 옮기는가"가 보인다.
- **primary = T-ConstraintReason**: 위치는 좁혀지지만 픽스가 "어디"가 아니라 "변환 순서라는 의미적 제약"의 추론이라서, 기계적 가드(S1/T-DirectMap)가 아닌 제약추론으로 분류된다.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 1파일·실질 3줄 변경(헌크 1개)·has-repro로 매우 작지만, 픽스의 본질이 "필터 순서 불변식 추론"이라 자명한 가드 추가(T1/T2)가 아니다. P2P가 41개로 넓어 `regression-trap`이 있다 — 순서를 잘못 옮기면 dedent/prepend/lines 조합 테스트들이 깨진다. 공식 라벨은 `<15 min fix`(T1~T2 prior)지만, 개발자에겐 15분이어도 *오라클 없는 에이전트*는 "prepend 텍스트를 dedent에서 제외"하는 잘못된 일반화(예: dedent_filter 내부에 분기 추가)로 빠지기 쉽고 그게 41개 P2P를 깰 위험이 있어 T3로 한 단계 올린다.

## 골드패치 분석
- **파일·함수**: `sphinx/directives/code.py`의 `LiteralIncludeReader.read()`.
- **근본원인**: `read()`의 `filters` 리스트가 `prepend_filter, append_filter, dedent_filter` 순서였다. prepend/append가 먼저 줄을 삽입한 뒤 dedent_filter가 *모든* 줄(삽입된 prepend/append 포함)에 공통 들여쓰기 제거를 적용한다. docutils가 prepend 값의 선행공백을 이미 strip했으므로 prepend 줄은 보통 컬럼 0에서 시작 → dedent가 0 들여쓰기 줄을 만나 "non-whitespace stripped" 경고를 내거나 본문 들여쓰기를 망친다.
- **수정요지**: 리스트에서 `dedent_filter`를 `prepend_filter`/`append_filter` *앞으로* 이동(`lines_filter` 다음). 이로써 dedent는 포함 파일 본문에만 적용되고, 그 뒤 prepend/append가 (사용자가 의도한 그대로) 들여쓰기된 텍스트로 붙는다. 로직·시그니처 변경 없이 파이프라인 단계 순서만 바꾼다.

## 검증 (test_patch)
- **FAIL_TO_PASS** (1개): `test_LiteralIncludeReader_dedent_and_append_and_prepend`. `{'lines':'9-11','dedent':2,'prepend':'class Foo:','append':'# comment'}`로 읽어, 본문 3줄은 dedent=2 적용된 채(`  def baz():` 등) 들여쓰기가 보존되고, prepend `class Foo:`와 append `# comment`는 dedent의 영향을 받지 않아 컬럼 0에 그대로 남는 결과를 단언한다. base 순서에선 prepend/append가 dedent 대상에 들어가 결과가 어긋나므로 실패, 순서 교정 후 통과.
- **픽스 증명**: 테스트가 dedent+prepend+append 3옵션 동시 케이스의 정확한 문자열을 박아 "본문만 dedent / 추가텍스트는 보존"이라는 픽스 의도를 직접 관찰한다.
- **overfit/regression**: FAIL_TO_PASS가 1개라 얇지만, 순서 교정은 국소 가드가 아니라 파이프라인 전역 변경이므로 special-case overfit이 구조적으로 불가능하다(`overfit-risk` 미부여). 대신 기존 `test_LiteralIncludeReader_dedent`, `_prepend`, `_tabwidth_dedent` 등 41개 P2P가 순서 변경의 부작용을 광범위하게 막는다(`regression-trap`).

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "dedent가 prepend/append에도 적용된다 → 본문에만 적용되길 원함" 신호 → `literalinclude` 구현 `LiteralIncludeReader`로 이동 → `read()`의 `filters` 리스트가 변환을 *순차* 적용함을 확인. 진짜 버그는 어느 필터 내부가 아니라 리스트 내 **순서**임을 인지.
2. **픽스**: `dedent_filter`를 prepend/append보다 앞(lines_filter 직후)으로 이동. dedent의 시맨틱은 "현재 줄 집합의 공통 선행공백 제거"이므로, 추가텍스트가 들어오기 전 본문만 있을 때 돌려야 의도된 대상(본문)에만 적용된다 — 이것이 prepend를 dedent에서 특별 제외하는 것보다 일반적이고 올바른 일반화. hints의 "dedent와 prepend 조합은 의도되지 않았다 → 고쳐야"와 정확히 일치.
3. **regression 안전**: `_dedent`(prepend 없음), `_tabwidth_dedent`, `_prepend`, `_lines*` 등 41개 P2P를 안 깨야 한다. dedent를 lines 뒤·prepend 앞에 둬야 lines 슬라이싱 후 본문 기준으로 공통 들여쓰기가 계산돼 단독 dedent 동작이 보존된다(앞으로 더 당기면 lines 전체 기준이 돼 깨질 수 있음).
4. **함정 회피**: 오라클 없는 에이전트는 (a) `dedent_filter` 내부에 "prepend로 삽입된 줄은 skip" 같은 분기를 추가해 삽입줄을 추적하려다 복잡·취약해지거나, (b) prepend_filter에서 들여쓰기를 보존하려 docutils strip을 되돌리려다 실패하기 쉽다. 정답은 코드 추가 0줄, 파이프라인 **순서 한 줄 이동**임을 깨닫는 것. 또한 dedent를 lines보다 앞으로 과도하게 당기면 P2P 회귀가 나므로 "lines 다음, prepend 앞"이라는 정확한 위치를 지켜야 한다.
