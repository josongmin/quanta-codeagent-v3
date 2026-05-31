# L9 — 오탐 / 강등 기록

> Round 1 finder가 결함으로 올렸으나 Round 2 적대 재검증(소스 직접 재독)에서 기각/강등. 재제기 방지용으로 기록. 적대 패스가 없었으면 그대로 신뢰됐을 것 — 이 레인에서도 "코드를 실제로 읽으면 무너지는" 결함이 ~10건.

## FP1. otel-sink gauge prev-cache가 provider restart 시 stale (강등: Medium → 잠복-설계)
- **원주장:** `prevByLabelKey`가 provider swap 후에도 안 비워져 다음 delta가 틀림.
- **검증:** overstated. `getMeter`가 closure `meter`를 한 번 set하면 다시 fetch 안 함(early-return). `getOrCreate` catch는 *instrument* 생성만 retry하고 prev-cache는 안 건드림. closed-port 계약상 caller는 sink 수명 동안 단일 provider 소유 → finding이 가정한 "같은 sink의 provider를 mid-flight mutate"는 계약 미지원. 라이브 버그 아닌 design smell.

## FP2. exhaustive `never` 뒤 `return 1`이 dead defensive code (강등: Low → 오탐)
- **원주장:** `otlpKind`/`otlpStatusCode`의 `default: { const _exhaustive:never=kind; return 1 }`가 dead code로 새 SpanKind를 조용히 INTERNAL 매핑.
- **검증:** 오탐. `never` 할당이 컴파일타임 가드로 제 역할을 하고, trailing `return 1`은 함수가 `=>number`라 **TS 제어흐름이 요구하는 타입시스템 필수**(`never` 할당은 `throw`가 아님). harmful dead code 아님. 주석 워딩만 nit.

## FP3. turn-timing `??0`이 epoch-ms를 duration으로 emit (강등: Low → 오탐)
- **원주장:** `requestSentAt ?? 0`이 `totalDurationMs = end-0` = epoch-ms를 그럴듯한 duration으로.
- **검증:** overstated. 0 default는 programming-bug 경로만(루프가 `markRequestSent`/`markStreamEnd`를 계약상 호출). `totalDurationMs`는 hash/fingerprint가 아닌 `outcome`에 들어가고 persisted byte-identical 출력에 안 닿음. null이 더 깔끔하나 결함은 cosmetic.

## FP4. shared env-files `process.cwd()` ambient determinism (강등: Medium → Low)
- **원주장:** `resolve(process.cwd(), file)`가 호출 시점 cwd 의존 → 두 호출처가 다른 파일 로드.
- **검증:** overstated. canonical dotenv 계약(cwd-상대)이고 고정 cwd 런처에서 1회 호출. "두 호출처 다른 cwd" 시나리오는 가설(런처 1개). env var는 trajectory/replay에 직렬화 안 되므로 persisted/hashed 출력 무영향. 실재하나 Low.

## FP5. shared log-sanitize NFKC bare-catch가 보안 우회 (강등: Low → defensible)
- **원주장:** `catch{return s}`가 normalize 실패 시 raw로 떨어져 compat-variant forge 통과.
- **검증:** defensible(보안 주장은 거의 오탐). `String.prototype.normalize`는 **invalid input(lone surrogate)에만** throw하고, 그건 후속 `BIDI_ZW_RE`가 strip하는 backstop이 있다. "non-surrogate 이유로 throw하면 통과"는 발생 불가. telemetry 없는 swallow nit만 유효.

## FP6. shared byte-compare UTF-16 vs codepoint/byte order (강등: Medium → Low/doc)
- **원주장:** "byte-stable" 주장이 astral-plane에서 UTF-8 byte order와 불일치 → replay 깨짐.
- **검증:** 정확히-scoped. `a<b`는 UTF-16 code-unit 비교라 astral은 leading surrogate로 정렬돼 codepoint/UTF-8 byte order와 다름. **그러나** deterministic + locale-independent(load-bearing 속성)는 유지 → ASCII id/path엔 replay 무해. doc 정확성 이슈지 replay-break 아님.

## FP7. remote logs() 스트림 early-return 시 미해제 (강등: High → Low)
- **원주장:** consumer abort 시 `proc.stream`이 명시적 close 안 됨 → `docker logs -f`/`tail -f` 서브프로세스 누수.
- **검증:** overstated. 포트 계약([port.ts:19-21](../../../../src/remote/runner/port.ts#L19))이 release를 주입 stream(signal 준수)에 명시적으로 위임하고, 두 어댑터 모두 `proc.stream(argv, signal)`로 signal 전달. `for await...return`은 JS 의미상 iterator `.return()`을 호출하므로 well-behaved stream은 닫힌다. 누수는 주입 stream이 `.return()`과 signal 둘 다 무시할 때만 = 어댑터-seam 계약 위반이지 어댑터 버그 아님.

## FP8. reactor CI trigger의 wall-clock `at`가 dedup 무력화 (강등: Low/determinism → Low/code-quality)
- **원주장:** `simulatedMessage`에 박힌 `(at ${at})`가 content-dedup을 깸.
- **검증:** overstated. `at`은 ClockPort 경유(test-deterministic)이고 **primary dedup은 `stableRunId`**(link 기반, seen-store)로 메시지 빌드 전에 fire([trigger-source-ci.ts:140](../../../../src/reactor/trigger-source-ci.ts#L140)). `simulatedMessage`는 이 슬라이스에서 dedup 키로 hash/persist 안 됨. self-wake.ts:74의 loop content-dedup은 tertiary backstop. 실 가드 무력화 안 됨. raw ms(ISO 아님) 문자열 = code-quality nit.

## FP9. connectors REST registry unbounded server array (강등: Low → defensible)
- **원주장:** `parseResponse`가 server 배열을 element-cap 없이 순회 → soft DoS.
- **검증:** overstated. 라인 62가 trusted-registry 가정을 문서화하고 슬라이스 전반(parseCached 포함)이 동일 trust 자세. 이미-신뢰된 카탈로그 호스트에 대한 soft-DoS만 = 명시된 trust 경계와 일치. defense-in-depth로 cap은 좋으나 결함 아님.

## FP10. storage shadow-odb ISO-second pre-rewind ref 충돌 (강등: Low → 의도적 safe-fail)
- **원주장:** `pre-rewind-<ISO second>` ref가 같은 초 내 2회 rewind에서 충돌.
- **검증:** 의도적 safe-fail(결함 아님). create-only sentinel로 같은-초 2번째 rewind가 recovery point를 clobber하는 대신 typed `rewind-failed`로 **안전하게 throw**(HELL-25, 주석 문서화). throw가 옳다. 1초 해상도로 인한 spurious failure 비용은 monotonic suffix로 polish 가능하나 durability는 보존됨.

---

## non-finding (의심스러웠으나 sound로 확인)
- **git `findStashIndex`** ([cloud-branch-snapshot.ts:432](../../../../src/git/cloud-branch-snapshot.ts#L432)): `git stash list` 라인 인덱스를 `stash@{N}`으로 사용 — `git stash list`가 entry당 1라인 + `stash@{0}` 먼저라 line-index ≡ stash-index. off-by-one 없음. 의심스러워 보이나 정확.
- **shared `trajectory.ts` key-order**: `redactValue`가 insertion order 보존하나 module-doc이 canonicalization을 downstream `envelope-encoder`에 위임 명시 → 유일 persistence 경로가 canonicalizing encoder를 통과하는 한 replay-safe(boundary note로만 기록).
