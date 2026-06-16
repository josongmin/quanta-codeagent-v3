---
instance_id: astropy__astropy-8707
repo: astropy/astropy
base_commit: a85a0747c54bac75e9c3b2fe436b105ea029d6cf
version: "3.1"
difficulty: "15 min - 1 hour"
created_at: 2019-05-15T13:21:19Z
fail_to_pass: 1
pass_to_pass: 11
gold_files: [astropy/io/fits/card.py, astropy/io/fits/header.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L3
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

## 문제 요약

`Header.fromstring`은 docstring상 "byte string으로부터 헤더를 만든다"고 적혀 있지만, Python 3에서는 사실상 `str`(unicode)만 받고 `bytes`를 주면 깨진다. Py2의 `str`이 raw binary였던 시절의 관성으로, 내부 비교가 ASCII 인코딩을 전제한다. 짝꿍인 `Header.fromfile`은 text/binary 모드를 모두 처리하므로, 새 메서드 추가 없이 `Header.fromstring`(과 `Card.fromstring`)이 `bytes`도 받도록 일반화하는 것이 요청이다.

## 유형 (정형화)

- **L (Localization) = L3**: 이슈가 `Header.fromstring`/`Card.fromstring` 두 심볼을 직접 지목하므로 *찾기*는 쉽지만, 픽스는 `header.py`와 `card.py` **두 파일이 함께** 바뀌어야 한다(`Header.fromstring`이 분리한 카드 이미지를 `Card.fromstring`에 넘기므로, 한쪽만 고치면 bytes가 그대로 흘러 깨짐). 멀티사이트 조율이 본질이라 L3.
- **S (Repair) = S2 (+S5)**: 정형 결함클래스(None가드/off-by-one)가 아니라, "bytes면 latin-1로 디코드" 또는 "비교용 리터럴을 bytes로 미러링"이라는 **올바른 조건·타입식을 추론으로 합성**해야 한다(S2). 어느 지점에서 ASCII 가정이 깨지는지(`next_image[:8] == 'CONTINUE'`, `== END_CARD`, `''.join`)를 타입 흐름으로 따져야 함. 또 "bytes는 latin-1로 디코드한다"는 의도는 코드만으론 안 나오고 이슈·FITS 관례에서 재구성하므로 S5 보조.
- **K (Knowledge) = K-Domain**: FITS 헤더가 ASCII만 허용하지만 malformatted 파일의 invalid 바이트를 보존하려면 latin-1로 디코드해야 한다는 점은 astropy.io.fits 도메인 지식. 일반 파이썬 추론만으론 "왜 utf-8이 아니라 latin-1인가"를 못 맞춘다.
- **primary_type = T-ConstraintReason**: 위치는 명확하나 픽스가 기계적 가드가 아니라 타입-분기 조건과 인코딩 선택을 추론 합성하는 것이라, T-DirectMap이 아닌 T-ConstraintReason.

APR 관점: 이슈가 픽스 위치를 명세하지만 패치는 단일 라인 템플릿이 아니라 dual-path(bytes/str) 분기를 도입해야 한다. SemFix/Angelix식 의미 합성(올바른 조건·리터럴 형태)이 dominant이므로 S2.

## 난이도 티어

**T3 (중간)**. 구조적 피처:
- **파일 2개 / 헌크 다수**(`card.py` 1헌크 + `header.py` 4헌크, docstring 제외하면 실질 코드 ~25줄): cross-file 조율이라 단순 1-파일·<5줄(T1/T2)보다 위.
- **localize 직접성 높음**: 이슈가 두 심볼을 명시(L3이지만 탐색 비용은 거의 0). 이 점이 T4/T5로 못 올라가게 막음.
- **repro 약함**: 네이티브 스택트레이스 없음(`has-repro` 미부여). bytes를 주면 어떻게 깨지는지는 직접 재현해야 한다.
- **도메인 지식**: latin-1 선택은 K-Domain이지만 좁고, 이슈가 "fromfile은 binary 모드 된다"는 힌트를 줌.
- **P2P trap**: 11개 PASS_TO_PASS가 str 경로의 카드 파싱/생성을 광범위 커버 → bytes 분기 추가가 기존 str 경로를 한 톨도 안 깨야 함(regression-trap).

공식 라벨 "15 min - 1 hour"와 일치(T3). 멀티파일 조율 + 인코딩 도메인 미세지식이 시간을 끌지만, 직접 localize와 작은 패치 규모가 T4로 넘기지 않음.

## 골드패치 분석

- **건드린 파일·함수**:
  - `astropy/io/fits/card.py` — `Card.fromstring(cls, image)`
  - `astropy/io/fits/header.py` — `Header.fromstring(cls, data, sep='')` (+ 모듈 `__doctest_skip__` 갱신, docstring 보강)
- **근본원인**: 두 메서드가 입력을 항상 `str`로 가정. `Card.fromstring`은 `_pad(image)`를 바로 호출하고, `Header.fromstring`은 카드 분리 루프에서 `next_image[:8] == 'CONTINUE'`, `next_image == END_CARD`, `next_image.split(sep)[0].rstrip() == 'END'`, `''.join(image)`처럼 **str 리터럴과 직접 비교/결합**한다. 입력이 `bytes`면 이 비교들이 전부 False가 되거나 타입에러로 헤더가 비거나 깨진다.
- **수정요지**:
  1. `Card.fromstring`: `isinstance(image, bytes)`면 `image = image.decode('latin1')` 후 기존 경로 재사용 — 가장 단순한 정규화.
  2. `Header.fromstring`: `isinstance(data, bytes)`로 분기하여 비교 리터럴을 bytes 미러로 바인딩(`CONTINUE = b'CONTINUE'`, `END = b'END'`, `end_card = END_CARD.encode('ascii')`, `sep = sep.encode('latin1')`, `empty = b''`). str 경로는 동일 리터럴을 str로 바인딩. 이후 루프는 변수만 사용(`next_image[:8] == CONTINUE`, `== end_card`, `empty.join(image)`)하여 두 타입 모두 동작.

## 검증 (test_patch)

- **FAIL_TO_PASS(1)**: `TestHeaderFunctions::test_card_from_bytes` — `fits.Card.fromstring(b"ABC     = 'abc'")`가 `keyword=='ABC'`, `value=='abc'`를 반환하는지. base에선 bytes가 `_pad`로 흘러 깨졌고, 패치의 latin-1 디코드로 통과.
- **추가 테스트(test_patch에 있으나 F2P 목록엔 1개만)**: `test_header_fromstring_bytes`는 실제 `test0.fits`를 binary로 읽어 `Header.fromstring(fobj.read())` 결과가 `fits.getheader`와 동일(`==`, `tostring()` 일치)함을 확인 — `Header.fromstring`의 bytes 경로를 라운드트립으로 증명.
- **overfit 관점**: F2P가 1개로 얇아 보이지만(`overfit-risk` 후보), 픽스가 special-case 하드코딩이 아니라 isinstance 분기 + 인코딩 정규화라는 **타입 일반화**라 overfit이 아니다. 다만 latin-1 대신 ascii로 디코드하는 잘못된 일반화는 invalid-byte 파일에서 깨지므로, 추가 테스트의 실파일 라운드트립이 이를 가린다.
- **regression 관점**: 11개 PASS_TO_PASS(`test_string_value_card`, `test_boolean_value_card`, `test_card_constructor_default_args` 등)가 str 입력의 카드 파싱·생성을 커버. 골드패치는 bytes일 때만 새 분기로 가고 str 경로의 리터럴/조인 동작을 보존하므로 무회귀.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 `Header.fromstring`/`Card.fromstring`을 직명 → 두 메서드 본문을 연다. `Header.fromstring`이 카드 이미지를 잘라 `Card.fromstring(''.join(image))`로 넘기는 데이터플로우를 따라가면, 한쪽만 고치면 안 되는 **cross-file 의존**이 드러난다.
2. **픽스와 일반화 근거**: 입력 타입을 진입부에서 판별해 처리한다. `Card.fromstring`은 bytes를 latin-1로 디코드해 단일 경로로 합치고(가장 작은 변경), `Header.fromstring`은 루프가 리터럴 비교·`join`·`split(sep)`를 하므로 디코드 한 방으론 부족 — 비교 리터럴 자체를 입력 타입에 맞춰 bytes/str로 바인딩하는 dual-path가 올바른 일반화다. **latin-1**을 쓰는 이유: FITS는 ASCII만 합법이나 malformatted 파일의 invalid 바이트를 손실 없이 보존해 후속 validation에서 경고할 기회를 남기기 위함(ascii decode는 거기서 예외로 죽음).
3. **regression 안전**: str 경로는 기존과 byte-identical해야 한다(11개 P2P가 str 카드 파싱 전반을 검증). 그래서 분기는 `isinstance(..., bytes)` 가드 안에서만 새 리터럴을 쓰고, str일 때는 종전 `'CONTINUE'`/`END_CARD`/`''.join`과 동일 의미로 바인딩.
4. **함정 회피**: (a) `Card.fromstring`만 고치고 `Header.fromstring`을 빼먹기 — 루프의 str 비교가 bytes에서 전부 False가 돼 빈 헤더 산출(조용한 실패). (b) `decode('ascii')` 또는 `utf-8` 사용 — invalid 바이트 파일에서 예외/mojibake로 실파일 라운드트립 테스트가 깨짐. latin-1만이 전 바이트를 무손실 보존. (c) `sep`을 bytes 경로에서 인코딩 안 하기 — `next_image.split(sep)`가 str sep로 bytes를 split하려다 타입에러. 오라클 없는 에이전트는 단일파일·단일라인 픽스로 착각해 (a)/(b)에 빠지기 쉽다.
