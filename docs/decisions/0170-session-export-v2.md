# ADR-0170: Session export envelope v2

- **상태**: Accepted (2026-05-25)
- **관련 ADRs**: ADR-0157 (Session import/export envelope v1 — base contract this ADR extends 추가적으로), ADR-0124/0128/0138 (sidecar source — `serialize/hydrate` pattern this slice composes), ADR-0106 (SessionMeta git fingerprint — exported as part of meta, unchanged)
- **참조**:
  - `src/session/import-export.ts` — v2 추가: `SessionExportEnvelopeV2` (`version: 2` + `exporterMeta.capabilities` + `exporterMeta.exportTraceId` + 선택 `annotations` + 선택 `digest`), `AnySessionExportEnvelope` 유니온, `SessionExportOpts` 확장 (`emitV2` / `annotations` / `withDigest` / `capabilities`), `SessionImportResult.v2Meta`, `SessionImportError("digest-mismatch")`.
  - `src/session/index.ts` — 배럴에 v2 타입 4 (`SessionExportEnvelopeV2` / `AnySessionExportEnvelope` / `SessionImportErrorCode` + 기존) 추가.
  - `tests/unit/session-import-export-v2-hellgate.test.ts` — 13 case (스펙 12 + 와이어 패리티 1). A 익스포트 4 / B 임포트 4 / C 포워드-컴팻 2 / D JSON helpers 2 / extra 1.
  - `tests/unit/session-import-export-hellgate.test.ts` — HELL-5 만 "version=99" sentinel 로 조정 (v2 가 이제 합법). 나머지 17 케이스 변경 없음.

## Context

ADR-0157 은 v1 envelope (`version: 1` + `exporterMeta{quantaVersion, platform}` + `session` + 선택적 `sidecar`) 을 정착시켰다. 18-case hellgate 가 6 contract clause 를 봉인했고, 라운드트립 / 검증 / 버전델타 / 플랫폼델타 / FS 어댑터 모두 closed-port.

그러나 production replay / cross-host 디버깅 / CI 보존을 시도하면서 4 가지 갭이 드러났다:

1. **무결성 부재** — envelope 가 전송 중 파손되거나 (rsync resume 깨짐 / 손수 편집 / 캐시 corruption) tamper 됐을 때 검출할 방법이 없다. 임포트는 JSON parse 가 성공하면 무조건 통과한다.
2. **annotation 부재** — 사용자가 envelope 에 "reviewer=alice / severity=critical / labels=[regression,p0]" 같은 태그를 붙이고 임포트 시 필터링하고 싶을 때 envelope 바깥에 별도 메타파일을 들고 다녀야 한다. 단일 파일 invariant 가 깨진다.
3. **capability 부재** — 같은 quanta version 이라도 빌드 플래그가 다르면 (예: `--no-images`) 어떤 sidecar 슬롯을 채울 수 있었는지 불명. 임포터는 sidecar 의 absence 가 "안 채웠음" 인지 "채울 수 없었음" 인지 구분 못 한다.
4. **트레이스 id 부재** — 한 사용자가 같은 세션을 5번 export 했을 때 어느 envelope 가 어느 export 인지 OTel/log 와 corelate 불가. 디버깅이 갸우뚱.

본 ADR 은 v1 을 **그대로 둔 채** v2 를 additive 로 추가해 4 갭을 채운다. v1 은 영구히 계속 지원된다 (forward-compat invariant).

## Decision

**v2 envelope + opt-in 익스포트 + 자동 임포트 acceptance**:

```ts
interface SessionExportEnvelopeV2 {
  readonly version: 2
  readonly exportedAt: number
  readonly exporterMeta: {
    readonly quantaVersion: string
    readonly platform: NodeJS.Platform
    readonly capabilities: ReadonlyArray<string>   // NEW
    readonly exportTraceId: string                  // NEW (16-hex)
  }
  readonly session: SavedSession
  readonly sidecar?: SessionExportEnvelope["sidecar"]  // 동일
  readonly annotations?: Readonly<Record<string, string>>  // NEW
  readonly digest?: { readonly algo: "sha256"; readonly hex: string }  // NEW
}

type AnySessionExportEnvelope = SessionExportEnvelope | SessionExportEnvelopeV2
```

**Export side** — `SessionExportOpts` 에 4 필드 추가, 모두 default-OFF:

- `emitV2?: boolean` — `true` 면 v2 envelope 반환. 부재 / `false` 면 v1 (byte-identical).
- `annotations?: Record<string, string>` — v2 only, envelope 에 그대로 통과.
- `withDigest?: boolean` — v2 only, `true` 면 sha256(`{session, sidecar}`) 을 envelope 에 첨부.
- `capabilities?: string[]` — v2 only, 부재 시 `DEFAULT_V2_CAPABILITIES` (`["images","documents","shadow-odb","plan-queue","budget-ledger"]`) 자동 채움.

오버로드 시그니처로 `emitV2: true` 리터럴을 넘긴 호출자는 `SessionExportEnvelopeV2` 를 직접 받는다. `exportSessionToJson` 도 동일 옵션을 honor.

**Import side** — `importSession` 이 자동으로 v1 OR v2 둘 다 받는다 (signature 가 `AnySessionExportEnvelope` 으로 확장). `version: 3+` 는 `unsupported-version` typed throw. v2 인 경우:

1. `validateV2Shape` 가 `capabilities` array + `exportTraceId` non-empty string + (있다면) `annotations` object + (있다면) `digest{algo:"sha256", hex:non-empty}` 강제.
2. `digest` 가 있으면 `computeBodyDigest(session, sidecar)` 로 재계산해 비교. 불일치 → `digest-mismatch` typed throw.
3. `SessionImportResult.v2Meta` 가 `{annotations, capabilities, exportTraceId}` 로 채워짐. v1 임포트 결과는 `v2Meta` 키 자체가 부재 (exactOptional).

새 `SessionImportErrorCode` 멤버 `"digest-mismatch"` 추가. union 그대로 reverse-compat.

## Hellgate

13 case (12 spec + 1 wire-parity). 모두 closed-port, 외부 I/O 없음, 시간 / 랜덤은 옵션으로 주입.

| ID | 슬라이스 | 봉인 |
|---|---|---|
| HELL-V2-1 | A. export | `emitV2:true` ⇒ `version===2`, `exportTraceId` 16-hex, `capabilities` 배열 |
| HELL-V2-2 | A. export | `annotations` 통과 |
| HELL-V2-3 | A. export | `withDigest:true` ⇒ `digest.algo==="sha256"`, hex len === 64 |
| HELL-V2-4 | A. export | `withDigest` 부재 ⇒ `"digest" in env === false` (exactOptional) |
| HELL-V2-5 | B. import | v2 라운드트립 ⇒ `result.v2Meta` 3 필드 모두 populated |
| HELL-V2-6 | B. import | digest 첨부 + session.meta.title tamper ⇒ `digest-mismatch` |
| HELL-V2-7 | B. import | `strictVersion` + same quantaVersion v2 ⇒ no throw, v2Meta surfaces |
| HELL-V2-8 | B. import | v1 envelope ⇒ byte-identical legacy result, `"v2Meta" in result === false` |
| HELL-V2-9 | C. fwd | v1 + v2 sidecar shape interop (round-trip 동일) |
| HELL-V2-10 | C. fwd | `version: 3` ⇒ `unsupported-version` |
| HELL-V2-11 | D. JSON | `exportSessionToJson(emitV2:true)` ⇒ JSON parse ⇒ v2 shape |
| HELL-V2-12 | D. JSON | `importSessionFromJson` v2 JSON ⇒ `v2Meta` surfaces |
| HELL-V2-13 | extra | `emitV2:false` ≡ `emitV2` 부재 ⇒ envelope bytes 동일, v2 키 부재 |

v1 hellgate 18 케이스는 변경 없음 (HELL-5 만 sentinel 값을 99 로 조정).

## Default-OFF

`emitV2` 부재 → v1 envelope. 기존 export 호출 사이트는 코드 변경 없이 byte-identical 결과 유지. CI replay / 외부 도구 / 사용자 스크립트 모두 회귀 없음. v2 는 **새로** 호출하는 surface (`/session export --integrity` 같은 미래 flag, sharing-on-failure surface, CI capture) 가 opt-in.

## Forward-compat

- v1 은 **영구히** 임포트 가능 — 절대 deprecate 안 한다. 5년 전 envelope 도 오늘 임포트 가능해야 한다는 invariant.
- v3+ 등장 시 동일 패턴: `SessionExportEnvelopeV3` 추가 + `AnySessionExportEnvelope` 유니온 확장 + `importSession` 의 `rawVersion` 분기에 추가. 기존 v1/v2 임포터 그대로.
- `exporterMeta.capabilities` 가 미래 슬롯 (예: `"voice"`, `"vision"`) 을 선언하면 receiver 는 자기 빌드가 hydrate 못해도 warning 으로만 처리.

## Alternatives rejected

1. **CBOR / msgpack 포맷** — JSON 보다 작고 빠르지만 (a) 사용자가 envelope 을 손으로 열어볼 수 없고, (b) 브라우저 / `jq` 호환성이 깨지고, (c) sidecar string 이 이미 JSON 이라 이중 인코딩. ROI 음수.
2. **GPG / cosign signature** — sha256 보다 강한 무결성이지만 키 관리 / OAuth 의존 / 오프라인 환경 어색. v2 의 `digest` 는 transport-corruption + casual-tamper 만 잡으면 충분. 진짜 signature 가 필요한 surface 는 future v3 `signature` 필드로 layer.
3. **v1 deprecate / 강제 마이그레이션** — forward-compat invariant 위반. 사용자가 6개월 전 archive 한 envelope 을 못 읽게 되면 신뢰 손상.
4. **`emitV2` default ON** — 기존 호출 사이트의 wire output 이 바뀐다. CI replay snapshot, 외부 sharing 도구, 사용자 스크립트가 모두 unexpected v2 를 받아 회귀 가능. default-OFF + opt-in 이 안전.

## Follow-up

- v3 후보: end-to-end encryption envelope (sender pubkey + AES-GCM body). digest 는 transport-corruption, encryption 은 confidentiality — orthogonal.
- sidecar versioning — 각 sidecar string 이 자기 서브시스템의 `serialize/hydrate` 의 자체 버전을 carry. v2 envelope 은 sidecar 의 wire shape 에 invariant 추가하지 않는다 (의도적 — 서브시스템이 독립 evolve).
- `/session export` CLI command (장기) — `--v2 --digest --annotate "key=value"` flag 가 본 ADR 의 옵션을 그대로 expose. 본 ADR 의 scope 는 primitive 까지.
