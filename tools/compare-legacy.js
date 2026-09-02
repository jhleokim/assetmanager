/** 프로토타입(기존)과 core/(수정본)의 계산 결과를 나란히 비교한다.
 *  샘플 데이터는 prototype/index.html 의 loadSample()과 같은 값이다.
 *  실행: node tools/compare-legacy.js */
import { accrued, accruedInstallment } from "../core/valuation.js";
import { buildRows, totals, resolveLoanLinks, loanToValue } from "../core/aggregate.js";
import { reconstruct } from "../core/timeseries.js";

const REF = "2026-09-02";
const won = n => n == null ? "—" : Math.round(n).toLocaleString("ko-KR") + "원";
const pct = n => n == null ? "—" : n.toFixed(1) + "%";

/* ── 기존 프로토타입의 계산식 (비교용 재현) ────────────────────────────── */
const legacyAccrued = (p, r, start, ref) => {
  const d = Math.max(0, Math.round((new Date(ref) - new Date(start)) / 86400000));
  return p * (r / 100) * d / 365;                       // end를 보지 않는다
};

console.log("=".repeat(74));
console.log(" 프로토타입 vs core/  —  기준일 " + REF);
console.log("=".repeat(74));

/* P0-1 만기 */
console.log("\n[P0-1] 예금 이자 — 만기 반영\n");
const deposits = [
  { name: "하나 정기예금 12M", p: 80_000_000, r: 3.45, s: "2025-09-01", e: "2026-09-01" },
  { name: "주거래 정기예금",   p: 44_200_000, r: 3.20, s: "2026-01-15", e: "2027-01-15" },
  { name: "주택청약종합저축",  p: 17_800_000, r: 2.80, s: "2018-03-05", e: null }
];
console.log("  " + "자산".padEnd(20) + "기존".padStart(16) + "수정본".padStart(16) + "차이".padStart(16));
let dOld = 0, dNew = 0;
for(const d of deposits){
  const o = d.p + legacyAccrued(d.p, d.r, d.s, REF);
  const n = d.p + accrued({ principal: d.p, ratePct: d.r, start: d.s, end: d.e, ref: REF }).interest;
  dOld += o; dNew += n;
  console.log("  " + d.name.padEnd(20) + won(o).padStart(16) + won(n).padStart(16) +
    won(n - o).padStart(16) + (d.e && REF > d.e ? "  ← 만기 경과" : ""));
}
console.log("  " + "합계".padEnd(20) + won(dOld).padStart(16) + won(dNew).padStart(16) +
  won(dNew - dOld).padStart(16));

console.log("\n  5년 방치 시 (2031-09-02) 하나 정기예금:");
console.log("    기존   " + won(80e6 + legacyAccrued(80e6, 3.45, "2025-09-01", "2031-09-02")));
console.log("    수정본 " + won(80e6 + accrued({ principal: 80e6, ratePct: 3.45,
  start: "2025-09-01", end: "2026-09-01", ref: "2031-09-02" }).interest) + "  (만기에서 정지)");

/* 적금 */
console.log("\n  적금(월 100만원 × 12개월, 4%)을 거치식으로 계산했을 때:");
const inst = accruedInstallment({ monthly: 1_000_000, ratePct: 4, start: "2025-09-01", ref: "2026-09-01" });
const asDep = accrued({ principal: 13_000_000, ratePct: 4, start: "2025-09-01", ref: "2026-09-01" }).interest;
console.log("    기존(거치식 취급) 이자 " + won(asDep));
console.log("    수정본(적립식)    이자 " + won(inst.interest) +
  `  (${(inst.interest / asDep * 100).toFixed(0)}%)`);

/* P1-1 / P1-2 LTV */
console.log("\n[P1-1·P1-2] LTV와 담보 연결\n");
const A = o => ({ active: 1, mode: "MANUAL", ...o });
const assets = [
  A({ id: 1, cls: "부동산", cat: "아파트",   owner: "공동",   name: "송도 자택",   principal: 780e6, value: 920e6 }),
  A({ id: 2, cls: "부동산", cat: "오피스텔", owner: "본인",   name: "구월동 오피스텔", principal: 210e6, value: 235e6 }),
  A({ id: 3, cls: "부동산", cat: "전세보증금", owner: "배우자", name: "전세보증금", principal: 180e6, value: 180e6 }),
  A({ id: 4, cls: "부채", cat: "주택담보대출", owner: "공동", name: "자택 주담대", principal: 320e6, value: 248.5e6 }),
  A({ id: 5, cls: "부채", cat: "신용대출",    owner: "본인", name: "마이너스 통장", principal: 30e6, value: 12e6 }),
  A({ id: 6, cls: "부채", cat: "보증금(임대)", owner: "본인", name: "임대보증금",   principal: 20e6, value: 20e6 })
];
const ctx = { quotes: {}, fx: { USD: 1380 }, ref: REF };
const rows = buildRows(assets, ctx);
const links = resolveLoanLinks(assets);
const ltv = loanToValue(rows, links);

const legacyDebt = 248.5e6 + 12e6 + 20e6;
const legacyRe = 920e6 + 235e6 + 180e6;
console.log("  기존 LTV   " + pct(legacyDebt / legacyRe * 100) + "   (전체부채 / 전체부동산 — 신용대출·전세보증금 혼입)");
console.log("  수정본 LTV " + pct(ltv.overall) + "   (담보대출 / 담보 부동산)");
console.log("\n  부동산별:");
for(const p of ltv.byProperty)
  console.log("    " + p.name.padEnd(18) + "대출 " + won(p.loan).padStart(14) +
    "  순자산 " + won(p.equity).padStart(14) + "  LTV " + pct(p.ltv));

/* P1-3 원금 미상 */
console.log("\n[P1-3] 원금을 모르는 자산\n");
const mixed = buildRows([
  A({ id: 1, cls: "금융자산", cat: "주식",   principal: 10_000_000, value: 12_000_000 }),
  A({ id: 2, cls: "금융자산", cat: "현금성", value: 5_000_000 })
], ctx);
const t = totals(mixed);
console.log("  총자산 " + won(t.asset) + " (원금 확인 1,000만 / 원금 미상 500만)");
console.log("  기존 평가손익   " + won(17_000_000 - 10_000_000) + "  수익률 " + pct(70) + "  ← 500만원이 수익에 섞임");
console.log("  수정본 평가손익 " + won(t.pl) + "  수익률 " + pct(t.plPct) +
  "  (손익 산출 불가 " + won(t.unknownBasis) + " 별도 표기)");

/* P0-2 원금 추이 */
console.log("\n[P0-2] 투입원금 시계열\n");
const r = reconstruct({
  assets: [A({ id: 1, cls: "금융자산", cat: "ETF", code: "360750", market: "KR",
               qty: 1139, avg: 20147, mode: "AUTO", cur: "KRW" })],
  trades: [
    { asset: 1, date: "2025-02-05", side: "매수", qty: 417, price: 21613 },
    { asset: 1, date: "2025-02-24", side: "매수", qty:  25, price: 21560 },
    { asset: 1, date: "2025-06-27", side: "매수", qty: 300, price: 19875 },
    { asset: 1, date: "2025-11-14", side: "매수", qty: 297, price: 22380 },
    { asset: 1, date: "2026-03-20", side: "매수", qty: 100, price: 25120 }
  ],
  history: { "KR:360750": { "2024-09-02": 19000, "2025-06-27": 19875, "2026-09-02": 25500 } },
  today: REF, years: 2
});
const pick = [0, Math.floor(r.dates.length / 3), Math.floor(r.dates.length * 2 / 3), r.dates.length - 1];
console.log("  " + "시점".padEnd(14) + "기존 원금".padStart(16) + "수정본 원금".padStart(16));
const legacyPrincipal = 1139 * 20147;
for(const i of pick)
  console.log("  " + r.dates[i].padEnd(14) + won(legacyPrincipal).padStart(16) + won(r.basis[i]).padStart(16));
console.log("\n  기존은 전 구간이 동일한 상수 — 시계열이 아니었다.");
console.log("=".repeat(74));
