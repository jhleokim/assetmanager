import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, periodKey, periodOf, shiftPeriod, normStartDay, yearPeriods, validate, fromCat,
         summarize, budgetStatus, fundBalance, fundStatus, annual, recurringDate, expandRecurring, FUND_CAT, FUND_SUB } from "./ledger.js";

const ST = defaultSettings();
let seq = 1;
const E = (date, cat, sub, amount, extra = {}) => fromCat(ST, { id: seq++, date, cat, sub, amount, ...extra });

describe("회계월 — 시작일 기준 기간", () => {
  test("시작일 1일이면 달력 월과 같다", () => {
    assert.equal(periodKey("2026-03-15", 1), "2026-03");
    const p = periodOf("2026-02", 1);
    assert.deepEqual([p.start, p.end, p.days], ["2026-02-01", "2026-02-28", 28]);
  });
  test("시작일 25일: 1/24는 전월 기간, 1/25부터 이번 기간", () => {
    assert.equal(periodKey("2026-01-24", 25), "2025-12");
    assert.equal(periodKey("2026-01-25", 25), "2026-01");
    const p = periodOf("2026-01", 25);
    assert.deepEqual([p.start, p.end, p.days], ["2026-01-25", "2026-02-24", 31]);
    const q = periodOf("2026-02", 25);
    assert.deepEqual([q.start, q.end, q.days], ["2026-02-25", "2026-03-24", 28]);
  });
  test("12월 기간은 해를 넘긴다", () => {
    const p = periodOf("2026-12", 25);
    assert.deepEqual([p.start, p.end], ["2026-12-25", "2027-01-24"]);
    assert.equal(shiftPeriod("2026-12", 1), "2027-01");
    assert.equal(shiftPeriod("2026-01", -1), "2025-12");
  });
  test("시작일은 1~28로 묶는다 (29~31은 달마다 없는 날이 생긴다)", () => {
    assert.equal(normStartDay(31), 28); assert.equal(normStartDay(0), 1); assert.equal(normStartDay("x"), 1);
  });
  test("연간 12기간", () => { assert.equal(yearPeriods(2026).length, 12); assert.equal(yearPeriods(2026)[11], "2026-12"); });
});

describe("검증 — 필수 항목이 빠지면 집계하지 않는다 (템플릿 규칙)", () => {
  test("정상 항목", () => assert.deepEqual(validate(E("2026-01-05", "식비", "마트", 45000), ST), []));
  test("날짜·금액·소분류 누락", () => {
    const err = validate({ date: "2026-1-5", amount: 0, kind: "expense", cat: "식비", sub: "" }, ST);
    assert.ok(err.some(x => x.includes("날짜")) && err.some(x => x.includes("금액")) && err.includes("소분류"));
  });
  test("존재하지 않는 날짜(2/30)는 거부", () => assert.ok(validate(E("2026-02-30", "식비", "마트", 1000), ST).length));
  test("대분류의 종류와 kind가 다르면 거부 (수입 분류에 지출 kind)", () => {
    assert.ok(validate({ date: "2026-01-01", amount: 100, kind: "expense", cat: "수입", sub: "월급" }, ST).some(x => x.includes("수입입니다")));
  });
  test("fromCat: 대분류에서 kind·fund 를 결정한다", () => {
    assert.equal(E("2026-01-01", "수입", "월급", 1).kind, "income");
    assert.equal(E("2026-01-01", "저축", "적금", 1).kind, "saving");
    const f = E("2026-01-01", FUND_CAT, "여행", 1); assert.equal(f.kind, "expense"); assert.equal(f.fund, true);
    assert.equal(E("2026-01-01", "이체", "카드대금", 1).kind, "transfer");
  });
  test("환불은 음수 지출로 허용, 0원은 거부", () => {
    assert.deepEqual(validate(E("2026-01-01", "식비", "외식", -12000), ST), []);
    assert.ok(validate(E("2026-01-01", "식비", "외식", 0), ST).length);
  });
});

describe("월 요약 — 저축은 지출이 아니고, 이체는 어디에도 없다", () => {
  const entries = [
    E("2026-01-01", "수입", "월급", 3_500_000), E("2026-01-02", "수입", "상여금", 4_000_000), E("2026-01-03", "수입", "부수입", 100_000),
    E("2026-01-01", "고정지출", "주거비", 100_000, { method: "신용카드" }), E("2026-01-02", "고정지출", "주거비", 200_000, { method: "신용카드" }),
    E("2026-01-04", "고정지출", "통신비", 30_000, { method: "신용카드" }),
    E("2026-01-04", "저축", "적금", 900_000), E("2026-01-05", "저축", "예금", 300_000), E("2026-01-07", "저축", "대출상환", 400_000),
    E("2026-01-05", "저축", FUND_SUB, 500_000),                                    // 예비비 입금
    E("2026-01-08", "식비", "마트", 400_000, { method: "신용카드" }), E("2026-01-09", "식비", "편의점", 100_000, { method: "체크카드", tag: "반성" }),
    E("2026-01-10", "식비", "외식", 65_000, { method: "체크카드", tag: "반성" }),
    E("2026-01-12", FUND_CAT, "여행", 300_000, { method: "신용카드" }),            // 예비비 지출
    E("2026-01-14", "이체", "카드대금", 2_000_000),                                 // 카드대금 결제 — 지출이 아니다
    E("2026-02-01", "식비", "마트", 999_999)                                        // 다음 달
  ];
  const s = summarize(entries, ST, { from: "2026-01-01", to: "2026-01-31", today: "2026-01-15" });

  test("수입·저축·지출 합계", () => {
    assert.equal(s.income, 7_600_000);
    assert.equal(s.saving, 2_100_000, "예비비 입금도 저축이다");
    assert.equal(s.expense, 895_000, "월 지출 = 고정 330,000 + 변동 565,000");
    assert.equal(s.fixed, 330_000); assert.equal(s.variable, 565_000);
  });
  test("이체는 수입·지출·저축 어디에도 들어가지 않는다", () => {
    assert.equal(s.transfer, 2_000_000);
    assert.equal(s.expense + s.saving + s.income, 7_600_000 + 2_100_000 + 895_000);
    assert.ok(!s.byCat.has("이체"));
  });
  test("항등식: 수입 − 지출 − 저축 = 잔여", () => {
    assert.equal(s.unallocated, s.income - s.expense - s.saving);
    assert.equal(s.unallocated, 4_605_000);
  });
  test("예비비 지출은 월 지출과 분리되고 순저축에서 되돌린다", () => {
    assert.equal(s.fundSpend, 300_000); assert.equal(s.fundDeposit, 500_000);
    assert.equal(s.out, 1_195_000, "총 지출(월+예비비)");
    assert.equal(s.netSaving, 1_800_000, "순저축 = 저축 − 예비비 지출");
  });
  test("저축률 = 저축 / 수입", () => assert.ok(Math.abs(s.savingRate - 2_100_000 / 7_600_000) < 1e-12));
  test("결제수단별은 지출만, 태그는 전부", () => {
    assert.equal(s.byMethod.get("신용카드"), 100_000 + 200_000 + 30_000 + 400_000 + 300_000);
    assert.equal(s.byMethod.get("체크카드"), 165_000);
    assert.equal(s.byTag.get("반성"), 165_000);
  });
  test("무지출 Day: 변동지출 없는 날만, 오늘까지만, 고정지출은 무시", () => {
    // 변동지출 있는 날: 8,9,10 (예비비 12일은 월 지출이 아니므로 무지출로 본다)
    assert.equal(s.elapsedDays, 15);
    assert.equal(s.noSpendDays.length, 12);
    assert.ok(s.noSpendDays.includes("2026-01-01"), "고정지출만 있는 날은 무지출");
    assert.ok(!s.noSpendDays.includes("2026-01-08"));
    assert.ok(!s.noSpendDays.includes("2026-01-20"), "미래는 세지 않는다");
  });
  test("기간 밖 항목은 제외", () => assert.equal(s.count, 14));
  test("수입이 없으면 저축률은 null", () => assert.equal(summarize([], ST, { from: "2026-01-01", to: "2026-01-31" }).savingRate, null));
});

describe("예산", () => {
  test("경과 비율로 초과 속도(pace)를 낸다", () => {
    const s = summarize([E("2026-01-05", "식비", "마트", 300_000)], ST, { from: "2026-01-01", to: "2026-01-31", today: "2026-01-10" });
    const b = budgetStatus(s, { "식비": 600_000, _expense: 2_000_000 }, ST);
    const food = b.cats.find(x => x.name === "식비");
    assert.equal(food.remain, 300_000); assert.equal(food.pct, 0.5);
    // 10/31 경과인데 절반을 썼다 → pace 1.55
    assert.ok(Math.abs(food.pace - 0.5 / (10 / 31)) < 1e-9);
    assert.equal(b.kinds[0].name, "지출");
  });
  test("예산 없는 분류는 표에 없다", () => {
    const s = summarize([], ST, { from: "2026-01-01", to: "2026-01-31" });
    assert.equal(budgetStatus(s, {}, ST).cats.length, 0);
  });
});

describe("예비비", () => {
  const entries = [E("2026-01-05", "저축", FUND_SUB, 500_000), E("2026-03-01", "저축", FUND_SUB, 500_000),
    E("2026-02-12", FUND_CAT, "여행", 300_000), E("2026-05-12", FUND_CAT, "여행", 100_000), E("2026-06-01", FUND_CAT, "경조사", 50_000)];
  test("잔액 = 입금 − 지출", () => {
    assert.deepEqual(fundBalance(entries), { deposit: 1_000_000, spend: 450_000, balance: 550_000 });
    assert.equal(fundBalance(entries, "2026-02-28").balance, 200_000);
  });
  test("분류별 연 예산 현황", () => {
    const st = { ...ST, fundBudgets: { "여행": 1_000_000 } };
    const f = fundStatus(entries, st, 2026);
    const tr = f.find(x => x.name === "여행");
    assert.equal(tr.spent, 400_000); assert.equal(tr.remain, 600_000);
    assert.equal(f.find(x => x.name === "건강").spent, 0);
  });
});

describe("연간표 — 통합시트", () => {
  const entries = [E("2026-01-10", "수입", "월급", 3_000_000), E("2026-02-10", "수입", "월급", 3_000_000), E("2026-03-10", "수입", "월급", 3_000_000),
    E("2026-01-15", "식비", "마트", 100_000), E("2026-03-15", "식비", "마트", 200_000), E("2026-02-01", "저축", "적금", 500_000),
    E("2026-02-20", "옛분류", "옛소분류", 70_000, { kind: "expense" })];     // 설정에서 지운 분류
  test("평균은 지난 기간 수로 나눈다", () => {
    const a = annual(entries, ST, 2026, { today: "2026-03-20" });
    assert.equal(a.elapsed, 3);
    assert.equal(a.income.total, 9_000_000); assert.equal(a.income.avg, 3_000_000);
    const food = a.rows.find(r => r.cat === "식비");
    assert.equal(food.total, 300_000); assert.equal(food.avg, 100_000);
    assert.deepEqual(food.vals.slice(0, 3), [100_000, 0, 200_000]);
  });
  test("연도가 끝났으면 12로 나눈다", () => assert.equal(annual(entries, ST, 2026, { today: "2027-05-01" }).income.avg, 750_000));
  test("설정에서 사라진 분류도 표에서 사라지지 않는다", () => {
    const a = annual(entries, ST, 2026, { today: "2026-03-20" });
    const old = a.rows.find(r => r.cat === "옛분류");
    assert.ok(old && old.unknown); assert.equal(old.total, 70_000);
    assert.equal(a.expense.total, 370_000);
  });
  test("항등식은 연간 합계에서도 성립", () => {
    const a = annual(entries, ST, 2026, { today: "2026-03-20" });
    assert.equal(a.unallocated.total, a.income.total - a.expense.total - a.saving.total);
  });
});

describe("고정지출 규칙", () => {
  test("시작일 25일이면 결제일 5일은 다음 달 5일", () => {
    const p = periodOf("2026-01", 25);
    assert.equal(recurringDate({ day: 5 }, p, 25), "2026-02-05");
    assert.equal(recurringDate({ day: 27 }, p, 25), "2026-01-27");
  });
  test("31일 규칙은 짧은 달에서 말일로", () => assert.equal(recurringDate({ day: 31 }, periodOf("2026-02", 1), 1), "2026-02-28"));
  test("기간당 규칙당 1건만 만든다", () => {
    const rules = [{ id: 7, name: "관리비", amount: 150000, cat: "고정지출", sub: "주거비", day: 10, method: "계좌이체" },
                   { id: 8, name: "옛규칙", amount: 1, cat: "없는분류", sub: "x", day: 1 }, { id: 9, active: false, amount: 1, cat: "고정지출", sub: "통신비", day: 1 }];
    const made = expandRecurring(rules, "2026-01", ST, []);
    assert.equal(made.length, 1, "유효하지 않은 규칙·비활성 규칙은 건너뛴다");
    assert.equal(made[0].date, "2026-01-10"); assert.equal(made[0].rule, 7); assert.equal(made[0].kind, "expense");
    const again = expandRecurring(rules, "2026-01", ST, [{ ...made[0], id: 1 }]);
    assert.equal(again.length, 0, "이미 만든 기간에는 다시 만들지 않는다");
    assert.equal(expandRecurring(rules, "2026-02", ST, [{ ...made[0], id: 1 }]).length, 1, "다른 기간은 만든다");
  });
});
