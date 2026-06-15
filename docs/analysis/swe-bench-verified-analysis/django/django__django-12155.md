---
instance_id: django__django-12155
repo: django/django
base_commit: e8fcdaad5c428878d0a5d6ba820d957013f75595
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2019-11-28T16:24:23Z
fail_to_pass: 1
pass_to_pass: 6
gold_files: [django/contrib/admindocs/utils.py, django/contrib/admindocs/views.py]
primary_type: T-DirectMap
tier: T3
loc_axis: L0
repair_strategy: S1 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

# django__django-12155

## 문제 요약
admindocs가 view/model docstring을 렌더링할 때, 첫 줄이 비어있지 않은(텍스트가 첫 줄부터 시작하는) docstring을 만나면 docutils가 `Error in "default-role" directive: no content permitted.` 에러를 낸다. Django 자체 docstring은 전부 첫 줄이 빈 형식이라 정상 동작하지만, 일반적인 `"""test tests something.\n"""` 형태는 깨진다. problem_statement는 범인 코드(`trim_docstring`의 `indent = min(... for line in lines if line.lstrip())`)와 원인("첫 줄 indentation이 0")까지 직접 짚어주고, `lines[1:]`로 슬라이스하라는 제안 픽스까지 적어준다. 그러나 hints에서 그 제안이 일부 테스트에서 `ValueError: min() arg is an empty sequence`로 깨진다는 점, 그래서 `inspect.cleandoc`로 갈아타는 게 옳다는 점이 밝혀진다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: 이슈가 파일/함수/결함 라인을 글자 그대로 지목한다 — `trim_docstring`의 min-indent 표현식. grep 한 방, 탐색 노력 0. 다만 픽스가 호출부(`views.py`)까지 번지므로 "찾기"는 L0지만 "수정 범위"는 2파일이다(loc_axis는 찾기 직접성으로 L0 유지, cross-file-dep 플래그로 별도 표기).
- **S (Repair Strategy) = S1 (Direct-Map) +S6 (Design-Refactor)**: 결함클래스가 정형(경계/엣지: 첫 줄 indent=0이 min을 오염)이고 이슈가 사실상 픽스를 명세하므로 dominant는 S1이다. 하지만 골드의 *올바른* 픽스는 한 줄 슬라이스 패치가 아니라 직접 구현 함수를 통째로 제거하고 표준 라이브러리(`inspect.cleandoc`)로 교체 + 빈 입력 early-return 가드 추가 + 호출부 동기화라는 작은 구조 변경이다. 검증된 표준 함수로의 대체는 "기계적 픽스를 어디에 매핑하느냐"가 핵심이라 S1이 우세하지만, 함수 삭제·재배선이라 S6 보조를 단다. CEGIS(S4)가 아닌 이유: 일반화 방향이 추가 입력 합성이 아니라 이미 알려진 표준 알고리즘(PEP 257) 적용으로 결정되어 있다.
- **K (Knowledge) = K-Domain**: django admindocs 서브시스템 + docutils RST 렌더링/default-role 디렉티브 동작 지식이 병목이다. 또한 "`inspect.cleandoc`가 PEP 257 indent 처리를 정확히 구현한다"는 표준 라이브러리 지식(K-API에 가까운 도메인)이 올바른 일반화의 근거다. 일반 파이썬 추론(K-Gen)만으론 `lines[1:]` 미봉책에서 멈추기 쉽다.
- **Primary = T-DirectMap**: 위치가 명확하고(L0) 픽스가 정형 결함클래스(경계 미처리)에 대한 기계적 교체(S1)이기 때문. T-DomainBound이 아닌 이유: 도메인 지식이 필요하긴 하나 "어디인지/무엇인지"가 이미 명세되어 병목이 지식이 아니라 정확한 매핑(표준함수 채택+범위 동기화)에 있다.

## 난이도 티어
**T3 (중간).** 공식 difficulty 라벨은 `15 min - 1 hour`(T2~T3 prior).

- T1/T2로 안 내리는 이유: localize는 L0로 자명하지만, 픽스가 단일 헌크가 아니다. (a) `trim_docstring` 함수 자체를 삭제하므로 그 심볼을 import/호출하던 `views.py`와 테스트를 함께 정리해야 하는 **cross-file-dep**, (b) `parse_docstring`에 빈 docstring early-return 가드(`if not docstring: return '', '', {}`)를 넣지 않으면 회귀, (c) 이슈가 제시한 "쉬운" 픽스(`lines[1:]`)가 함정이라 `min() arg is an empty sequence`로 P2P를 깨뜨림. 이 세 박자를 다 맞춰야 PASS_TO_PASS 6개가 산다 — 단순 1줄 수정으로 끝나는 T1/T2 프로파일이 아니다.
- T4로 안 올리는 이유: 진짜 추론 합성(S2)이나 광범위 P2P trap, 깊은 call-chain 추적이 없다. P2P 6개는 같은 테스트 파일 내 인접 동작(parse_docstring/parse_rst/publish_parts/title/description)으로 좁고, 픽스 방향이 표준함수 채택으로 비교적 결정적이다.
- 이 티어로 미는 구조적 피처: **2파일·소규모 헌크 + 함수 삭제에 따른 cross-file 동기화 + has-repro(이슈가 재현 docstring·에러 메시지 제공) + 표준함수 채택이라는 도메인 판단**. has-repro와 L0가 아래로, cross-file-dep와 미봉책 함정이 위로 당겨 T3에 안착.

## 골드패치 분석
- **건드린 파일·함수**:
  - `django/contrib/admindocs/utils.py`: `trim_docstring` 함수 **삭제**, `parse_docstring` 수정, `from inspect import cleandoc` import 추가.
  - `django/contrib/admindocs/views.py`: `get_context_data`(ModelDetailView 컨텍스트 빌드) 내 `utils.trim_docstring(verbose)` 호출 → `cleandoc(verbose)`로 교체, `from inspect import cleandoc` import 추가.
- **근본 원인**: `trim_docstring`은 `indent = min(len(line) - len(line.lstrip()) for line in lines if line.lstrip())`로 **전체 줄**에서 최소 들여쓰기를 계산한다. PEP 257 관례상 docstring 첫 줄은 `"""` 바로 뒤라 들여쓰기가 0이다. 첫 줄에 텍스트가 있으면 그 줄의 indent=0이 min을 0으로 고정시키고, 결과적으로 나머지 줄의 공통 들여쓰기가 제거되지 않는다. 본문에 leading whitespace가 남으면 docutils가 `.. default-role::` 디렉티브 직후 들여쓰여진 내용을 directive content로 오인해 `no content permitted` 에러를 낸다.
- **수정 요지**: 직접 구현한 `trim_docstring`을 버리고 표준 라이브러리 `inspect.cleandoc`(PEP 257 indent 처리를 정확히 구현, 첫 줄을 특수 취급)로 교체. `parse_docstring`은 `if not docstring: return '', '', {}` early-return 후 `cleandoc(docstring)` 호출. `views.py` 호출부도 같은 `cleandoc`로 동기화. hints가 경고한 `lines[1:]` + `default=0` 미봉책 대신 검증된 표준 알고리즘을 채택해 빈 시퀀스 회귀와 첫 줄 특례를 한 번에 해결.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_parse_rst_with_docstring_no_leading_line_feed`. 첫 줄에 바로 텍스트가 오는 docstring `'firstline\n\n    second line'`을 `parse_docstring`으로 분해해 title/body를 얻고, 각각을 `parse_rst`로 렌더한다.
- **픽스 증명 방식**: title 렌더가 `'<p>firstline</p>\n'`, body 렌더가 `'<p>second line</p>\n'`인지 단언하고, **결정적으로** `captured_stderr()`로 stderr를 캡처해 `stderr.getvalue() == ''`를 검사한다. 버그 상태에선 docutils가 default-role 에러를 stderr로 토하므로 이 단언이 깨진다 — 즉 테스트가 "렌더 결과"뿐 아니라 "에러 부재"까지 본다. test_patch는 또한 사라진 `trim_docstring` import와 기존 `test_trim_docstring` 테스트를 삭제한다(함수가 없어졌으므로).
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇긴 하나, stderr 무에러 + title/body 양쪽 렌더 단언이라 special-case로 통과하기 어렵다. `cleandoc`로의 교체는 단일 입력이 아니라 PEP 257 전체 클래스를 올바르게 처리하므로 overfit이 아닌 일반화다(이슈 입력 하나만 통과시키는 `lines[1:]` 패치가 오히려 overfit+회귀였음).
- **regression 관점**: PASS_TO_PASS 6개(`test_description_output`, `test_initial_header_level`, `test_parse_docstring`, `test_parse_rst`, `test_publish_parts`, `test_title_output`)가 모두 `cleandoc` 교체 후에도 첫 줄이 빈 기존 Django docstring을 동일하게 처리해야 한다. `parse_docstring`의 빈 입력 가드는 이전 `trim_docstring`의 `if not docstring or not docstring.strip(): return ''` 가드가 사라진 자리를 메워 `cleandoc(None)`/빈 입력 회귀를 막는다.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement가 함수명 `trim_docstring`과 결함 라인을 글자 그대로 준다 → `django/contrib/admindocs/utils.py:trim_docstring`으로 직행(L0). 에러 메시지 `Error in "default-role" directive: no content permitted.`로 docutils RST 렌더 경로임을 확인.
2. **픽스와 올바른 일반화 이유**: 이슈가 권한 제안한 `lines[1:]` 1줄 패치는 hints에서 `ValueError: min() arg is an empty sequence`로 깨짐이 드러난다. 올바른 일반화는 PEP 257 indent 처리를 정확히 구현한 표준 `inspect.cleandoc`로 함수를 통째 교체하는 것 — 이것이 "이슈의 단일 docstring 하나만 통과"가 아니라 첫 줄 특례·빈 줄·들여쓰기 전 클래스를 정본 알고리즘으로 처리하므로 overfit이 아니다. `parse_docstring`에 `if not docstring: return '', '', {}` 가드를 추가해 빈/None 입력을 닫는다.
3. **regression 안전**: P2P 6개는 첫 줄이 빈 기존 Django docstring을 다룬다 — `cleandoc`는 그 형식을 기존 `trim_docstring`과 동일 결과로 trim하므로 안전. 단, 옛 가드(`not docstring.strip()`)가 사라지므로 `parse_docstring`의 빈 입력 early-return을 반드시 넣어야 `test_parse_docstring` 등이 깨지지 않는다. `trim_docstring` 삭제 시 이를 import/호출하던 `views.py:get_context_data`와 `tests/admin_docs/test_utils.py`(import + `test_trim_docstring`)를 함께 정리해야 ImportError가 안 난다.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) 이슈가 친절히 준 `lines[1:]` 미봉책에 만족 → 빈 시퀀스 ValueError 회귀. (b) `utils.py`만 고치고 `views.py` 호출부·테스트 import를 안 고쳐 cross-file ImportError. (c) `trim_docstring`의 빈 입력 가드를 cleandoc 교체 과정에서 누락 → 빈 docstring 회귀. 회피법: 이슈의 제안을 그대로 따르지 말고 hints/표준함수까지 보고 `cleandoc` 채택 + 함수 삭제에 따른 전체 호출부·테스트 정리 + early-return 가드 3박자를 함께 적용.
