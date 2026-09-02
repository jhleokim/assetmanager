import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1-test.js";
import { getMonth, getMonths, estimate, trimOutliers, fetchMonthFromApi, OPEN_MONTH_TTL_MS } from "./rtms.js";

const SCHEMA = new URL("./schema.sql", import.meta.url).pathname;
const item = (name, amt, area, d) =>
  `<item><aptNm>${name}</aptNm><dealAmount>${amt}</dealAmount><dealYear>2026</dealYear><dealMonth>8</dealMonth><dealDay>${d}</dealDay><excluUseAr>${area}</excluUseAr><floor>10</floor></item>`;
const xml = (items, total = items.length) =>
  `<response><header><resultCode>000</resultCode></header><body><items>${items.join("")}</items><numOfRows>1000</numOfRows><pageNo>1</pageNo><totalCount>${total}</totalCount></body></response>`;

/** 호출 횟수를 세는 가짜 fetch */
function fakeFetch(bodyFor){
  const calls = [];
  const f = async (url) => { calls.push(url); const b = bodyFor(url, calls.length); return { ok: true, status: 200, text: async () => b }; };
  f.calls = calls;
  return f;
}

describe("getMonth 캐시 (NETWORK.md N5)", () => {
  test("지난달은 한 번 받으면 다시 호출하지 않는다", async () => {
    const db = makeD1(SCHEMA);
    const f = fakeFetch(() => xml([item("송도더샵", "92,000", 84.98, 1)]));
    globalThis.fetch = f;
    const a = await getMonth({ db, lawd: "28185", ym: "202607", kind: "아파트", key: "K", today: "2026-09-02" });
    const b = await getMonth({ db, lawd: "28185", ym: "202607", kind: "아파트", key: "K", today: "2026-09-02" });
    assert.equal(a.cached, false);
    assert.equal(b.cached, true);
    assert.equal(f.calls.length, 1, "두 번째는 API를 부르면 안 된다");
    assert.equal(b.deals[0].amount, 920_000_000);
  });

  test("이번 달은 TTL 안에서만 캐시를 쓴다", async () => {
    const db = makeD1(SCHEMA);
    const f = fakeFetch(() => xml([item("A", "10,000", 50, 1)]));
    globalThis.fetch = f;
    const t0 = 1_000_000_000_000;
    await getMonth({ db, lawd: "11680", ym: "202609", kind: "아파트", key: "K", today: "2026-09-02", now: t0 });
    await getMonth({ db, lawd: "11680", ym: "202609", kind: "아파트", key: "K", today: "2026-09-02", now: t0 + 1000 });
    assert.equal(f.calls.length, 1);
    await getMonth({ db, lawd: "11680", ym: "202609", kind: "아파트", key: "K", today: "2026-09-02", now: t0 + OPEN_MONTH_TTL_MS + 1 });
    assert.equal(f.calls.length, 2, "TTL이 지나면 다시 받는다");
  });

  test("서버 키가 없으면 명확한 오류", async () => {
    const db = makeD1(SCHEMA);
    await assert.rejects(getMonth({ db, lawd: "11680", ym: "202607", kind: "아파트", key: "", today: "2026-09-02" }), /RTMS_KEY/);
  });
});

describe("페이지네이션 (N7)", () => {
  test("totalCount가 numOfRows를 넘으면 다음 페이지를 받는다", async () => {
    const f = fakeFetch((url) => {
      const page = Number(url.match(/pageNo=(\d+)/)[1]);
      const items = Array.from({ length: page === 1 ? 1000 : 234 }, (_, i) => item("X", "10,000", 60, 1));
      return xml(items, 1234);
    });
    globalThis.fetch = f;
    const deals = await fetchMonthFromApi({ lawd: "11680", ym: "202607", kind: "아파트", key: "K" });
    assert.equal(f.calls.length, 2);
    assert.equal(deals.length, 1234, "프로토타입은 500건에서 잘렸다");
  });
});

describe("getMonths 동시 조회 (N6)", () => {
  test("6개월을 받고 캐시 적중 수를 보고한다", async () => {
    const db = makeD1(SCHEMA);
    const f = fakeFetch(() => xml([item("A", "10,000", 50, 1)]));
    globalThis.fetch = f;
    const r1 = await getMonths({ db, lawd: "28185", kind: "아파트", months: 6, key: "K", today: "2026-09-02" });
    assert.equal(r1.months.length, 6);
    assert.equal(f.calls.length, 6);
    assert.equal(r1.cachedMonths, 0);
    const r2 = await getMonths({ db, lawd: "28185", kind: "아파트", months: 6, key: "K", today: "2026-09-02" });
    assert.equal(f.calls.length, 6, "재조회는 API 호출 0회");
    assert.equal(r2.cachedMonths, 6);
  });

  test("일부 달만 실패하면 나머지로 진행하고 errors에 남긴다", async () => {
    const db = makeD1(SCHEMA);
    globalThis.fetch = async (url) => /DEAL_YMD=202608/.test(url)
      ? { ok: false, status: 500, text: async () => "" }
      : { ok: true, status: 200, text: async () => xml([item("A", "10,000", 50, 1)]) };
    const r = await getMonths({ db, lawd: "28185", kind: "아파트", months: 3, key: "K", today: "2026-09-02" });
    assert.equal(r.deals.length, 2);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].ym, "202608");
  });

  test("전부 실패하면(인증 오류 등) 첫 오류를 던진다", async () => {
    const db = makeD1(SCHEMA);
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () =>
      `<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>` });
    await assert.rejects(getMonths({ db, lawd: "28185", kind: "아파트", months: 2, key: "K", today: "2026-09-02" }), /SERVICE_KEY/);
  });
});

describe("estimate — 평균이 아니라 이상치 제거 후 중위값 (P1-7)", () => {
  const deals = [
    { name: "송도더샵", area: 84.98, amount: 920e6, unit: 92000 / 84.98, date: "2026-08-20" },
    { name: "송도더샵", area: 84.98, amount: 910e6, unit: 91000 / 84.98, date: "2026-08-10" },
    { name: "송도더샵", area: 84.98, amount: 930e6, unit: 93000 / 84.98, date: "2026-07-25" },
    { name: "송도더샵", area: 84.97, amount: 915e6, unit: 91500 / 84.97, date: "2026-07-05" },
    { name: "송도더샵", area: 84.98, amount: 450e6, unit: 45000 / 84.98, date: "2026-06-30" },  // 증여성 저가
    { name: "다른단지", area: 84.98, amount: 600e6, unit: 60000 / 84.98, date: "2026-08-01" }
  ];

  test("특이 거래 1건이 시세를 끌어내리지 않는다", () => {
    const r = estimate(deals, { complex: "송도더샵", area: 84.98 });
    assert.equal(r.summary.n, 5);
    assert.equal(r.summary.outliers, 1);
    const mean = deals.slice(0, 5).reduce((s, d) => s + d.amount, 0) / 5;    // 프로토타입 방식 ≈ 8.25억
    assert.ok(r.summary.value > 900e6, `추정 ${r.summary.value} — 9억대여야 한다`);
    assert.ok(mean < 850e6, "단순 평균은 4.5억 거래에 끌려 내려간다");
  });

  test("다른 단지는 섞이지 않는다", () => {
    const r = estimate(deals, { complex: "송도더샵", area: 84.98 });
    assert.ok(r.matched.every(d => d.name === "송도더샵"));
  });

  test("매칭 실패 시 summary null + 안내", () => {
    const r = estimate(deals, { complex: "없는단지", area: 84.98 });
    assert.equal(r.summary, null);
    assert.match(r.msg, /찾지 못했습니다/);
  });

  test("trimOutliers는 표본 4개 미만이면 손대지 않는다", () => {
    assert.deepEqual(trimOutliers([1, 100, 3]), [1, 100, 3]);
  });
});
