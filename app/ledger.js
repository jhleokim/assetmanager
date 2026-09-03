/** 가계부 탭 — 월별 · 연간 · 예비비 · 설정. 계산은 전부 core/ledger.js, 여기는 그리기와 입력만.
 *  innerHTML 없음. 데이터는 S.db.ledger (같은 암호화 봉투). */
import { h, replace, clear, table } from "./core/html.js";
import * as LG from "./core/ledger.js";
import { fmtWon, fmtNum, pnum, todayISO, addDays, PAL, C } from "./format.js";
import { donutChart, groupedBar, stackedBar, emptyChart } from "./charts.js";

let X = null;                                  // main.js 가 주는 컨텍스트 {S, save, nextId, touch, status, openModal, closeModal}
const V = { view: "month", key: null, year: null };
const $ = (s, root = document) => root.querySelector(s);
const L = () => X.S.db.ledger;
const st = () => L().settings;
const today = () => todayISO();
const won = v => fmtNum(Math.round(v));
const card = (t, v, s, cls) => h("div", { class: "card" }, h("div", { class: "t" }, t), h("div", { class: "v " + (cls || "") }, v), h("div", { class: "s" }, s || ""));
const KIND_CLS = { income: "k-in", saving: "k-sv", expense: "", transfer: "k-tr" };
const bar = (pct, cls) => h("div", { class: "lgbar " + (cls || "") }, h("i", { style: { width: Math.max(0, Math.min(100, (pct || 0) * 100)) + "%" } }));
const byDateDesc = (a, b) => a.date === b.date ? b.id - a.id : (a.date < b.date ? 1 : -1);

/* ── 진입 ─────────────────────────────────────────────────────────────── */
export function initLedger(ctx){
  X = ctx;
  const t = today();
  V.key = LG.periodKey(t, st().startDay); V.year = +t.slice(0, 4);
  const root = $("#p-ledger");
  replace(root,
    h("div", { class: "row lgnav", id: "lgNav" }, [["month", "월별"], ["year", "연간"], ["fund", "예비비"], ["set", "가계부 설정"]]
      .map(([k, l]) => h("button", { class: "btn" + (V.view === k ? " primary" : ""), type: "button", "data-view": k }, l)),
      h("span", { class: "note", id: "lgHint" })),
    h("div", { id: "lg-month" }), h("div", { id: "lg-year" }), h("div", { id: "lg-fund" }), h("div", { id: "lg-set" }));
  $("#lgNav").addEventListener("click", e => { const b = e.target.closest("button[data-view]"); if(b){ V.view = b.dataset.view; renderLedger(); } });
}
export function renderLedger(){
  if(!X) return;
  $("#lgNav").querySelectorAll("button[data-view]").forEach(b => b.classList.toggle("primary", b.dataset.view === V.view));
  ["month", "year", "fund", "set"].forEach(k => { const n = $("#lg-" + k); n.hidden = V.view !== k; if(V.view !== k) clear(n); });
  const sd = st().startDay;
  $("#lgHint").textContent = "회계월 시작일 " + sd + "일 · 항목 " + L().entries.length + "건 · 규칙 " + L().recurring.length + "건";
  ({ month: renderMonth, year: renderYear, fund: renderFund, set: renderSet })[V.view]();
}

/* ── 데이터 조작 ───────────────────────────────────────────────────────── */
function addEntry(raw){
  const e = LG.fromCat(st(), { ...raw, amount: Math.round(pnum(raw.amount)) });
  const err = LG.validate(e, st());
  if(err.length){ X.status("입력 확인: " + err.join(", ")); return null; }
  e.id = X.nextId(); X.touch(e); L().entries.push(e); X.save();
  return e;
}
function updateEntry(id, patch){
  const cur = L().entries.find(x => x.id === id); if(!cur) return false;
  const e = LG.fromCat(st(), { ...cur, ...patch, amount: Math.round(pnum(patch.amount ?? cur.amount)) });
  const err = LG.validate(e, st());
  if(err.length){ alert("입력 확인: " + err.join(", ")); return false; }
  Object.assign(cur, e); X.touch(cur); X.save(); return true;
}
function delEntry(id){
  X.S.db.tomb["ledger.entries:" + id] = Date.now();
  L().entries = L().entries.filter(x => x.id !== id); X.save();
}
function saveSettings(patch){ Object.assign(st(), patch); st().updatedAt = Date.now(); X.save(); }

/* ── 공통 위젯 ────────────────────────────────────────────────────────── */
const opt = (vals, cur) => vals.map(v => h("option", { value: v, selected: v === cur }, v));
function catList({ transfer = true, kinds } = {}){
  const cats = st().cats.filter(c => !kinds || kinds.includes(c.kind)).map(c => c.name);
  return transfer ? [...cats, "이체"] : cats;
}
const subsOf = cat => cat === "이체" ? LG.TRANSFER_SUBS : ((LG.catOf(st(), cat) || {}).subs || []);
/** 대분류 → 소분류 연동 select 한 쌍 */
function catSubPair(idPrefix, cat, sub, list){
  const selCat = h("select", { id: idPrefix + "-cat" }, opt(list, cat));
  const selSub = h("select", { id: idPrefix + "-sub" }, opt(subsOf(cat), sub));
  selCat.addEventListener("change", () => replace(selSub, opt(subsOf(selCat.value))));
  return [selCat, selSub];
}
function field(id, label, ctrl, w){ if(w) ctrl.style.width = w + "px"; return h("div", { class: "field" }, h("label", { for: id }, label), ctrl); }
/** 빠른 입력 줄. Enter 로도 추가. */
function quickRow(prefix, { date, cats, onAdd, defaults = {} }){
  const [selCat, selSub] = catSubPair(prefix, defaults.cat || cats[0], defaults.sub, cats);
  const inDate = h("input", { type: "date", id: prefix + "-date", value: date });
  const inAmt = h("input", { type: "text", class: "num", id: prefix + "-amt", placeholder: "예: 45,000 · 1.2만" });
  const inMemo = h("input", { type: "text", id: prefix + "-memo", placeholder: "내용" });
  const selMet = h("select", { id: prefix + "-met" }, opt(["", ...st().methods], defaults.method || ""));
  const selTag = h("select", { id: prefix + "-tag" }, opt(["", ...st().tags], ""));
  const btn = h("button", { class: "btn primary", type: "button", id: prefix + "-add" }, "＋ 추가");
  const go = () => {
    const e = onAdd({ date: inDate.value, cat: selCat.value, sub: selSub.value, amount: inAmt.value, memo: inMemo.value.trim(), method: selMet.value, tag: selTag.value });
    if(e){ inAmt.value = ""; inMemo.value = ""; inAmt.focus(); }
  };
  btn.addEventListener("click", go);
  const row = h("div", { class: "qa" }, field(prefix + "-date", "날짜", inDate, 135), field(prefix + "-cat", "대분류", selCat, 105), field(prefix + "-sub", "소분류", selSub, 115),
    field(prefix + "-amt", "금액(원)", inAmt, 120), field(prefix + "-memo", "내용", inMemo, 170), field(prefix + "-met", "결제수단", selMet, 95), field(prefix + "-tag", "태그", selTag, 75), btn);
  row.addEventListener("keydown", e => { if(e.key === "Enter" && e.target.tagName !== "BUTTON"){ e.preventDefault(); go(); } });
  return row;
}
const amountCell = e => h("span", { class: KIND_CLS[e.kind] + (e.amount < 0 ? " neg" : "") }, (e.kind === "income" ? "+" : e.kind === "expense" ? "−" : "") + won(Math.abs(e.amount)));
function entryTable(entries, { showCat = true, emptyMsg } = {}){
  const t = table({ columns: [
      { key: "date", label: "날짜", align: "c" },
      ...(showCat ? [{ key: "cat", label: "대분류", align: "c", render: e => [e.cat === "이체" ? h("span", { class: "tag" }, "이체") : e.cat, e.rule != null ? h("span", { class: "badge ok", title: "고정지출 규칙에서 생성" }, "규칙") : null] }] : []),
      { key: "sub", label: "소분류", align: "c" }, { key: "memo", label: "내용" },
      { key: "amount", label: "금액", align: "r", render: amountCell },
      { key: "method", label: "결제수단", align: "c" }, { key: "tag", label: "태그", align: "c", render: e => e.tag ? h("span", { class: "tag" }, e.tag) : "" },
      { key: "_x", label: "", align: "c", render: e => h("button", { class: "btn sm", type: "button", "data-del": e.id, title: "삭제" }, "✕") }],
    rows: entries, rowAttrs: e => ({ "data-id": e.id, tabindex: 0, title: "더블클릭 또는 Enter: 수정" }), empty: emptyMsg || "아직 입력이 없습니다" });
  t.addEventListener("click", e => { const b = e.target.closest("button[data-del]"); if(!b) return;
    const id = Number(b.dataset.del), en = L().entries.find(x => x.id === id);
    if(en && confirm(en.date + " " + (en.memo || en.sub) + " " + won(en.amount) + "원 항목을 삭제할까요?")){ delEntry(id); renderLedger(); X.status("삭제됨"); } });
  t.addEventListener("dblclick", e => { const tr = e.target.closest("tr[data-id]"); if(tr) openEntryForm(Number(tr.dataset.id)); });
  t.addEventListener("keydown", e => { const tr = e.target.closest("tr[data-id]"); if(!tr || e.target !== tr) return;
    if(e.key === "Enter"){ e.preventDefault(); openEntryForm(Number(tr.dataset.id)); }
    else if(e.key === "ArrowDown" && tr.nextElementSibling){ e.preventDefault(); tr.nextElementSibling.focus(); }
    else if(e.key === "ArrowUp" && tr.previousElementSibling){ e.preventDefault(); tr.previousElementSibling.focus(); } });
  return t;
}
function openEntryForm(id){
  const e = L().entries.find(x => x.id === id); if(!e) return;
  const [selCat, selSub] = catSubPair("le", e.cat, e.sub, catList());
  X.openModal(h("h3", null, "항목 수정 — " + e.date),
    h("div", { class: "bd" }, h("fieldset", null, h("legend", null, "내용"), h("div", { class: "fgrid" },
      field("le-date", "날짜", h("input", { type: "date", id: "le-date", value: e.date })), field("le-cat", "대분류", selCat), field("le-sub", "소분류", selSub),
      field("le-amt", "금액(원)", h("input", { type: "text", class: "num", id: "le-amt", value: fmtNum(e.amount) })),
      field("le-memo", "내용", h("input", { type: "text", id: "le-memo", value: e.memo || "" })),
      field("le-met", "결제수단", h("select", { id: "le-met" }, opt(["", ...st().methods], e.method || ""))),
      field("le-tag", "태그", h("select", { id: "le-tag" }, opt(["", ...st().tags], e.tag || ""))))),
      h("div", { class: "note" }, "환불·취소는 금액을 음수로 적으면 같은 분류에서 빠집니다. 카드대금 결제처럼 내 돈이 자리만 옮기는 건 [이체]로 — 지출에 두 번 잡히지 않습니다.")),
    h("div", { class: "ft" }, h("button", { class: "btn danger", id: "leDel", type: "button" }, "삭제"),
      h("button", { class: "btn", id: "leCancel", type: "button" }, "취소"), h("button", { class: "btn primary", id: "leSave", type: "button" }, "저장")));
  $("#leCancel").addEventListener("click", X.closeModal);
  $("#leDel").addEventListener("click", () => { if(confirm("이 항목을 삭제할까요?")){ delEntry(id); X.closeModal(); renderLedger(); } });
  $("#leSave").addEventListener("click", () => {
    if(updateEntry(id, { date: $("#le-date").value, cat: selCat.value, sub: selSub.value, amount: $("#le-amt").value, memo: $("#le-memo").value.trim(), method: $("#le-met").value, tag: $("#le-tag").value })){
      X.closeModal(); renderLedger(); X.status("수정 저장"); } });
}
function sumTable(rows, label, total){
  return table({ columns: [{ key: "k", label }, { key: "v", label: "금액", align: "r", render: r => won(r.v) },
    { key: "p", label: "비중", align: "r", render: r => total ? (r.v / total * 100).toFixed(1) + "%" : "" }], rows, empty: "없음" });
}

/* ── 1. 월별 ──────────────────────────────────────────────────────────── */
function renderMonth(){
  const S = st(), P = LG.periodOf(V.key, S.startDay), t = today();
  const entries = L().entries.filter(e => e.date >= P.start && e.date <= P.end).sort(byDateDesc);
  const sum = LG.summarize(L().entries, S, { from: P.start, to: P.end, today: t });
  const pending = LG.expandRecurring(L().recurring, V.key, S, L().entries);
  const bud = LG.budgetStatus(sum, S.budgets, S);
  const inPeriod = t >= P.start && t <= P.end;
  const root = $("#lg-month");
  const nav = h("div", { class: "box" }, h("div", { class: "bd row" },
    h("button", { class: "btn", type: "button", id: "lgPrev" }, "◀"), h("b", { style: { fontSize: "15px" } }, P.label), h("button", { class: "btn", type: "button", id: "lgNext" }, "▶"),
    h("span", { class: "note" }, P.start + " ~ " + P.end + " · " + P.days + "일" + (inPeriod ? " · 오늘 " + sum.elapsedDays + "일째" : "")),
    inPeriod ? null : h("button", { class: "btn sm", type: "button", id: "lgToday" }, "이번 달로"),
    h("span", { class: "spacer", style: { flex: 1 } }),
    h("button", { class: "btn" + (pending.length ? " accent-on" : ""), type: "button", id: "lgFill", disabled: !pending.length },
      pending.length ? "고정지출 채우기 (" + pending.length + "건 미기입)" : "고정지출 규칙 " + L().recurring.length + "건 · 모두 기입됨")));
  const rate = sum.savingRate == null ? "—" : (sum.savingRate * 100).toFixed(1) + "%";
  const cards = h("div", { class: "cards" },
    card("수입", fmtWon(sum.income), sum.byKind.size ? "" : "월급·상여·부수입"),
    card("지출", fmtWon(sum.expense), "고정 " + fmtWon(sum.fixed) + " · 변동 " + fmtWon(sum.variable), "down"),
    card("저축", fmtWon(sum.saving), "저축률 " + rate + (sum.fundDeposit ? " · 예비비 입금 " + fmtWon(sum.fundDeposit) : ""), "up"),
    card("잔여", fmtWon(sum.unallocated), "수입 − 지출 − 저축", sum.unallocated < 0 ? "down" : ""),
    card("예비비 사용", fmtWon(sum.fundSpend), sum.fundSpend ? "월 지출과 별도 · 순저축 " + fmtWon(sum.netSaving) : "예비비에서 쓴 돈"),
    card("무지출 Day", sum.noSpendDays.length + "일", sum.elapsedDays ? "지난 " + sum.elapsedDays + "일 중 · 고정지출 제외" : ""));
  const quick = h("div", { class: "box" }, h("h3", null, "빠른 입력 ", h("span", { class: "hint" }, "대분류를 고르면 수입·저축·지출이 정해집니다. Enter로 추가")),
    h("div", { class: "bd" }, quickRow("lq", { date: inPeriod ? t : P.start, cats: catList(), defaults: { cat: "식비" },
      onAdd: raw => { const e = addEntry(raw); if(e){ renderLedger(); X.status("추가: " + e.cat + "/" + e.sub + " " + won(e.amount) + "원"); } return e; } })));
  const goalRows = bud.kinds.map(g => h("div", { class: "lgb" }, h("div", { class: "row" }, h("b", null, g.name + (g.goal ? " 목표" : " 예산")),
      h("span", { class: "note" }, won(g.spent) + " / " + won(g.budget) + " (" + Math.round((g.pct || 0) * 100) + "%)")), bar(g.pct, g.goal ? (g.pct >= 1 ? "ok" : "") : (g.pct > 1 ? "over" : g.pace > 1 ? "warn" : ""))));
  const budRows = bud.cats.map(g => h("div", { class: "lgb" }, h("div", { class: "row" }, h("span", null, g.name),
      g.pace != null && g.pace > 1 && g.pct < 1 ? h("span", { class: "badge est", title: "지금 속도면 월말에 예산을 넘습니다" }, "속도 " + g.pace.toFixed(1) + "×") : null,
      g.pct >= 1 ? h("span", { class: "badge stale" }, "초과 " + won(-g.remain)) : null,
      h("span", { class: "spacer", style: { flex: 1 } }), h("span", { class: "note" }, won(g.spent) + " / " + won(g.budget))), bar(g.pct, g.pct > 1 ? "over" : g.pace > 1 ? "warn" : "")));
  const budget = h("div", { class: "box" }, h("h3", null, "예산 · 목표 ", h("span", { class: "hint" }, "경과 " + Math.round(bud.elapsedRatio * 100) + "% 기준")),
    h("div", { class: "bd" }, goalRows.length || budRows.length ? [goalRows, budRows] : h("div", { class: "note" }, "[가계부 설정]에서 대분류별 월 예산과 수입·저축 목표를 정하면 여기에 진행률이 보입니다.")));
  const exp = [...sum.byCat.entries()].filter(([k]) => LG.kindOf(S, k) === "expense" && !LG.isFundCat(S, k)).sort((a, b) => b[1] - a[1]);
  const chart = h("div", { class: "bd", id: "lgDonut" });
  const catBox = h("div", { class: "box" }, h("h3", null, "대분류별 지출"), chart,
    h("div", { class: "bd", style: { borderTop: "1px solid var(--line)" } }, h("div", { class: "tw", style: { maxHeight: "30vh" } }, sumTable(exp.map(([k, v]) => ({ k, v })), "대분류", sum.expense))));
  const meth = [...sum.byMethod.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, v }));
  const tags = [...sum.byTag.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, v }));
  const mt = h("div", { class: "grid2" },
    h("div", { class: "box" }, h("h3", null, "결제수단별 ", h("span", { class: "hint" }, "지출만")), h("div", { class: "bd" }, sumTable(meth, "수단", sum.out))),
    h("div", { class: "box" }, h("h3", null, "태그별"), h("div", { class: "bd" }, sumTable(tags, "태그", null))));
  const cal = calendar(P, sum, t);
  const evts = eventsBox();
  const list = h("div", { class: "box" }, h("h3", null, "이달의 내역 ", h("span", { class: "hint" }, entries.length + "건 · 더블클릭/Enter 수정 · ✕ 삭제")),
    h("div", { class: "bd" }, h("div", { class: "tw", style: { maxHeight: "70vh" } }, entryTable(entries, { emptyMsg: "이 기간에 입력이 없습니다 — 위 [빠른 입력]" }))));
  replace(root, nav, cards, quick, h("div", { class: "lgcols" }, h("div", null, list), h("div", null, budget, catBox, mt, cal, evts)));
  if(exp.length) donutChart(chart, exp.slice(0, 10).map(([k, v], i) => ({ k, value: v, color: PAL[i % PAL.length] })), fmtWon(sum.expense)); else emptyChart(chart, "지출이 없습니다");
  $("#lgPrev").addEventListener("click", () => { V.key = LG.shiftPeriod(V.key, -1); renderLedger(); });
  $("#lgNext").addEventListener("click", () => { V.key = LG.shiftPeriod(V.key, 1); renderLedger(); });
  if($("#lgToday")) $("#lgToday").addEventListener("click", () => { V.key = LG.periodKey(today(), st().startDay); renderLedger(); });
  $("#lgFill").addEventListener("click", () => { pending.forEach(e => { e.id = X.nextId(); X.touch(e); L().entries.push(e); }); X.save(); renderLedger(); X.status("고정지출 " + pending.length + "건 생성"); });
}
function calendar(P, sum, t){
  const ns = new Set(sum.noSpendDays), cells = [];
  const first = new Date(Date.UTC(+P.start.slice(0, 4), +P.start.slice(5, 7) - 1, +P.start.slice(8, 10)));
  const pad = (first.getUTCDay() + 6) % 7;                     // 월요일 시작
  for(let i = 0; i < pad; i++) cells.push(h("div", { class: "lgd pad" }));
  for(let d = P.start; d <= P.end; d = addDays(d, 1)){
    const cls = d > t ? "fut" : ns.has(d) ? "ok" : "spend";
    cells.push(h("div", { class: "lgd " + cls, title: d + (d > t ? "" : ns.has(d) ? " 무지출" : " 지출 있음") }, String(+d.slice(8, 10))));
  }
  return h("div", { class: "box" }, h("h3", null, "무지출 달력 ", h("span", { class: "hint" }, "초록 = 변동지출 0원")),
    h("div", { class: "bd" }, h("div", { class: "lgcal" }, ["월", "화", "수", "목", "금", "토", "일"].map(w => h("div", { class: "lgd hd" }, w)), cells)));
}
function eventsBox(){
  const evts = L().events.filter(e => e.period === V.key).sort((a, b) => (a.date || "") < (b.date || "") ? -1 : 1);
  const inDate = h("input", { type: "date", id: "lev-date", style: { width: "135px" } }), inB = h("input", { type: "text", class: "num", id: "lev-b", placeholder: "예산", style: { width: "90px" } }),
    inM = h("input", { type: "text", id: "lev-m", placeholder: "내용 (예: 어머니 생신)", style: { width: "180px" } }), btn = h("button", { class: "btn sm", type: "button" }, "추가");
  btn.addEventListener("click", () => { if(!inM.value.trim()) return;
    L().events.push(X.touch({ id: X.nextId(), period: V.key, date: inDate.value, budget: Math.round(pnum(inB.value)), memo: inM.value.trim() })); X.save(); renderLedger(); });
  const t = table({ columns: [{ key: "date", label: "날짜", align: "c" }, { key: "memo", label: "내용" }, { key: "budget", label: "예산", align: "r", render: e => e.budget ? won(e.budget) : "" },
    { key: "_x", label: "", align: "c", render: e => h("button", { class: "btn sm", type: "button", "data-ev": e.id }, "✕") }], rows: evts, empty: "이달의 이벤트가 없습니다" });
  t.addEventListener("click", e => { const b = e.target.closest("button[data-ev]"); if(!b) return; const id = Number(b.dataset.ev);
    X.S.db.tomb["ledger.events:" + id] = Date.now(); L().events = L().events.filter(x => x.id !== id); X.save(); renderLedger(); });
  return h("div", { class: "box" }, h("h3", null, "이달의 이벤트 ", h("span", { class: "hint" }, "미리 알고 있는 지출")),
    h("div", { class: "bd" }, h("div", { class: "row", style: { marginBottom: "6px" } }, inDate, inB, inM, btn), t));
}

/* ── 2. 연간 ──────────────────────────────────────────────────────────── */
function renderYear(){
  const S = st(), A = LG.annual(L().entries, S, V.year, { today: today() });
  const root = $("#lg-year");
  const mon = A.keys.map(k => +k.slice(5) + "월");
  const nav = h("div", { class: "box" }, h("div", { class: "bd row" }, h("button", { class: "btn", type: "button", id: "lyPrev" }, "◀"), h("b", { style: { fontSize: "15px" } }, V.year + "년"),
    h("button", { class: "btn", type: "button", id: "lyNext" }, "▶"), h("span", { class: "note" }, A.periods[0].start + " ~ " + A.periods[11].end + " · 지난 기간 " + A.elapsed + "개월 기준 평균")));
  const rate = A.income.total > 0 ? (A.saving.total / A.income.total * 100).toFixed(1) + "%" : "—";
  const cards = h("div", { class: "cards" },
    card("연 수입", fmtWon(A.income.total), "월평균 " + fmtWon(A.income.avg)),
    card("연 지출", fmtWon(A.expense.total), "고정 " + fmtWon(A.fixed.total) + " · 변동 " + fmtWon(A.variable.total), "down"),
    card("연 저축", fmtWon(A.saving.total), "저축률 " + rate, "up"),
    card("예비비 지출", fmtWon(A.fund.total), "총 지출 " + fmtWon(A.out.total)),
    card("잔여", fmtWon(A.unallocated.total), "수입 − 지출 − 저축", A.unallocated.total < 0 ? "down" : ""));
  const ch1 = h("div", { class: "bd", id: "lyCh1" }), ch2 = h("div", { class: "bd", id: "lyCh2" });
  const charts = h("div", { class: "grid2" }, h("div", { class: "box" }, h("h3", null, "월별 수입 vs 총지출"), ch1), h("div", { class: "box" }, h("h3", null, "월별 지출 구성 · 저축"), ch2));
  const sec = (title, kind, opts = {}) => {
    const rows = A.rows.filter(r => r.kind === kind && !!r.fund === !!opts.fund);
    return h("div", { class: "box" }, h("h3", null, title), h("div", { class: "bd" }, h("div", { class: "tw", style: { maxHeight: "60vh" } }, annualTable(rows, mon, opts.totalLine, opts.totalLabel))));
  };
  replace(root, nav, cards, charts,
    sec("수입 월별 상세", "income", { totalLine: A.income, totalLabel: "총 수입" }),
    sec("저축 월별 상세", "saving", { totalLine: A.saving, totalLabel: "총 저축" }),
    sec("지출 월별 상세", "expense", { totalLine: A.expense, totalLabel: "총 지출 (고정+변동)" }),
    sec("예비비 상세", "expense", { fund: true, totalLine: A.fund, totalLabel: "총 예비비" }),
    h("div", { class: "box" }, h("h3", null, "정리"), h("div", { class: "bd" }, h("div", { class: "tw" }, annualTable([], mon, null, null, [
      ["수입", A.income], ["지출 (월)", A.expense], ["예비비 지출", A.fund], ["저축", A.saving], ["순저축 (저축 − 예비비)", A.netSaving], ["잔여 (수입 − 지출 − 저축)", A.unallocated]])))));
  if(A.income.total || A.out.total){
    groupedBar(ch1, mon, A.income.vals, A.out.vals, ["수입", "총지출"]);
    stackedBar(ch2, mon, [{ name: "고정지출", color: C.navy, vals: A.fixed.vals }, { name: "변동지출", color: C.red, vals: A.variable.vals },
      { name: "예비비", color: "#F2A93B", vals: A.fund.vals }, { name: "저축", color: C.green, vals: A.saving.vals }]);
  }else{ emptyChart(ch1, "올해 입력이 없습니다"); emptyChart(ch2, ""); }
  $("#lyPrev").addEventListener("click", () => { V.year--; renderLedger(); }); $("#lyNext").addEventListener("click", () => { V.year++; renderLedger(); });
}
function annualTable(catRows, mon, totalLine, totalLabel, extraLines){
  const cols = [{ key: "cat", label: "대분류", render: r => r.type === "cat" ? h("b", null, r.cat + (r.unknown ? " (설정에 없음)" : "")) : r.type === "line" ? h("b", null, r.cat) : "" },
    { key: "sub", label: "소분류" }, { key: "total", label: "합계", align: "r", render: r => h("b", null, won(r.total)) },
    ...mon.map((m, i) => ({ key: "m" + i, label: m, align: "r", render: r => r.vals[i] ? won(r.vals[i]) : "" })),
    { key: "avg", label: "평균", align: "r", render: r => won(r.avg) }];
  const rows = [];
  for(const c of catRows){ for(const s of c.subs) rows.push(s); rows.push({ ...c, type: "cat", sub: "소계", cat: c.cat + " 합계" }); }
  if(totalLine) rows.push({ type: "line", cat: totalLabel, sub: "", ...totalLine });
  for(const [label, line] of (extraLines || [])) rows.push({ type: "line", cat: label, sub: "", ...line });
  return table({ columns: cols, rows, rowAttrs: r => ({ class: r.type === "cat" ? "lgsub" : r.type === "line" ? "lgtot" : null }), empty: "올해 입력이 없습니다" });
}

/* ── 3. 예비비 ────────────────────────────────────────────────────────── */
function renderFund(){
  const S = st(), root = $("#lg-fund"), t = today();
  const all = LG.fundBalance(L().entries), yr = LG.fundStatus(L().entries, S, V.year);
  const fundCat = S.cats.find(c => c.fund);
  const entries = L().entries.filter(e => (e.kind === "saving" && e.sub === LG.FUND_SUB) || (e.kind === "expense" && e.fund)).sort(byDateDesc);
  const cards = h("div", { class: "cards" }, card("예비비 잔액", fmtWon(all.balance), "누적 입금 − 누적 지출", all.balance < 0 ? "down" : "up"),
    card("누적 입금", fmtWon(all.deposit), "저축/예비비 로 기록된 금액"), card("누적 지출", fmtWon(all.spend), "예비비/분류 로 기록된 금액", "down"),
    card(V.year + "년 지출", fmtWon(yr.reduce((s, x) => s + x.spent, 0)), "분류별 연 예산은 [가계부 설정]"));
  const budT = table({ columns: [{ key: "name", label: "분류" }, { key: "budget", label: "연 예산", align: "r", render: r => r.budget ? won(r.budget) : "—" },
      { key: "spent", label: "지출", align: "r", render: r => won(r.spent) }, { key: "remain", label: "남은 예산", align: "r", render: r => r.budget ? won(r.remain) : "" },
      { key: "_b", label: "진행", render: r => r.budget ? bar(r.pct, r.pct > 1 ? "over" : "") : "" }], rows: yr, empty: "예비비 분류가 없습니다" });
  const cats = [LG.FUND_CAT, "저축"];
  const quick = quickRow("lf", { date: t, cats, defaults: { cat: LG.FUND_CAT }, onAdd: raw => {
    if(raw.cat === "저축") raw.sub = LG.FUND_SUB;                      // 예비비 화면에서 저축은 예비비 입금뿐
    const e = addEntry(raw); if(e){ renderLedger(); X.status((e.fund ? "예비비 지출 " : "예비비 입금 ") + won(e.amount) + "원"); } return e; } });
  // 저축을 고르면 소분류를 예비비로 고정
  const selCat = $("#lf-cat", quick), selSub = $("#lf-sub", quick);
  selCat.addEventListener("change", () => { if(selCat.value === "저축") replace(selSub, opt([LG.FUND_SUB], LG.FUND_SUB)); });
  replace(root, cards,
    h("div", { class: "box" }, h("h3", null, "입금 · 지출 기록 ", h("span", { class: "hint" }, "대분류 [저축] = 예비비에 넣기, [예비비] = 예비비에서 쓰기")), h("div", { class: "bd" }, quick)),
    h("div", { class: "grid2" },
      h("div", { class: "box" }, h("h3", null, V.year + "년 분류별 예산 ", h("span", { class: "hint" }, (fundCat ? fundCat.subs.join(" · ") : ""))), h("div", { class: "bd" }, budT)),
      h("div", { class: "box" }, h("h3", null, "예비비 내역 ", h("span", { class: "hint" }, entries.length + "건")), h("div", { class: "bd" }, h("div", { class: "tw", style: { maxHeight: "50vh" } }, entryTable(entries, { emptyMsg: "예비비 입금·지출이 없습니다" }))))),
    h("div", { class: "box" }, h("h3", null, "예비비란"), h("div", { class: "bd note" },
      "여행·경조사·병원비처럼 매달 나가진 않지만 한 번에 크게 나가는 돈을 미리 떼어두는 주머니입니다. 넣을 때는 저축으로, 쓸 때는 예비비 지출로 적습니다. ",
      "월 지출과 섞이지 않게 따로 보여주고, 순저축(저축 − 예비비 지출)으로 되돌려 계산합니다. 자산 목록의 예금·현금 잔액과 별개인 '용도 꼬리표'이므로 실제 통장 잔액과 맞춰 두세요.")));
}

/* ── 4. 설정 ──────────────────────────────────────────────────────────── */
function renderSet(){
  const S = st(), root = $("#lg-set");
  /* 기본 */
  const inSd = h("input", { type: "number", min: 1, max: 28, id: "ls-sd", value: S.startDay, style: { width: "70px" } });
  const inMet = h("input", { type: "text", id: "ls-met", value: S.methods.join(", "), style: { width: "360px" } });
  const inTag = h("input", { type: "text", id: "ls-tag", value: S.tags.join(", "), style: { width: "360px" } });
  const bBasic = h("button", { class: "btn primary", type: "button" }, "저장");
  bBasic.addEventListener("click", () => {
    const sd = LG.normStartDay(inSd.value);
    saveSettings({ startDay: sd, methods: splitList(inMet.value), tags: splitList(inTag.value) });
    V.key = LG.periodKey(today(), sd); X.status("가계부 설정 저장"); renderLedger(); });
  const basic = h("div", { class: "box" }, h("h3", null, "기본"), h("div", { class: "bd" },
    h("div", { class: "qa" }, field("ls-sd", "회계월 시작일 (1~28)", inSd), field("ls-met", "결제수단 (쉼표로 구분)", inMet), field("ls-tag", "태그 (쉼표로 구분)", inTag), bBasic),
    h("p", { class: "note" }, "월급날 기준으로 가계부를 쓰면 시작일을 그 날로. 예: 25일 → 1/25~2/24 가 \"1월\" 기간. 29~31일은 달마다 없는 날이 있어 28일까지만 받습니다.")));
  /* 분류 */
  const catRows = S.cats.map((c, i) => ({ ...c, i }));
  const catT = table({ columns: [
      { key: "name", label: "대분류", render: c => h("input", { type: "text", value: c.name, "data-f": "name", "data-i": c.i, style: { width: "110px" } }) },
      { key: "kind", label: "종류", align: "c", render: c => c.fund ? "예비비" : h("select", { "data-f": "kind", "data-i": c.i }, ["income", "saving", "expense"].map(k => h("option", { value: k, selected: k === c.kind }, LG.KIND_LABEL[k]))) },
      { key: "fixed", label: "고정", align: "c", render: c => c.kind === "expense" && !c.fund ? h("input", { type: "checkbox", checked: !!c.fixed, "data-f": "fixed", "data-i": c.i, title: "고정지출 대분류 — 무지출 Day 계산에서 제외" }) : "" },
      { key: "subs", label: "소분류 (쉼표로 구분)", render: c => h("input", { type: "text", value: c.subs.join(", "), "data-f": "subs", "data-i": c.i, style: { width: "100%", minWidth: "260px" } }) },
      { key: "_x", label: "", align: "c", render: c => c.fund ? "" : h("button", { class: "btn sm", type: "button", "data-rm": c.i }, "✕") }],
    rows: catRows, empty: "" });
  const bCat = h("button", { class: "btn primary", type: "button" }, "분류 저장"), bAdd = h("button", { class: "btn", type: "button" }, "＋ 대분류 추가");
  bAdd.addEventListener("click", () => { S.cats.push({ name: "새 분류", kind: "expense", subs: ["기타"] }); renderLedger(); });
  catT.addEventListener("click", e => { const b = e.target.closest("button[data-rm]"); if(!b) return; const c = S.cats[+b.dataset.rm];
    if(confirm("[" + c.name + "] 대분류를 지울까요? 이미 기록된 항목은 그대로 남고 연간표에 '설정에 없음'으로 표시됩니다.")){ S.cats.splice(+b.dataset.rm, 1); saveSettings({}); renderLedger(); } });
  bCat.addEventListener("click", () => {
    const next = S.cats.map(c => ({ ...c, subs: [...c.subs] }));
    catT.querySelectorAll("[data-f]").forEach(el => { const c = next[+el.dataset.i], f = el.dataset.f;
      if(f === "name") c.name = el.value.trim() || c.name; else if(f === "kind") c.kind = el.value; else if(f === "fixed") c.fixed = el.checked; else if(f === "subs") c.subs = splitList(el.value); });
    const names = next.map(c => c.name); if(new Set(names).size !== names.length){ alert("대분류 이름이 겹칩니다."); return; }
    if(next.some(c => !c.subs.length)){ alert("소분류가 비어 있는 대분류가 있습니다."); return; }
    const fund = next.find(c => c.fund); if(fund) fund.kind = "expense";
    const sv = next.find(c => c.kind === "saving"); if(sv && !sv.subs.includes(LG.FUND_SUB)) sv.subs.push(LG.FUND_SUB);
    saveSettings({ cats: next }); X.status("분류 저장"); renderLedger(); });
  const cats = h("div", { class: "box" }, h("h3", null, "분류 ", h("span", { class: "hint" }, "디어나 가계부 [설정] 시트에 해당 · 대분류 24개 · 소분류 각 15개 권장")),
    h("div", { class: "bd" }, h("div", { class: "tw", style: { maxHeight: "50vh" } }, catT), h("div", { class: "row", style: { marginTop: "8px" } }, bAdd, bCat,
      h("span", { class: "note" }, "이름을 바꿔도 이미 적은 항목은 옛 이름으로 남습니다 (연간표에서 '설정에 없음'으로 보임). 예비비 대분류의 소분류가 예비비 분류입니다."))));
  /* 예산 */
  const B = S.budgets || {}, FB = S.fundBudgets || {};
  const kindIn = [["_income", "수입 목표"], ["_saving", "저축 목표"], ["_expense", "지출 예산 (월 전체)"]].map(([k, l]) => field("lb" + k, l, h("input", { type: "text", class: "num", id: "lb" + k, value: B[k] ? fmtNum(B[k]) : "", "data-b": k, style: { width: "130px" } })));
  const catIn = LG.expenseCats(S).map(c => field("lb-" + c.name, c.name, h("input", { type: "text", class: "num", value: B[c.name] ? fmtNum(B[c.name]) : "", "data-b": c.name, style: { width: "120px" } })));
  const fundCat = S.cats.find(c => c.fund) || { subs: [] };
  const fundIn = fundCat.subs.map(s => field("lfb-" + s, s, h("input", { type: "text", class: "num", value: FB[s] ? fmtNum(FB[s]) : "", "data-fb": s, style: { width: "120px" } })));
  const bBud = h("button", { class: "btn primary", type: "button" }, "예산 저장");
  bBud.addEventListener("click", () => { const nb = {}, nf = {};
    root.querySelectorAll("[data-b]").forEach(el => { const v = Math.round(pnum(el.value)); if(v > 0) nb[el.dataset.b] = v; });
    root.querySelectorAll("[data-fb]").forEach(el => { const v = Math.round(pnum(el.value)); if(v > 0) nf[el.dataset.fb] = v; });
    saveSettings({ budgets: nb, fundBudgets: nf }); X.status("예산 저장"); renderLedger(); });
  const budget = h("div", { class: "box" }, h("h3", null, "예산 · 목표 ", h("span", { class: "hint" }, "월 기준 · 비우면 없음")), h("div", { class: "bd" },
    h("div", { class: "qa", style: { marginBottom: "8px" } }, kindIn), h("b", { class: "note" }, "대분류별 월 예산"), h("div", { class: "qa", style: { margin: "4px 0 8px" } }, catIn),
    h("b", { class: "note" }, "예비비 분류별 연 예산"), h("div", { class: "qa", style: { margin: "4px 0 8px" } }, fundIn), bBud));
  /* 고정지출 규칙 */
  const rules = L().recurring.slice().sort((a, b) => (a.day || 0) - (b.day || 0));
  const rT = table({ columns: [{ key: "day", label: "결제일", align: "c", render: r => r.day + "일" }, { key: "name", label: "내용" }, { key: "cat", label: "대분류", align: "c" }, { key: "sub", label: "소분류", align: "c" },
      { key: "amount", label: "금액", align: "r", render: r => won(r.amount) }, { key: "method", label: "결제수단", align: "c" },
      { key: "active", label: "활성", align: "c", render: r => h("input", { type: "checkbox", checked: r.active !== false, "data-act": r.id }) },
      { key: "_x", label: "", align: "c", render: r => h("button", { class: "btn sm", type: "button", "data-rr": r.id }, "✕") }],
    rows: rules, empty: "규칙이 없습니다 — 아래에서 추가하면 [월별]에서 한 번에 채울 수 있습니다" });
  rT.addEventListener("click", e => { const b = e.target.closest("button[data-rr]"); if(b){ const id = Number(b.dataset.rr);
      X.S.db.tomb["ledger.recurring:" + id] = Date.now(); L().recurring = L().recurring.filter(r => r.id !== id); X.save(); renderLedger(); } });
  rT.addEventListener("change", e => { const c = e.target.closest("input[data-act]"); if(c){ const r = L().recurring.find(x => x.id === Number(c.dataset.act)); if(r){ r.active = c.checked; X.touch(r); X.save(); } } });
  const [rCat, rSub] = catSubPair("lr", "고정지출", null, catList({ transfer: false, kinds: ["expense", "saving"] }));
  const rName = h("input", { type: "text", id: "lr-name", placeholder: "예: 관리비", style: { width: "150px" } }), rAmt = h("input", { type: "text", class: "num", id: "lr-amt", style: { width: "110px" } }),
    rDay = h("input", { type: "number", min: 1, max: 31, id: "lr-day", value: 1, style: { width: "60px" } }), rMet = h("select", { id: "lr-met" }, opt(["", ...S.methods], "")), rAdd = h("button", { class: "btn primary", type: "button", id: "lrAdd" }, "＋ 규칙 추가");
  rAdd.addEventListener("click", () => { const amount = Math.round(pnum(rAmt.value)); if(!rName.value.trim() || !amount){ X.status("내용과 금액을 입력하세요"); return; }
    L().recurring.push(X.touch({ id: X.nextId(), name: rName.value.trim(), amount, cat: rCat.value, sub: rSub.value, day: Math.max(1, Math.min(31, +rDay.value || 1)), method: rMet.value, active: true }));
    X.save(); renderLedger(); X.status("규칙 추가: " + rName.value.trim()); });
  const rec = h("div", { class: "box" }, h("h3", null, "고정지출 규칙 ", h("span", { class: "hint" }, "[결제일 관리] 시트에 해당 · 매달 다시 치지 않습니다")), h("div", { class: "bd" },
    h("div", { class: "tw", style: { maxHeight: "40vh" } }, rT),
    h("div", { class: "qa", style: { marginTop: "8px" } }, field("lr-name", "내용", rName), field("lr-cat", "대분류", rCat), field("lr-sub", "소분류", rSub), field("lr-amt", "금액", rAmt), field("lr-day", "결제일", rDay), field("lr-met", "결제수단", rMet), rAdd),
    h("p", { class: "note" }, "적금 자동이체처럼 매달 나가는 저축도 규칙으로 두면 됩니다 (대분류 저축). 회계월 시작일이 25일이면 결제일 5일은 다음 달 5일로 잡힙니다.")));
  const io = h("div", { class: "box" }, h("h3", null, "디어나 가계부에서 가져오기"), h("div", { class: "bd note" },
    "엑셀(.xlsx) 파일을 ", h("code", null, "python3 tools/import_dieona.py 가계부.xlsx > ledger.json"), " 으로 변환한 뒤 [설정] 탭의 [JSON 불러오기]로 읽으면 분류·월별 내역·예비비·결제일이 병합됩니다. 자세한 것은 docs/LEDGER.md."));
  replace(root, basic, cats, budget, rec, io);
}
const splitList = s => [...new Set(String(s || "").split(",").map(x => x.trim()).filter(Boolean))];
