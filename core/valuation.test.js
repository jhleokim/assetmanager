import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { accrued, accruedInstallment, evaluate, priceKey, TAX_INTEREST, FLAG } from "./valuation.js";

const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} !== ${b} (±${tol})`);

describe("accrued — 만기 처리 (P0-1 회귀)", () => {
  test("만기 이후에는 이자가 더 늘지 않는다", () => {
    const base = { principal: 80_000_000, ratePct: 3.45, start: "2025-09-01", end: "2026-09-01" };
    const atMaturity = accrued({ ...base, ref: "2026-09-01" }).interest;
    const oneDayLater = accrued({ ...base, ref: "2026-09-02" }).interest;
    const fiveYearsLater = accrued({ ...base, ref: "2031-09-02" }).interest;

    assert.equal(oneDayLater, atMaturity, "만기 다음날에도 만기 시점 이자와 같아야 한다");
    assert.equal(fiveYearsLater, atMaturity, "5년을 방치해도 늘지 않아야 한다");
    near(atMaturity, 80_000_000 * 0.0345, 5_000);
  });

  test("프로토타입의 폭주 값을 재현하지 않는다", () => {
    // 기존 구현은 만기를 무시해 5년 뒤 96,575,123원을 표시했다
    const { interest } = accrued({
      principal: 80_000_000, ratePct: 3.45,
      start: "2025-09-01", end: "2026-09-01", ref: "2031-09-02"
    });
    assert.ok(80_000_000 + interest < 83_000_000,
      `만기 있는 예금이 ${80_000_000 + interest}원까지 불어나면 안 된다`);
  });

  test("만기가 없으면 계속 붙되 NO_MATURITY로 표시한다", () => {
    const r = accrued({ principal: 17_800_000, ratePct: 2.8, start: "2018-03-05", ref: "2026-09-02" });
    assert.ok(r.flags.includes(FLAG.NO_MATURITY));
    assert.ok(r.interest > 0);
  });

  test("만기를 넘긴 경우 MATURED 표식을 남긴다", () => {
    const r = accrued({ principal: 1e6, ratePct: 3, start: "2024-01-01", end: "2025-01-01", ref: "2026-01-01" });
    assert.ok(r.flags.includes(FLAG.MATURED));
  });

  test("가입 전 시점이면 0", () => {
    assert.equal(accrued({ principal: 1e6, ratePct: 3, start: "2026-01-01", ref: "2025-06-01" }).interest, 0);
  });

  test("세후 옵션은 15.4%를 뗀다", () => {
    const a = { principal: 10_000_000, ratePct: 5, start: "2025-01-01", end: "2026-01-01", ref: "2026-01-01" };
    const gross = accrued(a).interest;
    const net = accrued({ ...a, taxRate: TAX_INTEREST }).interest;
    near(net, gross * (1 - 0.154), 1);
  });

  test("월복리가 단리보다 크되 과하지 않다", () => {
    const a = { principal: 10_000_000, ratePct: 6, start: "2024-01-01", end: "2026-01-01", ref: "2026-01-01" };
    const simple = accrued(a).interest;
    const monthly = accrued({ ...a, compound: "monthly" }).interest;
    assert.ok(monthly > simple, "월복리 > 단리");
    assert.ok(monthly < simple * 1.15, "2년 6%에서 복리 프리미엄이 15%를 넘을 수 없다");
  });
});

describe("accruedInstallment — 적금 (P0-1)", () => {
  test("원금은 월납입액 × 회차이지, 처음부터 전액이 아니다", () => {
    const r = accruedInstallment({ monthly: 1_000_000, ratePct: 4, start: "2025-01-01", ref: "2025-12-01" });
    assert.equal(r.months, 12);
    assert.equal(r.principal, 12_000_000);
  });

  test("적금 이자는 같은 원금 거치식의 약 절반이다", () => {
    // 프로토타입은 적금을 RATE로 처리해 이자를 약 2배로 부풀렸다
    const inst = accruedInstallment({ monthly: 1_000_000, ratePct: 4, start: "2025-01-01", ref: "2025-12-01" });
    const asDeposit = accrued({ principal: 12_000_000, ratePct: 4, start: "2025-01-01", ref: "2025-12-01" }).interest;
    const ratio = inst.interest / asDeposit;
    assert.ok(ratio > 0.5 && ratio < 0.62, `비율 ${ratio.toFixed(3)} — 약 0.54여야 한다`);
  });

  test("정기적금 단리 공식 n(n+1)/2 를 따른다", () => {
    const m = 1_000_000, r = 4, n = 12;
    const got = accruedInstallment({ monthly: m, ratePct: r, start: "2025-01-01", ref: "2025-12-01" }).interest;
    near(got, m * (r / 100 / 12) * (n * (n + 1) / 2), 1);
  });
});

describe("evaluate", () => {
  const ctx = { quotes: { "KR:005930": 71_000 }, fx: { USD: 1380 }, ref: "2026-09-02" };

  test("AUTO는 수량 × 시세", () => {
    const r = evaluate({ id: 1, cls: "금융자산", cat: "주식", code: "005930", market: "KR",
                         qty: 50, avg: 160_500, mode: "AUTO", cur: "KRW" }, ctx);
    assert.equal(r.value, 50 * 71_000);
    assert.equal(r.basis, 50 * 160_500);
    assert.equal(r.pl, r.value - r.basis);
  });

  test("시세가 없으면 NO_QUOTE 표식을 남긴다", () => {
    const r = evaluate({ id: 2, cls: "금융자산", code: "999999", market: "KR",
                         qty: 10, avg: 1000, mode: "AUTO", cur: "KRW" }, ctx);
    assert.ok(r.flags.includes(FLAG.NO_QUOTE));
  });

  test("원금을 모르면 pl은 null이지 평가액 전액이 아니다 (P1-3 회귀)", () => {
    const r = evaluate({ id: 3, cls: "금융자산", cat: "현금성", value: 5_000_000, mode: "MANUAL" }, ctx);
    assert.equal(r.value, 5_000_000);
    assert.equal(r.pl, null, "원금 미상인데 500만원을 수익으로 잡으면 안 된다");
    assert.ok(r.flags.includes(FLAG.NO_BASIS));
  });

  test("USD 자산: 취득 환율을 알면 그것으로 원금을 환산한다 (P1-4)", () => {
    const a = { id: 4, cls: "금융자산", code: "AAPL", market: "US", qty: 15, avg: 195,
                mode: "AUTO", cur: "USD", fxAtCost: 1300 };
    const r = evaluate(a, { ...ctx, quotes: { "US:AAPL": 210 } });
    assert.equal(r.basis, 15 * 195 * 1300);
    assert.equal(r.value, 15 * 210 * 1380);
    assert.ok(!r.flags.includes(FLAG.ASSUMED_FX));
  });

  test("취득 환율이 없으면 현재 환율로 환산하되 ASSUMED_FX로 표시한다", () => {
    const r = evaluate({ id: 5, cls: "금융자산", code: "AAPL", market: "US", qty: 15, avg: 195,
                         mode: "AUTO", cur: "USD" }, { ...ctx, quotes: { "US:AAPL": 210 } });
    assert.ok(r.flags.includes(FLAG.ASSUMED_FX));
  });

  test("부채는 평가손익을 내지 않는다", () => {
    const r = evaluate({ id: 6, cls: "부채", cat: "주택담보대출", principal: 320e6,
                         value: 248.5e6, mode: "MANUAL" }, ctx);
    assert.equal(r.value, 248.5e6);
    assert.equal(r.pl, null);
  });

  test("RATE 자산이 만기 이후 부풀지 않는다", () => {
    const a = { id: 7, cls: "금융자산", cat: "예금", principal: 80e6, rate: 3.45,
                start: "2025-09-01", end: "2026-09-01", mode: "RATE" };
    const atRef = evaluate(a, { ...ctx, ref: "2026-09-02" }).value;
    const far = evaluate(a, { ...ctx, ref: "2031-09-02" }).value;
    assert.equal(atRef, far);
  });
});

describe("priceKey", () => {
  test("부동산은 자산별, 종목은 시장+코드로 공유", () => {
    assert.equal(priceKey({ id: 9, cls: "부동산" }), "RE:9");
    assert.equal(priceKey({ id: 1, code: "005930", market: "KR" }), "KR:005930");
    assert.equal(priceKey({ id: 2, code: "005930", market: "KR" }), "KR:005930");
    assert.equal(priceKey({ id: 3, cls: "금융자산", cat: "펀드" }), "AS:3");
  });
});
