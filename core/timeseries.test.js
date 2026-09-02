import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { quantityAt, costBasisAt, priceAt, indexHistory, valueAtDate, reconstruct } from "./timeseries.js";
import { FLAG } from "./valuation.js";

const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} !== ${b} (±${tol})`);

describe("quantityAt — 기초 보유분 처리 (P0-6 회귀)", () => {
  const asset = { id: 1, qty: 100, avg: 1000 };

  test("거래기록이 현재 수량과 맞으면 그대로 누적한다", () => {
    const trades = [
      { asset: 1, date: "2025-01-01", side: "매수", qty: 60, price: 900 },
      { asset: 1, date: "2025-06-01", side: "매수", qty: 40, price: 1100 }
    ];
    assert.equal(quantityAt(asset, "2024-12-01", trades).qty, 0);
    assert.equal(quantityAt(asset, "2025-01-01", trades).qty, 60);
    assert.equal(quantityAt(asset, "2025-12-01", trades).qty, 100);
  });

  test("거래를 일부만 입력했으면 차이를 기초 보유분으로 본다 (배수를 곱하지 않는다)", () => {
    // 현재 100주인데 거래는 30주만 기록됨 → 70주는 기록 이전부터 보유
    const trades = [{ asset: 1, date: "2025-06-01", side: "매수", qty: 30, price: 1000 }];
    const before = quantityAt(asset, "2025-01-01", trades);
    const after = quantityAt(asset, "2025-12-01", trades);

    assert.equal(before.opening, 70);
    assert.equal(before.qty, 70, "기록 이전에도 70주를 보유하고 있었다");
    assert.equal(after.qty, 100);

    // 프로토타입은 adj = 100/30 = 3.33 을 과거 전체에 곱해 매수 직후를 100주로 만들었다
    assert.notEqual(before.qty, 0);
  });

  test("기초 보유분으로 설명되는 대량 매도는 모순이 아니다", () => {
    // 현재 100주 / 매수 50 · 매도 300 → 기록 이전에 350주를 들고 있었다는 뜻이고, 모순이 없다
    const trades = [
      { asset: 1, date: "2025-01-01", side: "매수", qty: 50, price: 1000 },
      { asset: 1, date: "2025-02-01", side: "매도", qty: 300, price: 1200 }
    ];
    const r = quantityAt(asset, "2025-12-01", trades);
    assert.equal(r.opening, 350);
    assert.equal(r.consistent, true);
    assert.equal(r.qty, 100);
  });

  test("매수 기록이 현재 보유량을 초과하면 모순으로 표시한다", () => {
    // 현재 100주인데 매수만 200주 기록 → 기초 보유분이 -100이 되어 설명 불가
    const trades = [{ asset: 1, date: "2025-01-01", side: "매수", qty: 200, price: 1000 }];
    const r = quantityAt(asset, "2025-12-01", trades);
    assert.equal(r.opening, -100);
    assert.equal(r.consistent, false);
    assert.ok(r.qty >= 0, "수량이 음수로 나가면 안 된다");
  });

  test("중간에 보유량이 음수가 되는 순서도 모순으로 잡는다", () => {
    // 기초 100주에서 300주를 먼저 팔 수는 없다
    const trades = [
      { asset: 1, date: "2025-01-01", side: "매도", qty: 300, price: 1200 },
      { asset: 1, date: "2025-02-01", side: "매수", qty: 300, price: 1000 }
    ];
    const r = quantityAt(asset, "2025-12-01", trades);
    assert.equal(r.opening, 100);
    assert.equal(r.consistent, false, "중간에 -200주가 되는 이력이다");
  });

  test("거래기록이 없으면 현재 수량을 쓴다", () => {
    assert.equal(quantityAt(asset, "2020-01-01", []).qty, 100);
  });
});

describe("costBasisAt — 시점별 투입원금 (P0-2 회귀)", () => {
  test("매수가 쌓이면 원금도 함께 증가한다 (상수가 아니다)", () => {
    const asset = { id: 1, qty: 100, avg: 1000 };
    const trades = [
      { asset: 1, date: "2025-01-01", side: "매수", qty: 50, price: 1000 },
      { asset: 1, date: "2025-07-01", side: "매수", qty: 50, price: 1400 }
    ];
    const t0 = costBasisAt(asset, "2024-12-01", trades);
    const t1 = costBasisAt(asset, "2025-03-01", trades);
    const t2 = costBasisAt(asset, "2025-12-01", trades);

    assert.equal(t0, 0, "첫 매수 전 원금은 0");
    assert.equal(t1, 50_000);
    assert.equal(t2, 120_000);
    assert.ok(t0 < t1 && t1 < t2, "원금 시계열이 단조 증가해야 한다");
  });

  test("매도하면 이동평균 취득원가만큼 원금이 줄어든다", () => {
    const asset = { id: 1, qty: 50, avg: 1000 };
    const trades = [
      { asset: 1, date: "2025-01-01", side: "매수", qty: 60, price: 1000 },
      { asset: 1, date: "2025-06-01", side: "매도", qty: 10, price: 1500 }
    ];
    // 매수 60,000 → 10주 매도 시 취득원가 1,000 × 10 = 10,000 차감 (매도가 1,500이 아님)
    assert.equal(costBasisAt(asset, "2025-12-01", trades), 50_000);
  });
});

describe("priceAt", () => {
  const index = indexHistory({ "KR:005930": {
    "2025-01-02": 55000, "2025-06-02": 62000, "2026-01-02": 71000 } });

  test("해당 시점 이전의 마지막 종가를 쓴다", () => {
    assert.equal(priceAt(index, "KR:005930", "2025-06-02"), 62000);
    assert.equal(priceAt(index, "KR:005930", "2025-09-01"), 62000);
    assert.equal(priceAt(index, "KR:005930", "2026-03-01"), 71000);
  });

  test("첫 기록보다 이른 시점은 null (앞 값으로 채우지 않는다)", () => {
    assert.equal(priceAt(index, "KR:005930", "2024-06-01"), null);
  });

  test("모르는 키는 null", () => {
    assert.equal(priceAt(index, "KR:000000", "2025-06-02"), null);
  });
});

describe("valueAtDate — MANUAL 자산 보간 (P0-3 회귀)", () => {
  const ctx = { index: indexHistory({}), trades: [], fx: {}, todayISO: "2026-01-01", taxRate: 0 };

  test("취득일 이전에는 0이다", () => {
    const a = { id: 1, cls: "실물자산", mode: "MANUAL", start: "2024-01-01",
                principal: 45_000_000, value: 62_000_000 };
    assert.equal(valueAtDate(a, "2023-06-01", ctx).value, 0);
  });

  test("취득가에서 현재가치로 보간한다 (과거에 오늘 값을 꽂지 않는다)", () => {
    const a = { id: 1, cls: "실물자산", mode: "MANUAL", start: "2024-01-01",
                principal: 45_000_000, value: 62_000_000 };
    const mid = valueAtDate(a, "2025-01-01", ctx);   // 2년 중 1년 경과 → 약 절반

    near(mid.value, 53_500_000, 200_000);
    assert.ok(mid.flags.includes(FLAG.ESTIMATED), "보간값임을 표시해야 한다");
    assert.ok(mid.value < 62_000_000, "과거 시점이 오늘 값과 같으면 안 된다");
  });

  test("오늘 시점은 입력된 현재가치 그대로다", () => {
    const a = { id: 1, cls: "실물자산", mode: "MANUAL", start: "2024-01-01",
                principal: 45_000_000, value: 62_000_000 };
    assert.equal(valueAtDate(a, "2026-01-01", ctx).value, 62_000_000);
  });

  test("RATE 자산은 시점마다 다시 계산한다", () => {
    const a = { id: 2, cls: "금융자산", cat: "예금", mode: "RATE", principal: 10_000_000,
                rate: 4, start: "2025-01-01", end: "2026-01-01" };
    const half = valueAtDate(a, "2025-07-01", ctx).value;
    const full = valueAtDate(a, "2026-01-01", ctx).value;
    assert.ok(half > 10_000_000 && half < full);
    near(full, 10_400_000, 5_000);
  });
});

describe("reconstruct", () => {
  const assets = [
    { id: 1, active: 1, cls: "금융자산", cat: "주식", name: "삼성전자", code: "005930",
      market: "KR", qty: 100, avg: 60000, mode: "AUTO", cur: "KRW" },
    { id: 2, active: 1, cls: "부채", cat: "주택담보대출", name: "주담대",
      principal: 300e6, value: 250e6, mode: "MANUAL" }
  ];
  const trades = [
    { asset: 1, date: "2024-06-01", side: "매수", qty: 60, price: 55000 },
    { asset: 1, date: "2025-06-01", side: "매수", qty: 40, price: 67500 }
  ];
  const history = { "KR:005930": {
    "2024-01-02": 50000, "2024-06-03": 55000, "2025-06-02": 67500, "2026-01-02": 71000 } };

  const r = reconstruct({ assets, trades, history, fx: {}, today: "2026-01-02", years: 3 });

  test("원금 시계열이 상수가 아니다 (P0-2 회귀)", () => {
    const uniq = new Set(r.basis.map(v => Math.round(v)));
    assert.ok(uniq.size > 1, "투입원금이 전 구간 동일하면 계산되지 않은 것이다");
    assert.ok(r.basis[0] < r.basis[r.basis.length - 1], "원금은 매수를 따라 증가해야 한다");
  });

  test("첫 매수 이전 구간의 원금은 0이다", () => {
    assert.equal(Math.round(r.basis[0]), 0);
  });

  test("부채는 asset이 아니라 debt에 들어가고 net에서 차감된다", () => {
    const last = r.asset.length - 1;
    assert.equal(r.debt[last], 250e6);
    assert.equal(r.net[last], r.asset[last] - 250e6);
  });

  test("마지막 시점 평가액이 현재 수량 × 현재가와 맞는다", () => {
    assert.equal(r.asset[r.asset.length - 1], 100 * 71000);
  });

  test("날짜가 오름차순이고 마지막이 오늘이다", () => {
    assert.equal(r.dates[r.dates.length - 1], "2026-01-02");
    for(let i = 1; i < r.dates.length; i++) assert.ok(r.dates[i] > r.dates[i - 1]);
  });
});
