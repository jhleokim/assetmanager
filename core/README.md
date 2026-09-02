# core/ — 평가·집계 계산 계층

프로토타입에서 금액 계산 부분만 떼어낸 **순수 함수 모듈**이다. DOM·네트워크·저장소에
의존하지 않으므로 브라우저와 Cloudflare Worker 양쪽에서 그대로 쓸 수 있다.

```
npm test        # node --test, 의존성 없음
```

## 설계 원칙

1. **`new Date()`를 부르지 않는다.** 평가 기준일은 항상 `ref` 인자로 받는다.
   과거 시점 재계산과 테스트가 모두 가능해진다.
2. **모르는 값을 지어내지 않는다.** 원금을 모르면 `pl`은 `0`이 아니라 `null`이고,
   시세 이력이 없는 구간은 `FLAG.ESTIMATED`로 표시한다.
3. **모든 날짜는 UTC 달력 날짜**로 다룬다 (시간대·서머타임 영향 없음).

## 파일

| 파일 | 내용 |
|---|---|
| `date.js` | UTC 기준 날짜 산술 |
| `valuation.js` | `accrued`, `accruedInstallment`, `evaluate`, `priceKey` |
| `timeseries.js` | `quantityAt`, `costBasisAt`, `priceAt`, `valueAtDate`, `reconstruct` |
| `aggregate.js` | `buildRows`, `totals`, `groupSum`, `resolveLoanLinks`, `loanToValue` |

## 프로토타입 대비 수정된 계산

| 항목 | 프로토타입 | core/ |
|---|---|---|
| **P0-1** 예금 이자 | 만기를 파라미터로 받지 않아 무한 누적 | `end`에서 정지, `MATURED` 표식 |
| **P0-1** 적금 | 거치식으로 계산해 이자 약 2배 | `accruedInstallment`로 분리 (약 58%) |
| **P0-1** 세금 | 세전만 | `taxRate` 옵션 (`TAX_INTEREST` 15.4%) |
| **P0-2** 투입원금 추이 | 오늘 원금을 과거 전 구간에 복사 | `costBasisAt` 이동평균 취득원가 |
| **P0-3** MANUAL 과거값 | 과거 = 오늘 값 | 취득가→현재가치 보간 + `ESTIMATED` |
| **P0-6** 과거 보유수량 | 불일치 시 과거 전체에 배수를 곱함 | 차이를 기초 보유분으로 해석, 모순은 `consistent:false` |
| **P1-1** LTV | 전체부채 / 전체부동산 | 담보대출 / 담보 부동산 (연결 기준) |
| **P1-2** 담보 연결 | 소유자 일치 → 이중계상 | `secures` 우선, 모호하면 연결 안 함 |
| **P1-3** 원금 미상 | 평가액 전액을 수익으로 | 손익 대상에서 제외, `unknownBasis`로 분리 |
| **P1-4** 환율 | 취득원가에 오늘 환율 적용 | `fxAtCost` 우선, 없으면 `ASSUMED_FX` 표식 |
| **P3** 도넛 초과분 | `slice(0,11)`로 조용히 폐기 | `groupSum(top)`이 "기타"로 묶어 합계 보존 |

수치 비교는 `node tools/compare-legacy.js` 로 확인할 수 있다.

## 아직 남은 것

- 복리 방식이 `simple` / `monthly` 두 가지뿐이다 (일복리·분기복리 미지원).
- `evaluate`는 KRW 외 통화를 `ctx.fx` 맵으로 받지만, 환율 이력은 아직 시점별이 아니다.
- 부채의 원리금균등 상환 스케줄을 계산하지 않는다 (잔액은 여전히 수동 입력).
