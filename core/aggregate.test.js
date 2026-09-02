import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildRows, totals, groupSum, resolveLoanLinks, loansFor, loanToValue } from "./aggregate.js";

const ctx = { quotes: {}, fx: { USD: 1380 }, ref: "2026-09-02" };
const A = o => ({ active: 1, mode: "MANUAL", ...o });

describe("totals — 원금 미상 자산 처리 (P1-3 회귀)", () => {
  test("원금을 모르는 자산의 평가액을 수익으로 잡지 않는다", () => {
    const rows = buildRows([
      A({ id: 1, cls: "금융자산", cat: "주식", principal: 10_000_000, value: 12_000_000 }),
      A({ id: 2, cls: "금융자산", cat: "현금성", value: 5_000_000 })   // 원금 미상
    ], ctx);
    const t = totals(rows);

    assert.equal(t.asset, 17_000_000);
    assert.equal(t.basis, 10_000_000);
    assert.equal(t.pl, 2_000_000, "500만원이 수익에 섞이면 안 된다");
    assert.equal(t.unknownBasis, 5_000_000, "손익 산출 불가 금액은 따로 보고한다");
    // 프로토타입은 pl = 17,000,000 - 10,000,000 = 7,000,000 으로 350% 부풀렸다
    assert.notEqual(t.pl, 7_000_000);
  });

  test("수익률 분모는 원금이 확인된 자산만이다", () => {
    const rows = buildRows([
      A({ id: 1, cls: "금융자산", principal: 10_000_000, value: 12_000_000 }),
      A({ id: 2, cls: "금융자산", value: 90_000_000 })
    ], ctx);
    assert.equal(totals(rows).plPct, 20);
  });

  test("원금이 하나도 없으면 pl은 null이다", () => {
    const t = totals(buildRows([A({ id: 1, cls: "금융자산", value: 5_000_000 })], ctx));
    assert.equal(t.pl, null);
    assert.equal(t.plPct, null);
  });

  test("부채는 asset이 아니라 debt으로 잡히고 순자산에서 차감된다", () => {
    const t = totals(buildRows([
      A({ id: 1, cls: "부동산", principal: 780e6, value: 920e6 }),
      A({ id: 2, cls: "부채", cat: "주택담보대출", principal: 320e6, value: 248.5e6 })
    ], ctx));
    assert.equal(t.asset, 920e6);
    assert.equal(t.debt, 248.5e6);
    assert.equal(t.net, 671.5e6);
  });
});

describe("groupSum — 초과분 처리", () => {
  const rows = buildRows(
    Array.from({ length: 15 }, (_, i) =>
      A({ id: i + 1, cls: "금융자산", cat: "C" + i, principal: 100, value: (15 - i) * 100 })), ctx);

  test("top 지정 시 초과분을 버리지 않고 '기타'로 묶는다", () => {
    const g = groupSum(rows, "cat", { top: 5 });
    assert.equal(g.length, 5);
    assert.equal(g[4].k, "기타");

    const total = rows.reduce((s, r) => s + r.value, 0);
    assert.equal(g.reduce((s, x) => s + x.value, 0), total, "합계가 보존되어야 한다");
    assert.equal(g[4].count, 11);
  });

  test("top 미지정이면 전부 반환한다", () => {
    assert.equal(groupSum(rows, "cat").length, 15);
  });

  test("기본적으로 부채는 제외한다", () => {
    const withDebt = buildRows([
      A({ id: 1, cls: "금융자산", cat: "주식", value: 100 }),
      A({ id: 2, cls: "부채", cat: "신용대출", value: 50 })
    ], ctx);
    assert.equal(groupSum(withDebt, "cat").length, 1);
    assert.equal(groupSum(withDebt, "cat", { includeDebt: true }).length, 2);
  });
});

describe("대출 연결 (P1-2 회귀)", () => {
  test("같은 소유자의 부동산이 2건이면 추정 연결을 하지 않는다", () => {
    const assets = [
      A({ id: 1, cls: "부동산", cat: "아파트", owner: "본인", value: 900e6 }),
      A({ id: 2, cls: "부동산", cat: "오피스텔", owner: "본인", value: 235e6 }),
      A({ id: 3, cls: "부채", cat: "주택담보대출", owner: "본인", value: 248.5e6 })
    ];
    const links = resolveLoanLinks(assets);
    const rows = buildRows(assets, ctx);

    assert.equal(links.get(3).propertyId, null);
    assert.equal(links.get(3).ambiguous, true, "어느 쪽 담보인지 모호하다고 알려야 한다");

    // 프로토타입은 두 부동산 모두에 248.5e6을 표시해 이중계상했다
    assert.equal(loansFor(1, rows, links), 0);
    assert.equal(loansFor(2, rows, links), 0);
  });

  test("후보가 하나뿐이면 추정 연결한다", () => {
    const assets = [
      A({ id: 1, cls: "부동산", cat: "아파트", owner: "공동", value: 920e6 }),
      A({ id: 2, cls: "부채", cat: "주택담보대출", owner: "공동", value: 248.5e6 })
    ];
    const links = resolveLoanLinks(assets);
    assert.equal(links.get(2).propertyId, 1);
    assert.equal(links.get(2).inferred, true);
  });

  test("secures로 명시하면 모호함 없이 연결된다", () => {
    const assets = [
      A({ id: 1, cls: "부동산", owner: "본인", value: 900e6 }),
      A({ id: 2, cls: "부동산", owner: "본인", value: 235e6 }),
      A({ id: 3, cls: "부채", cat: "주택담보대출", owner: "본인", value: 248.5e6, secures: 2 })
    ];
    const links = resolveLoanLinks(assets);
    const rows = buildRows(assets, ctx);
    assert.equal(links.get(3).propertyId, 2);
    assert.equal(links.get(3).inferred, false);
    assert.equal(loansFor(2, rows, links), 248.5e6);
    assert.equal(loansFor(1, rows, links), 0);
  });
});

describe("loanToValue (P1-1 회귀)", () => {
  test("신용대출·보증금과 무관한 부동산을 분자·분모에 섞지 않는다", () => {
    // 프로토타입 샘플과 동일한 구성
    const assets = [
      A({ id: 1, cls: "부동산", cat: "아파트", owner: "공동", value: 920e6 }),
      A({ id: 2, cls: "부동산", cat: "오피스텔", owner: "본인", value: 235e6 }),
      A({ id: 3, cls: "부동산", cat: "전세보증금", owner: "배우자", value: 180e6 }),
      A({ id: 4, cls: "부채", cat: "주택담보대출", owner: "공동", value: 248.5e6 }),
      A({ id: 5, cls: "부채", cat: "신용대출", owner: "본인", value: 12e6 }),
      A({ id: 6, cls: "부채", cat: "보증금(임대)", owner: "본인", value: 20e6 })
    ];
    const rows = buildRows(assets, ctx);
    const { overall, byProperty } = loanToValue(rows, resolveLoanLinks(assets));

    // 담보 잡힌 아파트 1건만: 248.5 / 920 = 27.0%
    assert.ok(Math.abs(overall - 27.0) < 0.1, `${overall} — 27.0% 이어야 한다`);

    // 프로토타입은 (248.5+12+20) / (920+235+180) = 21.0% 를 표시했다
    assert.ok(Math.abs(overall - 21.0) > 5, "전체부채/전체부동산 방식이면 안 된다");

    const apt = byProperty.find(p => p.id === 1);
    assert.equal(apt.loan, 248.5e6);
    assert.equal(apt.equity, 671.5e6);

    const jeonse = byProperty.find(p => p.id === 3);
    assert.equal(jeonse.loan, 0, "전세보증금에 대출이 붙으면 안 된다");
    assert.equal(jeonse.ltv, 0);
  });

  test("담보 대출이 없으면 overall은 null이다", () => {
    const assets = [A({ id: 1, cls: "부동산", value: 500e6 })];
    assert.equal(loanToValue(buildRows(assets, ctx), resolveLoanLinks(assets)).overall, null);
  });
});
