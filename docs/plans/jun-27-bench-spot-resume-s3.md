# jun-27 — Bench spot 비용절감 + 중단복원력 (SOTA++ pool-first 강화판)

## 목표
spot reclaim/임의 크래시로 박스가 중간에 죽어도 진행 보존을 최대화하고, 4xlarge 다운사이즈(~50%↓) + spot(~70%↓)를 합쳐 현재比 ~85%↓ 비용 구조를 만든다.

---

## SOTA++ 결론
이 레포의 SOTA++ 방향은 **resume-first가 아니라 pool-first**다.

- **주력 경로는 기존 `pool + microchunk + requeue`**다.
  - `src/apps/bench/cli.ts`: `--chunk-size`
  - `src/apps/bench/remote/pool.ts`
  - `src/apps/bench/remote/pool/worker.ts`
  - `src/apps/bench/remote/pool/coverage.ts`
- **`grade --mode full` single-run은 bulk 운영 경로가 아니라 스파이크/측정 rail**로 취급한다.
- **true resume은 2차 과제**다.
  - reclaim 빈도/손실이 실제로 크고,
  - `chunk-size=1` pool requeue로도 낭비가 크며,
  - deterministic workdir까지 증명됐을 때만 만든다.

핵심 원칙:

1. **기존 소유 surface를 우선 활용**한다.
2. **loss bound를 먼저 줄이고** 그 다음에 replay를 붙인다.
3. **determinism 없는 resume은 금지**한다.
4. **best-effort upload와 resume eligibility를 분리**한다.

---

## ⚠️ 적대 audit — naive cross-box resume은 아직 거짓
코드 검증 결과:

1. **매칭 = content-hash `"exact"`**다.
   - `src/llm/replay/recording-llm.ts`
   - `src/llm/replay/replay-llm.ts`
   - `src/llm/replay/jsonl-store.ts`
2. **박스마다 랜덤 workdir 경로가 프롬프트에 박힌다.**
   - 예: `.../bench/work/bench-psf__requests-5414-n91zva/repo-gVMDzE`
3. **결과**: 새 박스에서 프롬프트 해시가 원본과 달라져 턴 1부터 replay miss가 난다.
4. **더 큰 문제**: 해시만 맞춰도 끝이 아니다.
   - recorder는 raw `request`와 raw `events`를 저장한다.
   - replayer는 recorded `tool_use` payload를 그대로 흘린다.
   - recorded `tool_use` 안에 예전 absolute workdir가 남아 있으면 stale command를 재실행한다.
   - 즉 **hash canonicalization만으로는 부족**하고, **workdir 자체의 결정성**이 먼저다.
5. **single-run full-remote에서는 완료 케이스 verdict도 증발 가능**하다.
   - artifact fetch는 `gradeChunkOnBox` 종료 시점에 한 번 일어난다.
   - 박스가 중간에 죽으면 이미 grading 끝난 일부 결과도 박스와 함께 사라질 수 있다.
6. **채점 중 reclaim은 카세트로 복구되지 않는다.**
   - 카세트는 LLM patch-gen 복원용이다.
   - docker grading은 다시 돌려야 한다.
7. **reclaim 빈도 미측정** 상태다.
   - spot reclaim이 드물면 resume machinery는 over-engineering이다.
8. **`byte-identical to uninterrupted`는 잘못된 테스트 목표**다.
   - live tail은 fresh sampling이다.
   - 올바른 단언은 replay 구간 cassette-hit, valid completion, green 보존이다.

쓸 수 있는 사실:

- recorder는 매 LLM 호출마다 `appendFile`로 디스크 flush한다.
- pool worker는 이미 dead-box requeue와 strict-subset recovery를 갖고 있다.

---

## Owning surfaces (계획의 실제 소유 경로)

### Tier 0 owner
- `src/apps/bench/cli.ts`
  - `--chunk-size`
  - `pool`
- `src/apps/bench/slicing/microchunk.ts`
- `src/apps/bench/remote/pool.ts`
- `src/apps/bench/remote/pool/worker.ts`
- `src/apps/bench/remote/pool/coverage.ts`

### Tier 1 owner
- `src/apps/bench/trajectory.ts`
- `src/llm/replay/*`
- `src/apps/bench/remote/box-session.ts`
- `src/apps/bench/remote/pool/worker.ts`
- `src/apps/bench/remote/full.ts`

원칙: **resume wiring은 `full.ts` 단독이 아니라 shared `box-session` helper + `pool/worker` 중심**으로 붙인다. bulk 운영 경로가 pool이기 때문이다.

---

## Tier 분리

### Tier 0 (즉시, 저위험, SOTA++ 기본형) — spot + pool + microchunk + requeue
resume 없이도 spot 비용은 충분히 안전하게 먹을 수 있다.

운영 shape:

- **spot 유지**: `QUANTA_FULL_REMOTE_ONDEMAND` unset/0
- **bulk 실행은 `quanta-bench pool` 기준**
- **손실 상한은 `--chunk-size`로 줄인다**
  - `--chunk-size 1`: reclaim당 최대 1 instance 손실
  - `--chunk-size 2`: bootstrap amortization은 조금 더 좋고 reclaim blast radius는 조금 커짐
- **`workers=1` 기본 유지**
  - box 수를 늘리기보다 per-box concurrency와 auth rate를 먼저 관리한다

왜 이게 SOTA++ 기본형인가:

- 이미 구현된 `runId`-scoped box paths가 있다.
  - `src/apps/bench/remote/pool/coverage.ts`
- 이미 구현된 dead-box requeue가 있다.
  - `src/apps/bench/remote/pool/worker.ts`
- 이미 strict-subset recovery가 있다.
  - partial verdict를 completion으로 오인하지 않고 missing instance를 다시 큐잉한다.

실행 원칙:

1. **bulk campaign은 single-run full-remote 대신 `pool --chunk-size 1|2`로 돌린다.**
2. **`chunk-size=1`이 reclaim blast radius 최저 baseline**이다.
3. **single-run full-remote는 측정/스파이크용으로만 유지**한다.

### Tier 1 (조건부, 고난도) — true per-turn resume
다음 조건을 모두 만족할 때만 착수:

1. P-measure에서 reclaim이 잦다.
2. `pool --chunk-size 1`로도 낭비가 크다.
3. deterministic workdir spike를 통과했다.

이 tier의 목표는 "resume machinery exists"가 아니라 **cross-box deterministic replay with durable receipts**다.

---

## Tier 1 hard blockers

### B1. deterministic workdir가 먼저다
우선순위 1은 hash tweaking이 아니라 **박스 workdir를 안정화**하는 것이다.

- 금지: hash-only canonicalization으로 해결됐다고 주장
- 허용:
  - box-side repo/workdir를 stable path로 고정
  - instance-scoped deterministic checkout path
  - 필요하면 request/event scrub를 추가하되, **lookup만 바꾸고 payload는 안 바꾸는 방식은 불충분**

스파이크 성공 조건:

- 박스 A에서 기록
- 박스 B에서 replay
- `miss=0`
- replay된 `tool_use` payload 내부 경로도 stable

### B2. stable identity contract가 필요하다
resume key는 다음처럼 분리한다:

- **authoritative resume key**: `<campaign-id>/<instance-id>`
- **transport/local artifact key**: `pool runId`
- **ephemeral infra key**: EC2 `iid`

`iid`는 절대 resume identity가 아니다. 현재 `full.ts`는 local artifact suffix로 `iid`를 쓰므로, Tier 1에서는 authoritative key와 분리된 보조 식별자로만 남겨야 한다.

### B3. upload receipt 없이는 resume advertised 금지
S3 write는 best-effort일 수 있다. 하지만 **resume 가능 여부는 fail-closed**여야 한다.

필수 receipt:

- `resume-state.json`
  - `campaignId`
  - `instanceId`
  - `latestTurn`
  - `latestUploadedObject`
  - `degraded`
  - `updatedAt`

원칙:

- upload 실패는 런을 죽이지 않아도 된다
- 그러나 `degraded=true`면 **resume candidate로 올리면 안 된다**
- 현재 recorder write swallow 패턴을 그대로 S3 resume eligibility에 쓰면 안 된다

### B4. owner는 `pool/worker`다
resume은 reclaim 후 자동 재시작을 먹어야 의미가 있다. 그러므로 배선 순서는:

1. shared helper를 `box-session`에 둔다
2. `pool/worker` dead-box requeue path에서 쓴다
3. `full.ts`는 나중에 따라온다

`full.ts`만 고치면 bulk topology는 개선되지 않는다.

---

## S3 설계 (Tier 1 전용)

### 저장 단위
S3 객체는 append가 안 되므로 전체 jsonl 재업로드는 금지한다.

선택:

- **권장**: turn/segment별 객체
  - `events/000001.json`
  - `events/000002.json`
- 대안: 주기적 segment jsonl flush

### key layout
권장 레이아웃:

`s3://<bucket>/<campaign-id>/<instance-id>/`

- `resume-state.json`
- `events/000001.json`
- `events/000002.json`
- `manifest.json` (선택)

추가로 local artifact correlation이 필요하면 `runId`, `attempt`, `iid`를 manifest field로 넣는다. path key의 주축은 `campaignId + instanceId`다.

### 업로드 의미론

- **write path**: async, non-blocking
- **resume eligibility**: fail-closed
- **operator visibility**: degraded flag + counter 필요

즉:

- "업로드 실패해도 런은 계속"은 허용
- "업로드 실패했지만 resume 가능한 것처럼 보임"은 금지

---

## 단계

### P-measure (먼저)
spot 4xlarge 실측:

- reclaim 빈도
- reclaim까지 걸린 시간
- reclaim당 잃는 instance 수
- `chunk-size 1` vs `2` 손실/throughput

출력:

- `pool --chunk-size 1 --workers 1`
- `pool --chunk-size 2 --workers 1`
- 각 run의 lost/partial/missing 집계

### P0 (Tier 0 operationalization)
코드 대수술 없이 운영 기본형 정리:

- bulk campaign runbook를 `pool --chunk-size 1|2` 기준으로 교체
- single-run full-remote는 측정 rail로 명시적 강등
- measurement/summary artifact에 reclaim loss split 추가

### P1 (Tier 1 spike) — deterministic workdir proof
해야 할 것:

- random workdir suffix의 소유 surface 확인
- deterministic checkout/workdir 설계
- 박스 A record -> 박스 B replay spike

통과 기준:

- `miss=0`
- replay된 tool payload 경로 stable
- stale absolute path 재실행 없음

실패 시:

- Tier 1 중단
- Tier 0 유지

### P2 (Tier 1 infra) — durable receipt + segmented upload
해야 할 것:

- S3 segment uploader
- `resume-state.json`
- degraded flag/metric
- resume candidate selection rule

### P3 (Tier 1 wiring) — shared helper -> pool first
배선 순서:

1. `box-session` shared helper
2. `pool/worker` requeue resume path
3. `full.ts` optional follow-up

### P4 (Tier 1 validation)
prove:

- replay 구간 live LLM call 0
- resumed run valid completion
- green 보존
- degraded upload는 resume candidate에서 제외

---

## 검증

### Tier 0 충분성
- `pool --chunk-size 1`에서 reclaim당 손실 `<= 1 instance`
- partial/missing이 silent drop 없이 surfaced
- requeue 후 최종 coverage complete 또는 honest lost reporting

### deterministic spike gate
- 박스 A record -> 박스 B replay
- `miss=0`
- tool payload 경로 stable

### Tier 1 resume 정합
- replay 구간 live call 0
- valid report 생성
- going-green case면 green 보존

### default-off
- `QUANTA_BENCH_RESUME` unset이면:
  - S3 write 없음
  - remote replay 없음
  - 기존 경로 byte-identical 유지

---

## 의사결정

1. **먼저 P-measure를 돌린다.**
   - 추천
2. Tier 0 기본값을 `chunk-size=1`로 둘지, `2`로 둘지 결정한다.
3. bulk campaign의 기본 rail을 `pool`로 강제할지 결정한다.
4. Tier 1은 P-measure + deterministic spike 통과 전에는 착수하지 않는다.

---

## 비용 payoff

### Tier 0만으로도 충분히 큼
- 4xlarge 다운사이즈 + spot = 현재 $5.8/hr -> 약 $0.96/hr
- 코드 변경 최소
- 현재 구현과 가장 잘 맞음

### Tier 1은 ROI 조건부
- reclaim이 실제로 잦고
- `chunk-size=1` requeue로도 낭비가 클 때만 의미 있음
- 그 전에는 over-engineering

---

## 최종 한 줄
**SOTA++ 기본형은 `resume-first`가 아니라 `spot + pool --chunk-size 1 + strict requeue`다. true resume은 deterministic workdir와 durable receipt를 증명한 뒤에만 붙인다.**
