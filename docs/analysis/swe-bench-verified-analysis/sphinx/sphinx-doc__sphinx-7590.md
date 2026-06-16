---
instance_id: sphinx-doc__sphinx-7590
repo: sphinx-doc/sphinx
base_commit: 2e506c5ab457cba743bb47eb5b8c8eb9dd51d23d
version: "3.1"
difficulty: ">4 hours"
created_at: 2020-05-01T18:29:11Z
fail_to_pass: 1
pass_to_pass: 24
gold_files: [sphinx/domains/c.py, sphinx/domains/cpp.py, sphinx/util/cfamily.py]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

## 문제 요약
C++ 도메인 파서가 user-defined literal(UDL, 예: `6.62607015e-34q_J`, `1q_s`)을 인식하지 못해 `WARNING: Invalid definition: Expected end of definition`로 빌드가 실패한다. 리터럴 뒤에 붙는 식별자 suffix를 파싱하는 로직이 아예 없고, 기존 numeric suffix 처리(`while self.current_char in 'uUlLfF'`)는 표준 suffix만 글자단위로 흡수할 뿐 UDL을 위한 AST 노드/ID-mangling이 없다. 표준 numeric suffix와 UDL suffix를 구별하는 정밀한 경계 처리가 핵심이다.

## 유형 (정형화)
- **L = L3 (Multi-site)**: 이슈가 `cpp.py#L4770`(`_parse_literal`)을 직접 지목하지만, 올바른 수정은 `sphinx/util/cfamily.py`(새 정규식 `integers_literal_suffix_re`/`float_literal_suffix_re` + `verify_description_mode`에 `'udl'` 추가), `sphinx/domains/cpp.py`(`ASTUserDefinedLiteral` 신설, `_udl()` 헬퍼, `describe_signature`의 `'udl'` 모드), `sphinx/domains/c.py`(C 파서도 동일 suffix 정규식으로 교체)에 **조율되어 함께** 걸쳐야 한다.
- **S = S6 (Design-Refactor) +S2**: 한 줄 가드가 아니라 새 AST 클래스 + 파서 분기 + 렌더 모드라는 구조 도입이 본질(S6). 동시에 "표준 suffix(`q_s`의 잘못된 흡수 방지)와 UDL을 word-boundary `\b`로 구별"하는 정규식 불변식 합성(S2)이 들어간다.
- **K = K-Domain**: C++ UDL 문법, Itanium ABI ID-mangling(`clL_Zli...EE` = `operator""id(literal)` 함수호출처럼 mangle), sphinx C-family 파서 내부(ASTLiteral 계층/describe mode)에 대한 깊은 지식이 필요.
- **primary = T-DesignRefactor**: dominant 신호는 "조율된 구조 변경"이다. 이슈는 위치를 거의 짚어주지만(L 측면은 쉬움) 정답은 신규 노드·파서경로·렌더모드·cross-file 정규식 추출이라는 design 작업이라 T-DesignRefactor가 맞다.
- **왜 이 strategy**: 결함클래스가 "기능 부재(feature add)"라 템플릿 매칭(S1) 불가, 테스트가 두꺼워 G&V(S3/S4)로 우연수렴도 어렵다. 정답 도출은 문법/ABI 계약에서 구조를 설계하는 S6가 dominant.

## 난이도 티어
**T5 (어려움)**. 구조적 피처:
- 파일수 3개(c.py/cpp.py/cfamily.py) + 멀티헌크 → ICLR 컷에서 ≥3파일은 solve <10% 구간.
- localize 직접성은 높지만(이슈가 `_parse_literal` 라인 지목, has-repro 존재) **정답 범위는 그 한 줄을 한참 넘어선다** — fix가 신규 클래스·새 정규식·렌더모드까지 퍼진다.
- 도메인 지식 병목(ABI mangling 문자열을 정확히 산출해야 함: `clL_Zli4_udlEL...EE`).
- P2P trap: 24개 PASS_TO_PASS(test_fundamental_types, test_operators, test_expressions의 기존 numeric/char 케이스 등)를 안 깨야 함. 특히 `q_s`가 표준 suffix로 오흡수되면 기존 정수/실수 리터럴 파싱이 망가질 위험.
공식 라벨 `>4 hours`(T6 prior)와 비교: 정답 코드량은 크지만 localize가 명확하고(이슈가 함수 지목) repro가 있어 "어디인지 찾기" 비용이 낮으므로 T6까지는 아니다. T5로 한 단계 내린다.

## 골드패치 분석
- **sphinx/util/cfamily.py**: `integers_literal_suffix_re`(unsigned/long 조합, 끝에 `\b`), `float_literal_suffix_re = [fFlL]\b` 신설. `verify_description_mode`에 `'udl'` 모드 허용 추가.
- **sphinx/domains/cpp.py**: `udl_identifier_re` 추가. `ASTUserDefinedLiteral(literal, ident)` 클래스 신설 — `get_id`가 `'clL_Zli{ident}E{literal}E'`로 함수호출 mangle, `describe_signature`가 literal 렌더 후 ident를 `'udl'` 모드로 렌더. `_parse_literal` 내부에 `_udl()` 헬퍼: 리터럴 파싱 후 표준 suffix가 없으면 `udl_identifier_re`를 시도해 UDL로 감싼다. float/int/string/char 전 경로에 `_udl` 적용. `ASTIdentifier.describe_signature`에 `mode == 'udl'` 분기(`operator""id` 타겟으로 xref) 추가.
- **sphinx/domains/c.py**: 동일 suffix 정규식으로 교체(C에는 UDL 없으므로 suffix만 정리, `_udl` 없음).
- **근본원인**: 표준 suffix를 글자단위로 흡수하던 로직이 word-boundary 개념이 없어 UDL 식별자와 표준 suffix를 구별 못 했고, UDL을 표현할 AST/렌더/ID 경로 자체가 부재.
- **수정요지**: suffix 매칭을 `\b`로 닫아 UDL과 분리 → suffix가 없을 때만 UDL 식별자를 흡수 → 전용 노드로 ABI-mangle.

## 검증 (test_patch)
- FAIL_TO_PASS = `tests/test_domain_cpp.py::test_expressions` 단 1개지만 **내부 케이스가 두껍다**: ints/decimalFloats/hexFloats/char 전부에 `_udl`·`uludl`·`fudl` suffix를 붙여 `clL_Zli...EE` mangle을 검증하고, 이슈 #7294의 `6.62607015e-34q_J → clL_Zli3q_JEL6.62607015e-34EE`를 직접 단언.
- **픽스 증명**: `q_J`가 표준 float suffix(`[fFlL]\b`)에 안 걸리므로 `_udl`로 흡수돼 `ASTUserDefinedLiteral`이 생성되고, mangle이 정확히 함수호출 형태로 나온다. 동시에 `5.0e42f` 같은 표준 suffix는 `\b` 매칭으로 여전히 `L...E`로 처리됨(같은 테스트가 두 경로 동시 검증).
- **overfit 관점**: FAIL_TO_PASS 1개지만 입력공간을 카테시안으로 덮어(suffix × literal-type) special-case 통과가 어렵다 → overfit-risk 낮음.
- **regression 관점**: char 리터럴/표준 numeric suffix 케이스를 리팩터한 채 그대로 유지하고 24개 P2P가 인접 파싱을 지킨다. word-boundary 누락이나 `_udl` 무조건 적용 시 기존 케이스가 깨지므로 regression-trap이 실재.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `cpp.py`의 `_parse_literal`(라인 지목)과 에러 위치(suffix 시작점)를 직접 준다 → `_parse_literal`의 numeric suffix 흡수 루프 `while self.current_char in 'uUlLfF'`가 UDL을 모른다는 것이 1차 진단. 거기서 suffix 매칭이 `cfamily.py`의 정규식들과 공유돼야 함을 따라가 cross-file 범위를 확정.
2. **픽스/일반화**: suffix를 글자단위 흡수 대신 `\b`로 닫힌 정규식(`integers_literal_suffix_re`, `float_literal_suffix_re`)으로 바꾸고, **suffix가 없을 때만** UDL 식별자(`udl_identifier_re`)를 흡수하는 `_udl()`를 모든 리터럴 경로에 적용. UDL은 표준상 `operator"" id`로 함수호출이므로 `clL_Zli{ident}E{literal}E` mangle이 ABI에 맞는 올바른 일반화(한 케이스 하드코딩이 아님).
3. **regression 안전**: 표준 suffix(`f/F/l/L`, `u/U` + long 조합)는 여전히 매칭돼 기존 `L...E` ID를 산출해야 함 → test_fundamental_types/test_expressions의 기존 numeric·char 케이스(P2P)가 그대로 통과. `\b` 경계가 표준 suffix와 UDL을 분리하는 안전장치.
4. **함정 회피**: 오라클 없는 에이전트는 (a) `_udl`을 suffix 유무와 무관하게 적용해 `5.0f`의 `f`를 UDL 식별자로 오흡수, (b) ID-mangling을 `L...E` 단순형으로 두어 `clL_Zli...EE` 단언 실패, (c) C++만 고치고 `c.py`/`cfamily.py` suffix 정규식 미동기화로 cross-file 회귀, (d) `verify_description_mode`에 `'udl'` 미등록으로 `describe_signature` 렌더 시 예외 — 이 네 군데서 틀린다. 회피책: word-boundary 우선·suffix-우선/UDL-후순 분기·ABI mangle 명세 준수·3파일 동기 수정.
