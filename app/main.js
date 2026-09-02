/** 앱 진입점 — 모든 화면. 표는 core/html.table, 계산은 core/, 저장은 store.js, 통신은 api.js.
 *  인라인 onclick·innerHTML 없음 (CSP script-src 'self' 와 호환). */
import { h, replace, clear, table } from "./core/html.js";
import { evaluate, priceKey, FLAG, TAX_INTEREST } from "./core/valuation.js";
import { buildRows, totals, groupSum, resolveLoanLinks, loansFor, loanToValue } from "./core/aggregate.js";
import { reconstruct, indexHistory, priceAt } from "./core/timeseries.js";
import { pool } from "./core/pool.js";
import * as F from "./format.js";
import { fmtWon, fmtNum, fmtPct, pnum, todayISO, dOf, addDays, isoOf, maskAcct, marketOf,
         C, PAL, CLS_COLOR, CLASSES, CATS, MODES, MODE_DESC, DEFMODE, INDEXES, RTMS_KINDS, LAWD, OWNERS_DEFAULT } from "./format.js";
import { emptyChart, lineChart, donutChart, groupedBar, stackedBar, stackedArea, treemap } from "./charts.js";
import * as Store from "./store.js";
import { api } from "./api.js";

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

/* ── 상태 ─────────────────────────────────────────────────────────────── */
const S = {
  me: null, hh: null, key: null,
  db: Store.EMPTY(),
  quotes: {}, quoteAt: {}, fx: { USD: 1380 }, idx: {}, quoteErrs: {},
  rows: [], tot: null, links: new Map(),
  sel: { asset: null, cat: null, re: null }, sort: { f: null, dir: 1 },
  deals: [], reSummary: null, online: true, syncing: false, dirty: false
};
const ctx = () => ({ quotes: S.quotes, fx: S.fx, ref: todayISO(), taxRate: S.db.set.afterTax ? TAX_INTEREST : 0 });
const status = m => { $("#status").textContent = m; };
const progress = (i, n) => { $("#progress > i").style.width = n ? (i / n * 100) + "%" : "0"; };
const nextId = () => S.db.seq++;
const active = () => S.db.assets.filter(a => a.active !== 0);
const byId = id => S.db.assets.find(a => a.id === Number(id));
const owners = () => { const s = new Set(S.db.assets.map(a => a.owner).filter(Boolean)); return s.size ? [...s] : [...OWNERS_DEFAULT]; };
const touch = o => { o.updatedAt = Date.now(); return o; };

/* ── 저장 · 동기화 ────────────────────────────────────────────────────── */
let saveTimer = null;
async function save({ syncNow = false } = {}){
  S.dirty = true;
  await Store.saveLocal(S.hh.id, S.db);
  paintStore();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(syncUp, syncNow ? 0 : 2500);
}
async function syncUp(){
  if(!S.key || S.syncing) return;
  S.syncing = true; syncMsg("동기화 중…");
  try{
    const r = await Store.sync({ api, householdId: S.hh.id, key: S.key, kdfSalt: S.hh.kdfSalt, local: S.db });
    S.db = r.db; S.dirty = false;
    await Store.saveLocal(S.hh.id, S.db);
    syncMsg("동기화됨 v" + r.version + (r.pulled ? " · 병합" : ""), false);
    if(r.pulled) renderAll();
  }catch(e){ syncMsg("동기화 실패: " + e.message, true); }
  S.syncing = false; paintStore();
}
function syncMsg(m, err){ const n = $("#syncMsg"); n.textContent = m; n.className = "sync" + (err ? " err" : ""); }
async function paintStore(){
  const meta = await Store.getMeta(S.hh.id);
  const t = meta.syncedAt ? new Date(meta.syncedAt).toLocaleString("ko-KR") : "아직 없음";
  $("#barStore").textContent = (S.dirty ? "● 미동기화" : "✓ 동기화") + " · 로컬 IndexedDB";
  replace($("#storeMsg"),
    "이 기기 IndexedDB에 원본 보관 · 서버에는 암호문만 · 마지막 동기화 ", h("b", null, t),
    " · 자산 " + S.db.assets.length + "건 · 거래 " + S.db.trades.length + "건 · 스냅샷 " + S.db.snaps.length + "건");
}

/* ── 렌더 공통 ────────────────────────────────────────────────────────── */
const TABS = [["dash","대시보드"],["assets","자산 목록"],["cat","카테고리별"],["stock","주식·ETF"],
              ["re","부동산"],["trend","자산 추이"],["index","시장 지수"],["set","설정"]];
function showTab(id){
  TABS.forEach(([t]) => { $("#p-" + t).classList.toggle("on", t === id);
    const b = $("#nav-" + t); if(b){ b.classList.toggle("on", t === id); b.setAttribute("aria-selected", String(t === id)); } });
  S.db.set.tab = id;
  if(id === "trend") $("#trNote").textContent = "스냅샷 " + S.db.snaps.length + "건";
}
function renderNav(){
  replace($("#nav"), TABS.map(([t, l]) => h("button", { id: "nav-" + t, role: "tab", type: "button" }, l)));
  $("#nav").addEventListener("click", e => { const b = e.target.closest("button[id^=nav-]"); if(b) showTab(b.id.slice(4)); });
}
const badge = (txt, cls, title) => h("span", { class: "badge " + (cls || ""), title }, txt);
function flagBadges(r){
  const out = [];
  if(r.flags.includes(FLAG.NO_QUOTE)) out.push(badge("시세없음", "stale", "실시간 시세를 못 구해 평균단가/입력값을 씁니다"));
  else if(r.mode === "AUTO" && r.code && S.quoteAt[priceKey(r)] && S.quoteAt[priceKey(r)] !== todayISO())
    out.push(badge(S.quoteAt[priceKey(r)].slice(5), "stale", "이 날짜의 저장 시세입니다"));
  if(r.flags.includes(FLAG.NO_BASIS)) out.push(badge("원금?", "est", "원금을 몰라 손익을 내지 않습니다"));
  if(r.flags.includes(FLAG.MATURED)) out.push(badge("만기", "ok", "만기 이후 이자가 멈췄습니다"));
  if(r.flags.includes(FLAG.ASSUMED_FX)) out.push(badge("환율가정", "est", "취득 환율이 없어 현재 환율로 원금을 환산"));
  return out;
}
const card = (t, v, s, cls) => h("div", { class: "card" }, h("div", { class: "t" }, t), h("div", { class: "v " + (cls || "") }, v), h("div", { class: "s" }, s || ""));

function renderAll(){
  S.rows = buildRows(S.db.assets, ctx());
  S.tot = totals(S.rows);
  S.links = resolveLoanLinks(S.db.assets);
  $("#hdTotal").textContent = "총자산 " + fmtWon(S.tot.asset);
  $("#hdNet").textContent = "순자산 " + fmtWon(S.tot.net) + " · 부채 " + fmtWon(S.tot.debt);
  $("#barFx").textContent = "USD/KRW " + fmtNum(S.fx.USD, 2);
  renderDash(); renderAssets(); renderCat(); renderStock(); renderRe(); paintStore();
}

/* ── 1. 대시보드 ──────────────────────────────────────────────────────── */
function renderDash(){
  const t = S.tot, up = (t.pl || 0) >= 0 ? "up" : "down";
  replace($("#dashCards"),
    card("총 자산", fmtWon(t.asset), "금융+부동산+실물"),
    card("총 부채", fmtWon(t.debt), "대출·보증금", "down"),
    card("순자산", fmtWon(t.net), "총자산 − 부채", "up"),
    card("투자원금", fmtWon(t.basis), t.unknownBasis ? "원금 미상 " + fmtWon(t.unknownBasis) + " 제외" : "확인된 원금"),
    card("평가손익", fmtWon(t.pl), t.pl == null ? "원금 정보 없음" : "", up),
    card("수익률", fmtPct(t.plPct), "원금 확인분 기준", up));
  const share = v => t.asset ? " · 비중 " + (v / t.asset * 100).toFixed(1) + "%" : "";
  const ltv = loanToValue(S.rows, S.links);
  const amb = [...S.links.values()].some(l => l.ambiguous);
  replace($("#dashCards2"),
    card("금융자산", fmtWon(t.byClass.get("금융자산") || 0), share(t.byClass.get("금융자산") || 0)),
    card("부동산", fmtWon(t.byClass.get("부동산") || 0), share(t.byClass.get("부동산") || 0)),
    card("실물자산", fmtWon(t.byClass.get("실물자산") || 0), share(t.byClass.get("실물자산") || 0)),
    card("담보 LTV", ltv.overall == null ? "—" : ltv.overall.toFixed(1) + "%",
      amb ? "⚠ 담보 연결이 모호한 대출이 있습니다" : "담보대출 / 담보 부동산", ltv.overall > 60 ? "down" : ""));
  replace($("#idxCards"),
    INDEXES.map(nm => { const q = S.idx[nm]; if(!q) return card(nm, "-", "미조회");
      const u = q.rate >= 0; return card(nm, fmtNum(q.price, 2), (u ? "▲ " : "▼ ") + fmtNum(Math.abs(q.diff), 2) + " (" + fmtPct(q.rate) + ")", u ? "up" : "down"); }),
    card("USD/KRW", fmtNum(S.fx.USD, 2), "환율"));
  $("#idxNote").textContent = Object.keys(S.idx).length ? "" : "시세 갱신을 눌러 조회하세요";

  const cats = groupSum(S.rows, "cat", { top: 11 });
  donutChart($("#chPie"), cats.map((c, i) => ({ k: c.k, value: c.value, color: PAL[i % PAL.length] })), fmtWon(t.asset));
  const top = cats.slice(0, 8);
  groupedBar($("#chBar"), top.map(c => c.k), top.map(c => c.basis), top.map(c => c.value), ["원금", "현재가치"]);
  const ow = owners().filter(o => S.rows.some(r => r.owner === o));
  stackedBar($("#chOwner"), ow, CLASSES.map(cl => ({ name: cl, color: CLS_COLOR[cl],
    vals: ow.map(o => { const v = S.rows.filter(r => r.owner === o && r.cls === cl).reduce((s, r) => s + r.value, 0); return cl === "부채" ? -v : v; }) }))
    .filter(s => s.vals.some(v => v)));
}

/* ── 2. 자산 목록 ─────────────────────────────────────────────────────── */
const ACOLS = [
  { key: "owner", label: "소유자", align: "c", edit: "sel" }, { key: "cls", label: "자산군", align: "c", edit: "sel" },
  { key: "cat", label: "카테고리", align: "c", edit: "sel" }, { key: "name", label: "자산명", edit: "txt",
    render: r => [r.name, ...flagBadges(r)] },
  { key: "inst", label: "금융기관", edit: "txt" }, { key: "acct", label: "계좌", align: "c", edit: "acct" },
  { key: "code", label: "종목코드", align: "c", edit: "txt" },
  { key: "qty", label: "수량", align: "r", edit: "num", render: r => r.qty ? fmtNum(r.qty, 4) : "" },
  { key: "avg", label: "평균단가", align: "r", edit: "num", render: r => r.avg ? fmtNum(r.avg, 2) + (r.cur === "USD" ? " $" : "") : "" },
  { key: "_cur", label: "현재가", align: "r", render: r => { const p = S.quotes[priceKey(r)]; return p ? fmtNum(p, r.cur === "USD" ? 2 : 0) + (r.cur === "USD" ? " $" : "") : ""; } },
  { key: "basis", label: "원금(₩)", align: "r", edit: "num", editKey: "principal", render: r => r.basis ? fmtNum(r.basis) : "" },
  { key: "value", label: "평가액(₩)", align: "r", edit: "num", render: r => fmtNum(r.value) },
  { key: "pl", label: "손익", align: "r", cls: r => r.pl < 0 ? "neg" : null, render: r => r.pl == null ? "" : fmtNum(r.pl) },
  { key: "plPct", label: "수익률", align: "r", cls: r => r.pl < 0 ? "neg" : null, render: r => r.plPct == null ? "" : fmtPct(r.plPct) },
  { key: "mode", label: "평가방식", align: "c", edit: "sel" }, { key: "memo", label: "메모", edit: "txt" }];

function filteredRows(){
  const cls = $("#fCls").value, ow = $("#fOwner").value, kw = ($("#fKw").value || "").trim();
  let rows = S.rows.filter(r => (cls === "전체" || r.cls === cls) && (ow === "전체" || r.owner === ow) &&
    (!kw || (r.name + (r.inst || "") + (r.code || "") + (r.memo || "")).includes(kw)));
  if(S.sort.f){
    const f = S.sort.f, d = S.sort.dir;
    rows = rows.slice().sort((a, b) => { const x = a[f], y = b[f];
      return (typeof x === "number" || typeof y === "number") ? ((x || 0) - (y || 0)) * d : String(x || "").localeCompare(String(y || ""), "ko") * d; });
  }
  return rows;
}
function fillSelect(sel, vals, keep){
  const cur = keep ? sel.value : null;
  replace(sel, vals.map(v => h("option", { value: v }, v)));
  if(cur && vals.includes(cur)) sel.value = cur;
}
function renderAssets(){
  if(!$("#fCls").options.length) fillSelect($("#fCls"), ["전체", ...CLASSES]);
  fillSelect($("#fOwner"), ["전체", ...owners()], true);
  const rows = filteredRows();
  const a = rows.filter(r => !r.isDebt).reduce((s, r) => s + r.value, 0);
  const d = rows.filter(r => r.isDebt).reduce((s, r) => s + r.value, 0);
  const p = rows.filter(r => !r.isDebt && r.basis > 0).reduce((s, r) => s + r.basis, 0);
  const pv = rows.filter(r => !r.isDebt && r.basis > 0).reduce((s, r) => s + r.value, 0);
  const t = table({
    columns: ACOLS.map(c => ({ ...c, label: c.label + (c.edit ? " ✎" : "") })),
    rows,
    rowAttrs: r => ({ "data-id": r.id, tabindex: 0, class: (r.isDebt ? "debt" : "") + (S.sel.asset === r.id ? " sel" : "") }),
    empty: "조건에 맞는 자산이 없습니다. 위 [빠른 추가]로 입력해 보세요.",
    foot: [{ text: "합계 " + rows.length + "건 · 순자산 " + fmtWon(a - d), attrs: { colspan: 7 } },
           { text: "부채 " + fmtWon(d), attrs: { colspan: 3, class: "r" } },
           { text: fmtNum(p), attrs: { class: "r" } }, { text: fmtNum(a), attrs: { class: "r" } },
           { text: fmtNum(pv - p), attrs: { class: "r" } }, { text: fmtPct(p ? (pv - p) / p * 100 : null), attrs: { class: "r" } },
           { text: "", attrs: { colspan: 2 } }]
  });
  t.querySelectorAll("th").forEach((th, i) => { const c = ACOLS[i]; th.dataset.sort = c.key;
    if(S.sort.f === c.key) th.classList.add(S.sort.dir > 0 ? "asc" : "desc"); });
  t.querySelectorAll("tbody td").forEach((td, i) => { const c = ACOLS[i % ACOLS.length]; if(c.edit){ td.classList.add("editable"); td.dataset.f = c.editKey || c.key; td.dataset.kind = c.edit; } });
  replace($("#tblAssets"), t);
  const errs = Object.entries(S.quoteErrs);
  const box = $("#quoteErrs"); box.hidden = !errs.length;
  replace(box, errs.length ? [h("b", null, "시세 조회 실패 " + errs.length + "건 — 저장된 최근 시세를 대신 씁니다"),
    ...errs.map(([k, m]) => h("div", null, k + ": " + m))] : []);
}

/* 인라인 편집 */
function beginEdit(td){
  if(td.querySelector("input,select")) return;
  const tr = td.closest("tr"), a = byId(tr.dataset.id); if(!a) return;
  const f = td.dataset.f, kind = td.dataset.kind;
  S.sel.asset = a.id;
  const orig = Array.from(td.childNodes);
  let inp;
  if(kind === "sel"){
    inp = h("select", null, (f === "owner" ? owners() : f === "cls" ? CLASSES : f === "cat" ? (CATS[a.cls] || []) : MODES)
      .map(v => h("option", { value: v, selected: v === a[f] }, v)));
  }else{
    inp = h("input", { type: "text", class: kind === "num" ? "num" : null,
      value: kind === "num" ? (a[f] ? fmtNum(a[f], 4) : "") : (a[f] == null ? "" : a[f]) });
  }
  replace(td, inp); inp.focus(); if(inp.select) inp.select();
  let done = false;
  const restore = () => { done = true; clear(td); orig.forEach(n => td.appendChild(n)); };
  const commit = (move) => {
    if(done) return; done = true;
    let v = kind === "num" ? pnum(inp.value) : String(inp.value).trim();
    if(kind === "acct") v = maskAcct(v);
    const before = a[f] == null ? (kind === "num" ? 0 : "") : a[f];
    if(String(v) !== String(before)){
      a[f] = v; touch(a);
      if(f === "cls" && !(CATS[v] || []).includes(a.cat)) a.cat = (CATS[v] || ["기타"])[0];
      if(f === "code"){ a.market = marketOf(v); a.cur = a.market === "US" ? "USD" : "KRW"; }
      if(a.cls === "부동산" && f === "value" && v) putHist(priceKey(a), todayISO(), v);
      save(); renderAll();
      status("저장: " + a.name + " · " + f);
    }else restore();
    if(move) setTimeout(() => focusNext(a.id, f, move), 20);
  };
  inp.addEventListener("keydown", e => {
    if(e.key === "Enter"){ e.preventDefault(); commit(0); }
    else if(e.key === "Escape"){ e.preventDefault(); restore(); tr.focus(); }
    else if(e.key === "Tab"){ e.preventDefault(); commit(e.shiftKey ? -1 : 1); }
  });
  if(kind === "sel") inp.addEventListener("change", () => commit(0));
  inp.addEventListener("blur", () => setTimeout(() => commit(0), 60));
}
function focusNext(id, f, step){
  const ed = ACOLS.filter(c => c.edit).map(c => c.editKey || c.key);
  const i = (ed.indexOf(f) + step + ed.length) % ed.length;
  const td = document.querySelector(`#tblAssets tr[data-id="${id}"] td[data-f="${ed[i]}"]`);
  if(td) beginEdit(td);
}
function selectRow(tr){
  S.sel.asset = Number(tr.dataset.id);
  $$("#tblAssets tr.sel").forEach(x => x.classList.remove("sel")); tr.classList.add("sel");
}

/* 빠른 추가 */
const QA = [["owner","소유자","sel",90],["cls","자산군","sel",90],["cat","카테고리","sel",110],["name","자산명","txt",190],
  ["inst","금융기관","txt",110],["code","종목코드","txt",80],["qty","수량","num",70],["avg","평균단가","num",95],
  ["principal","원금/취득가","num",115],["value","평가액","num",115]];
function renderQuickAdd(){
  replace($("#quickAdd"), QA.map(([f, l, k, w]) => h("div", { class: "field" }, h("label", { for: "qa-" + f }, l),
    k === "sel" ? h("select", { id: "qa-" + f, style: { width: w + "px" } },
        (f === "owner" ? owners() : f === "cls" ? CLASSES : CATS["금융자산"]).map(v => h("option", { value: v }, v)))
      : h("input", { type: "text", id: "qa-" + f, class: k === "num" ? "num" : null, style: { width: w + "px" } }))),
    h("button", { class: "btn primary", id: "qaAdd", type: "button" }, "＋ 추가"),
    h("span", { class: "note" }, "종목코드가 숫자면 국내·원화, 영문이면 해외·달러. \"1.2억\", \"3,000만\" 입력 가능"));
  $("#qa-cls").addEventListener("change", () => fillSelect($("#qa-cat"), CATS[$("#qa-cls").value] || []));
  $("#qaAdd").addEventListener("click", quickAdd);
  QA.forEach(([f]) => $("#qa-" + f).addEventListener("keydown", e => { if(e.key === "Enter") quickAdd(); }));
}
function quickAdd(){
  const g = f => ($("#qa-" + f).value || "").trim();
  const name = g("name"); if(!name){ $("#qa-name").focus(); status("자산명을 입력해 주세요."); return; }
  const cls = g("cls"), cat = g("cat"), code = g("code");
  let mode = cls === "금융자산" && code ? "AUTO" : cls === "부동산" ? "QUOTE" : (cls === "실물자산" || cls === "부채") ? "MANUAL" : (DEFMODE[cat] || "MANUAL");
  if(mode === "RATE" || mode === "INSTALLMENT") mode = "MANUAL";
  const market = marketOf(code);
  const a = touch({ id: nextId(), active: 1, owner: g("owner") || "공동", cls, cat, name, code, market, inst: g("inst"), acct: "",
    qty: pnum(g("qty")), avg: pnum(g("avg")), principal: pnum(g("principal")), value: pnum(g("value")), mode,
    cur: market === "US" ? "USD" : "KRW", rate: 0, start: "", end: "", memo: "" });
  S.db.assets.push(a);
  if(cls === "부동산" && a.value) putHist(priceKey(a), todayISO(), a.value);
  save(); ["name","code","qty","avg","principal","value"].forEach(f => $("#qa-" + f).value = ""); $("#qa-name").focus();
  S.sel.asset = a.id; renderAll(); status("추가: " + name + " (" + cat + " · " + mode + ")");
}

/* 상세 모달 */
const FORM = [
  ["기본 정보", [["owner","소유자(별칭)","sel"],["cls","자산군","sel"],["cat","카테고리","sel"],["name","자산명","txt"],["inst","금융기관","txt"],["acct","계좌번호","txt"],["active","보유 상태","act"]]],
  ["평가 정보", [["mode","평가방식","sel"],["cur","통화","sel"],["code","종목코드/티커","txt"],["market","시장","sel"],["qty","수량","num"],["avg","평균매입가","num"],
    ["principal","원금/취득가","num"],["fxAtCost","취득 시 환율","num"],["value","평가액(수동)","num"],["rate","금리(%)","num"],["monthly","월 납입액(적금)","num"],
    ["compound","이자 방식","cmp"],["start","가입/취득일","date"],["end","만기/처분일","date"]]],
  ["부동산 · 담보", [["addr","소재지","txt"],["complex","단지/건물명","txt"],["lawd","법정동코드(5자리)","txt"],["area","전용면적(㎡)","num"],["floor","층","txt"],
    ["deposit","임대보증금","num"],["rent","월세","num"],["secures","담보 부동산(부채인 경우)","secures"]]]];
function openModal(...kids){ replace($("#modal"), kids); $("#mask").classList.add("on"); const f = $("#modal input,#modal select"); if(f) f.focus(); }
function closeModal(){ $("#mask").classList.remove("on"); }
function openAssetForm(id){
  const a = id ? { ...byId(id) } : { id: 0, active: 1, owner: owners()[0], cls: "금융자산", cat: "주식", mode: "AUTO", cur: "KRW", market: "KR" };
  const opt = (vals, cur) => vals.map(v => h("option", { value: v, selected: String(v) === String(cur) }, v));
  const props = active().filter(x => x.cls === "부동산");
  const sections = FORM.map(([title, fields]) => h("fieldset", null, h("legend", null, title), h("div", { class: "fgrid" },
    fields.map(([f, label, kind]) => {
      let ctrl;
      if(kind === "sel") ctrl = h("select", { id: "fm-" + f }, opt(f === "owner" ? [...owners(), "직접입력"] : f === "cls" ? CLASSES : f === "cat" ? (CATS[a.cls] || []) : f === "mode" ? MODES : f === "cur" ? ["KRW","USD"] : ["KR","US",""], a[f]));
      else if(kind === "act") ctrl = h("select", { id: "fm-" + f }, h("option", { value: "1", selected: a.active !== 0 }, "보유 중"), h("option", { value: "0", selected: a.active === 0 }, "처분/종료"));
      else if(kind === "cmp") ctrl = h("select", { id: "fm-" + f }, h("option", { value: "simple", selected: a.compound !== "monthly" }, "단리"), h("option", { value: "monthly", selected: a.compound === "monthly" }, "월복리"));
      else if(kind === "secures") ctrl = h("select", { id: "fm-" + f }, h("option", { value: "" }, "(없음)"), props.map(p => h("option", { value: p.id, selected: String(p.id) === String(a.secures || "") }, p.name)));
      else if(kind === "date") ctrl = h("input", { type: "date", id: "fm-" + f, value: a[f] || "" });
      else ctrl = h("input", { type: "text", id: "fm-" + f, class: kind === "num" ? "num" : null, value: kind === "num" ? (a[f] ? fmtNum(a[f], 4) : "") : (a[f] == null ? "" : a[f]) });
      return h("div", { class: "field" }, h("label", { for: "fm-" + f }, label), ctrl);
    })),
    title === "평가 정보" ? h("div", { class: "note", id: "fmModeDesc", style: { marginTop: "6px" } }) : null,
    title === "기본 정보" ? h("div", { class: "note" }, "계좌번호는 뒤 4자리만 남습니다. 소유자는 실명 대신 별칭을 권장합니다.") : null));
  openModal(h("h3", null, id ? "자산 수정 — " + a.name : "새 자산 직접 입력"),
    h("div", { class: "bd" }, sections, h("fieldset", null, h("legend", null, "메모"), h("textarea", { id: "fm-memo", rows: 2, style: { width: "100%" } }, a.memo || ""))),
    h("div", { class: "ft" }, id ? h("button", { class: "btn danger", id: "fmDel", type: "button" }, "삭제") : null,
      h("button", { class: "btn", id: "fmCancel", type: "button" }, "취소"), h("button", { class: "btn primary", id: "fmSave", type: "button" }, "저장")));
  const desc = () => $("#fmModeDesc").textContent = MODE_DESC[$("#fm-mode").value] || "";
  desc(); $("#fm-mode").addEventListener("change", desc);
  $("#fm-cls").addEventListener("change", () => { const c = $("#fm-cls").value; fillSelect($("#fm-cat"), CATS[c] || []);
    $("#fm-mode").value = c === "부동산" ? "QUOTE" : (c === "실물자산" || c === "부채") ? "MANUAL" : (DEFMODE[$("#fm-cat").value] || "MANUAL"); desc(); });
  $("#fm-cat").addEventListener("change", () => { if($("#fm-cls").value === "금융자산"){ $("#fm-mode").value = DEFMODE[$("#fm-cat").value] || "MANUAL"; desc(); } });
  $("#fm-owner").addEventListener("change", () => { if($("#fm-owner").value === "직접입력"){ const v = prompt("소유자 별칭 (예: 본인, 배우자, 자녀, 공동)", "");
    if(v){ $("#fm-owner").prepend(h("option", { value: v }, v)); $("#fm-owner").value = v; } else $("#fm-owner").value = owners()[0]; } });
  $("#fmCancel").addEventListener("click", closeModal);
  if(id) $("#fmDel").addEventListener("click", () => { closeModal(); delAsset(id); });
  $("#fmSave").addEventListener("click", () => {
    const gv = f => ($("#fm-" + f) ? $("#fm-" + f).value : "");
    const o = id ? byId(id) : { id: nextId() };
    ["owner","cls","cat","name","code","market","inst","mode","cur","compound","addr","complex","lawd","floor","start","end","memo"].forEach(f => o[f] = String(gv(f) || "").trim());
    ["qty","avg","principal","fxAtCost","value","rate","monthly","area","deposit","rent"].forEach(f => o[f] = pnum(gv(f)));
    o.acct = maskAcct(gv("acct")); o.active = Number(gv("active")); o.secures = gv("secures") ? Number(gv("secures")) : undefined;
    if(!o.name){ alert("자산명을 입력해 주세요."); return; }
    touch(o); if(!id) S.db.assets.push(o);
    if(o.cls === "부동산" && o.value) putHist(priceKey(o), todayISO(), o.value);
    save(); closeModal(); S.sel.asset = o.id; renderAll(); status((id ? "수정" : "추가") + " 완료: " + o.name);
  });
}
function delAsset(id){
  const a = byId(id); if(!a) return;
  if(!confirm("[" + a.name + "] 자산과 거래기록을 삭제할까요?")) return;
  const t = Date.now();
  S.db.tomb["assets:" + id] = t;
  S.db.trades.filter(x => x.asset === id).forEach(x => S.db.tomb["trades:" + x.id] = t);
  S.db.assets = S.db.assets.filter(x => x.id !== id); S.db.trades = S.db.trades.filter(x => x.asset !== id);
  delete S.db.hist["RE:" + id];
  save(); renderAll(); status("삭제: " + a.name);
}

/* ── 3. 카테고리별 ────────────────────────────────────────────────────── */
function sumTable(groups, total, label, selKey){
  return table({ columns: [
      { key: "k", label }, { key: "count", label: "항목수", align: "c" },
      { key: "basis", label: "원금 합계", align: "r", render: g => fmtNum(g.basis) },
      { key: "value", label: "현재가치", align: "r", render: g => fmtNum(g.value) },
      { key: "pl", label: "수익금", align: "r", cls: g => g.value - g.basis < 0 ? "neg" : null, render: g => g.basis ? fmtNum(g.value - g.basis) : "" },
      { key: "plp", label: "수익률", align: "r", cls: g => g.value - g.basis < 0 ? "neg" : null, render: g => g.basis ? fmtPct((g.value - g.basis) / g.basis * 100) : "" },
      { key: "share", label: "비중", align: "r", render: g => total ? (g.value / total * 100).toFixed(1) + "%" : "" }],
    rows: groups, rowAttrs: g => ({ "data-k": g.k, class: selKey === g.k ? "sel" : null }), empty: "자산이 없습니다" });
}
function renderCat(){
  replace($("#tblCat"), sumTable(groupSum(S.rows, "cat"), S.tot.asset, "카테고리", S.sel.cat));
  replace($("#tblOwner"), sumTable(groupSum(S.rows, "owner"), S.tot.asset, "소유자"));
  $("#catSel").textContent = S.sel.cat || "카테고리를 선택하세요";
  const list = S.sel.cat ? S.rows.filter(r => r.cat === S.sel.cat) : [];
  replace($("#tblCatDetail"), table({ columns: [
      { key: "owner", label: "소유자", align: "c" }, { key: "name", label: "자산명" }, { key: "inst", label: "기관" },
      { key: "qty", label: "수량", align: "r", render: r => r.qty ? fmtNum(r.qty, 4) : "" },
      { key: "basis", label: "원금", align: "r", render: r => fmtNum(r.basis) }, { key: "value", label: "평가액", align: "r", render: r => fmtNum(r.value) },
      { key: "pl", label: "손익", align: "r", cls: r => r.pl < 0 ? "neg" : null, render: r => r.pl == null ? "" : fmtNum(r.pl) },
      { key: "plPct", label: "수익률", align: "r", cls: r => r.pl < 0 ? "neg" : null, render: r => fmtPct(r.plPct) }, { key: "memo", label: "메모" }],
    rows: list, empty: "카테고리 행을 클릭하세요" }));
}

/* ── 4. 주식·ETF ──────────────────────────────────────────────────────── */
function consolidated(){
  const m = new Map();
  S.rows.filter(r => (r.cat === "주식" || r.cat === "ETF") && !r.isDebt).forEach(r => {
    const k = r.code || r.name;
    const g = m.get(k) || { k, name: r.name, code: r.code || "", accts: [], qty: 0, basis: 0, value: 0, cur: S.quotes[priceKey(r)], ccy: r.cur };
    g.qty += r.qty || 0; g.basis += r.basis; g.value += r.value;
    const lab = (r.inst || "") + (r.acct || ""); if(lab && !g.accts.includes(lab)) g.accts.push(lab);
    m.set(k, g);
  });
  return [...m.values()].sort((a, b) => b.value - a.value);
}
function renderStock(){
  const items = consolidated();
  replace($("#tblStock"), table({ columns: [
      { key: "name", label: "종목명" }, { key: "code", label: "코드", align: "c" }, { key: "accts", label: "보유 계좌", render: g => g.accts.join(", ") },
      { key: "qty", label: "총수량", align: "r", render: g => fmtNum(g.qty, 4) },
      { key: "avgp", label: "평균매입가(₩)", align: "r", render: g => fmtNum(g.qty ? g.basis / g.qty : 0) },
      { key: "cur", label: "현재가", align: "r", render: g => g.cur ? fmtNum(g.cur, g.ccy === "USD" ? 2 : 0) + (g.ccy === "USD" ? " $" : "") : "" },
      { key: "basis", label: "총원금", align: "r", render: g => fmtNum(g.basis) }, { key: "value", label: "현재총가치", align: "r", render: g => fmtNum(g.value) },
      { key: "pl", label: "수익금", align: "r", cls: g => g.value - g.basis < 0 ? "neg" : null, render: g => fmtNum(g.value - g.basis) },
      { key: "plp", label: "수익률", align: "r", cls: g => g.value - g.basis < 0 ? "neg" : null, render: g => fmtPct(g.basis ? (g.value - g.basis) / g.basis * 100 : null) }],
    rows: items, empty: "주식·ETF 자산이 없습니다" }));
  treemap($("#chTree"), items.map((g, i) => ({ k: g.name, value: g.value, color: g.value - g.basis < 0 ? C.red : PAL[i % PAL.length],
    sub: fmtWon(g.value - g.basis) + " (" + fmtPct(g.basis ? (g.value - g.basis) / g.basis * 100 : null) + ")" })));
  const tradables = active().filter(a => a.code && a.cls === "금융자산");
  const sel = $("#dtSel"), keep = sel.value;
  replace(sel, tradables.map(a => h("option", { value: a.id }, a.name + " (" + a.code + ") · " + a.owner)));
  if(tradables.length) sel.value = tradables.some(a => String(a.id) === keep) ? keep : String(tradables[0].id);
  renderDetail();
}
function renderDetail(){
  const a = byId($("#dtSel").value);
  if(!a){ emptyChart($("#chDetail"), "종목코드가 등록된 금융자산이 없습니다"); clear($("#tblTrades")); return; }
  const years = parseFloat($("#dtRange").value), from = addDays(todayISO(), -Math.round(365 * years));
  const key = priceKey(a), hist = Object.entries(S.db.hist[key] || {}).filter(([d]) => d >= from).sort();
  const trades = S.db.trades.filter(t => t.asset === a.id).sort((x, y) => x.date < y.date ? -1 : 1);
  if(hist.length > 1){
    lineChart($("#chDetail"), { height: 300, dateFmt: years > 0.6 ? "ym" : "md",
      series: [{ name: a.name + " 종가", color: "#2660A4", pts: hist.map(([d, p]) => [+dOf(d), p]), area: true, label: false }],
      hlines: a.avg ? [{ y: a.avg, label: "평균단가 " + fmtNum(a.avg), color: C.gray }] : [],
      markers: trades.filter(t => t.date >= from && t.price).map(t => ({ d: +dOf(t.date), y: t.price, type: t.side, qty: t.qty })), legend: false });
  }else emptyChart($("#chDetail"), "저장된 일별 시세가 없습니다 — [일별 시세 받기]");
  const e = evaluate(a, ctx());
  const t = table({ columns: [
      { key: "date", label: "날짜", align: "c" }, { key: "side", label: "구분", align: "c", cls: t => t.side === "매도" ? "neg" : null },
      { key: "qty", label: "수량", align: "r", render: t => fmtNum(t.qty, 4) }, { key: "price", label: "단가", align: "r", render: t => fmtNum(t.price, 2) },
      { key: "amount", label: "금액", align: "r", render: t => fmtNum(t.amount) }, { key: "memo", label: "메모" },
      { key: "_del", label: "", align: "c", render: t => h("button", { class: "btn sm", type: "button", "data-del": t.id }, "삭제") }],
    rows: trades, empty: "기록된 매수/매도가 없습니다",
    foot: [{ text: "현재가 " + fmtNum(S.quotes[key] || 0, a.cur === "USD" ? 2 : 0), attrs: { colspan: 3 } },
           { text: "평가액 " + fmtWon(e.value), attrs: { colspan: 2, class: "r" } }, { text: "손익 " + fmtWon(e.pl), attrs: { colspan: 2 } }] });
  replace($("#tblTrades"), t);
}
function openTradeForm(){
  const a = byId($("#dtSel").value); if(!a){ alert("먼저 종목을 선택하세요."); return; }
  const fld = (id, label, ctrl) => h("div", { class: "field" }, h("label", { for: id }, label), ctrl);
  openModal(h("h3", null, "매수/매도 기록 — " + a.name),
    h("div", { class: "bd" }, h("fieldset", null, h("legend", null, "내용"), h("div", { class: "fgrid" },
      fld("td-date", "날짜", h("input", { type: "date", id: "td-date", value: todayISO() })),
      fld("td-side", "구분", h("select", { id: "td-side" }, ["매수","매도","입금","출금"].map(v => h("option", { value: v }, v)))),
      fld("td-qty", "수량", h("input", { type: "text", class: "num", id: "td-qty" })),
      fld("td-price", "단가", h("input", { type: "text", class: "num", id: "td-price" })),
      fld("td-memo", "메모", h("input", { type: "text", id: "td-memo" })))),
      h("div", { class: "note" }, "기록한 수량·단가는 [자산 추이]의 과거 보유수량·투입원금 계산에 사용됩니다.")),
    h("div", { class: "ft" }, h("button", { class: "btn", id: "tdCancel", type: "button" }, "취소"), h("button", { class: "btn primary", id: "tdSave", type: "button" }, "저장")));
  $("#tdCancel").addEventListener("click", closeModal);
  $("#tdSave").addEventListener("click", () => {
    const q = pnum($("#td-qty").value), p = pnum($("#td-price").value);
    S.db.trades.push(touch({ id: nextId(), asset: a.id, date: $("#td-date").value || todayISO(), side: $("#td-side").value, qty: q, price: p, amount: q * p, memo: $("#td-memo").value }));
    save(); closeModal(); renderDetail(); status("거래기록 추가");
  });
}

/* ── 5. 부동산 ────────────────────────────────────────────────────────── */
function putHist(key, iso, price){ (S.db.hist[key] = S.db.hist[key] || {})[iso] = Math.round(Number(price) * 100) / 100; }
function renderRe(){
  const list = S.rows.filter(r => r.cls === "부동산");
  replace($("#tblRe"), table({ columns: [
      { key: "owner", label: "소유자", align: "c" }, { key: "cat", label: "유형", align: "c" }, { key: "name", label: "자산명" }, { key: "addr", label: "소재지" },
      { key: "area", label: "전용면적", align: "r", render: r => r.area ? fmtNum(r.area, 2) : "" },
      { key: "basis", label: "취득가", align: "r", render: r => fmtNum(r.basis) }, { key: "value", label: "평가액", align: "r", render: r => fmtNum(r.value) },
      { key: "pl", label: "평가손익", align: "r", cls: r => r.pl < 0 ? "neg" : null, render: r => r.pl == null ? "" : fmtNum(r.pl) },
      { key: "plPct", label: "수익률", align: "r", cls: r => r.pl < 0 ? "neg" : null, render: r => fmtPct(r.plPct) },
      { key: "_loan", label: "연결대출", align: "r", render: r => fmtNum(loansFor(r.id, S.rows, S.links)) },
      { key: "_eq", label: "순자산", align: "r", render: r => fmtNum(r.value - loansFor(r.id, S.rows, S.links)) },
      { key: "_src", label: "시세기준", align: "c", render: r => { const ks = Object.keys(S.db.hist[priceKey(r)] || {}).sort(); return ks.length ? ks[ks.length - 1] : "미조회"; } }],
    rows: list, rowAttrs: r => ({ "data-id": r.id, tabindex: 0, class: S.sel.re === r.id ? "sel" : null }),
    empty: "등록된 부동산이 없습니다 — [자산 목록]에서 자산군을 부동산으로 추가하세요" }));
  if(!$("#reKind").options.length) fillSelect($("#reKind"), RTMS_KINDS);
  renderReHist();
}
function renderReHist(){
  const a = byId(S.sel.re), node = $("#chRe");
  if(!a){ emptyChart(node, "부동산 행을 클릭하면 시세 추이가 표시됩니다"); $("#reHistNote").textContent = ""; return; }
  $("#reHistNote").textContent = a.name;
  const s = Object.entries(S.db.hist[priceKey(a)] || {}).sort();
  if(!s.length){ emptyChart(node, "시세 이력이 없습니다 — 실거래가를 조회해 반영하거나 직접 기록하세요"); return; }
  lineChart(node, { height: 260, dateFmt: "ym", series: [{ name: a.name, color: C.navy, pts: s.map(([d, p]) => [+dOf(d), p]), area: true, dots: true }],
    hlines: a.principal ? [{ y: +a.principal, label: "취득가 " + fmtWon(a.principal), color: C.green }] : [], legend: false });
}
function reRegionSearch(){
  const q = ($("#reRegion").value || "").replace(/\s/g, "");
  const cands = Object.keys(LAWD).filter(k => !q || k.replace(/\s/g, "").includes(q)).slice(0, 60);
  replace($("#reLawdSel"), cands.map(k => h("option", { value: LAWD[k] }, k + " (" + LAWD[k] + ")")));
  if(cands.length) $("#reLawd").value = LAWD[cands[0]];
}
async function reQuery(){
  const lawd = ($("#reLawd").value || "").trim();
  if(!/^\d{5}$/.test(lawd)){ alert("법정동코드(시군구 5자리)를 입력하거나 지역을 검색하세요."); return; }
  const msg = $("#reMsg"); msg.className = "note"; msg.textContent = "서버가 실거래가를 조회하는 중… (캐시된 달은 즉시)";
  $("#btnReQuery").disabled = true;
  try{
    const r = await api.rtms({ lawd, kind: $("#reKind").value, months: Math.max(1, pnum($("#reMonths").value) || 6),
      complex: ($("#reComplex").value || "").trim(), area: pnum($("#reArea").value) });
    S.deals = r.deals; S.reSummary = r.summary; renderDeals();
    const meta = " · " + r.months.length + "개월 중 캐시 " + r.cachedMonths + " · 전체 " + r.totalDeals + "건" + (r.errors.length ? " · 실패 " + r.errors.length + "개월" : "");
    if(r.summary){
      msg.className = "ok";
      replace(msg, "추정 시세 ", h("b", null, fmtWon(r.summary.value)), " · 매칭 " + r.summary.n + "건 (이상치 " + r.summary.outliers + "건 제외) · ㎡단가 중위 " +
        fmtNum(r.summary.unitMedian) + "만원 (" + fmtNum(r.summary.unitMin) + "~" + fmtNum(r.summary.unitMax) + ") · 최근 " + r.summary.lastDate + " " + fmtWon(r.summary.lastAmount) + meta);
    }else{ msg.className = "warn"; msg.textContent = r.msg + meta; }
  }catch(e){ msg.className = "warn"; msg.textContent = "조회 실패: " + e.message; }
  $("#btnReQuery").disabled = false;
}
function renderDeals(){
  replace($("#tblDeals"), table({ columns: [
      { key: "date", label: "거래일", align: "c" }, { key: "name", label: "단지명" }, { key: "dong", label: "법정동" },
      { key: "area", label: "면적(㎡)", align: "r", render: d => fmtNum(d.area, 2) }, { key: "floor", label: "층", align: "c" },
      { key: "amount", label: "거래금액", align: "r", render: d => fmtNum(d.amount) }, { key: "unit", label: "㎡단가(만원)", align: "r", render: d => fmtNum(d.unit) }],
    rows: S.deals.slice(0, 300), empty: "조회 결과가 없습니다" }));
}
function reApply(){
  const a = byId(S.sel.re); if(!a){ alert("위 목록에서 부동산을 선택하세요."); return; }
  if(!S.reSummary){ alert("먼저 실거래가를 조회하세요."); return; }
  const v = S.reSummary.value;
  if(!confirm("[" + a.name + "] 평가액을 " + fmtWon(v) + " 으로 갱신할까요?\n(기존 " + fmtWon(a.value) + ")")) return;
  a.value = v; a.mode = "QUOTE"; touch(a); putHist(priceKey(a), todayISO(), v);
  save(); renderAll(); status(a.name + " 평가액 갱신: " + fmtWon(v));
}
function reHistAdd(){
  const a = byId(S.sel.re); if(!a){ alert("부동산을 선택하세요."); return; }
  const d = $("#reHDate").value || todayISO(), v = pnum($("#reHVal").value);
  if(!v){ alert("평가액을 입력하세요."); return; }
  putHist(priceKey(a), d, v);
  const latest = Object.keys(S.db.hist[priceKey(a)]).sort().pop();
  if(latest === d){ a.value = v; touch(a); }          // 최신 기록이면 평가액도 맞춘다 (이력·평가액 불일치 방지)
  save(); renderAll(); $("#reHVal").value = ""; status(a.name + " 시세 기록: " + d + " " + fmtWon(v));
}

/* ── 6. 자산 추이 ─────────────────────────────────────────────────────── */
function runTrend(){
  $("#trNote").textContent = "스냅샷 " + S.db.snaps.length + "건";
  if($("#trMode").value === "snap"){
    if(!S.db.snaps.length){ emptyChart($("#chTrend1"), "저장된 스냅샷이 없습니다 — 상단 [스냅샷 저장]"); emptyChart($("#chTrend2"), ""); return; }
    const Sn = S.db.snaps.slice().sort((a, b) => a.ts < b.ts ? -1 : 1), px = Sn.map(s => +new Date(s.ts));
    lineChart($("#chTrend1"), { height: 320, dateFmt: "ym", zeroBase: true, series: [
      { name: "총자산", color: C.green, pts: Sn.map((s, i) => [px[i], s.asset]), area: true, dots: true },
      { name: "순자산", color: C.navy, pts: Sn.map((s, i) => [px[i], s.net]), dots: true },
      { name: "투자원금", color: C.gray, pts: Sn.map((s, i) => [px[i], s.basis]), dash: "5 4", dots: true }] });
    const keys = [...new Set(Sn.flatMap(s => Object.keys(s.detail || {})))];
    stackedArea($("#chTrend2"), Sn.map((s, i) => new Date(px[i])), keys.map((k, i) => ({ name: k, color: PAL[i % PAL.length], vals: Sn.map(s => (s.detail || {})[k] || 0) })));
    $("#trFlags").textContent = "실측"; return;
  }
  const r = reconstruct({ assets: S.db.assets, trades: S.db.trades, history: S.db.hist, fx: S.fx, today: todayISO(),
    years: parseFloat($("#trYears").value), taxRate: ctx().taxRate });
  const px = r.dates.map(d => +dOf(d));
  lineChart($("#chTrend1"), { height: 330, dateFmt: "ym", zeroBase: true, series: [
    { name: "총자산", color: C.green, pts: r.asset.map((v, i) => [px[i], v]), area: true },
    { name: "순자산", color: C.navy, pts: r.net.map((v, i) => [px[i], v]) },
    { name: "투입원금", color: C.gray, pts: r.basis.map((v, i) => [px[i], v]), dash: "5 4", width: 1.3 }] });
  const cats = [...r.byCat.entries()].sort((a, b) => b[1].at(-1) - a[1].at(-1)).slice(0, 10);
  stackedArea($("#chTrend2"), r.dates.map(dOf), cats.map(([k, v], i) => ({ name: k, color: PAL[i % PAL.length], vals: v })));
  const fl = [];
  if(r.flags.has(FLAG.ESTIMATED)) fl.push("일부 구간은 시세 이력이 없어 보간한 추정값입니다");
  if(r.flags.has("INCONSISTENT_TRADES")) fl.push("⚠ 거래기록이 보유수량과 모순되는 종목이 있습니다");
  $("#trFlags").textContent = fl.join(" · ");
  const chg = r.asset.at(-1) - r.asset[0];
  status("추정 시계열 · 기간 변동 " + fmtWon(chg) + " (" + fmtPct(r.asset[0] ? chg / r.asset[0] * 100 : null) + ")");
}
async function fetchAllHistory(){
  const list = active().filter(a => a.mode === "AUTO" && a.code);
  const years = parseFloat($("#trYears").value) || 3;
  let ok = 0, fail = 0;
  const res = await pool(list, async (a, i) => {
    progress(i + 1, list.length); status("일별 시세 " + (i + 1) + "/" + list.length + " · " + a.name);
    const key = priceKey(a), have = Object.keys(S.db.hist[key] || {}).sort();
    const from = have.length ? addDays(have.at(-1), 1) : addDays(todayISO(), -Math.round(365 * years));   // 증분 수신
    if(from > todayISO()) return 0;
    const r = await api.history(a.market || "KR", a.code, from);
    r.rows.forEach(([d, p]) => putHist(key, d, p));
    return r.rows.length;
  }, 4);
  res.forEach(r => r.ok ? ok++ : fail++);
  progress(0, 0); save(); status("일별 시세 수신 — 성공 " + ok + " / 실패 " + fail); runTrend();
}
function saveSnapshot(){
  const detail = {}; groupSum(S.rows, "cat").forEach(g => detail[g.k] = Math.round(g.value));
  const ts = new Date().toISOString().slice(0, 19);
  S.db.snaps = S.db.snaps.filter(s => s.ts.slice(0, 10) !== ts.slice(0, 10));      // 하루 1건
  S.db.snaps.push({ ts, asset: S.tot.asset, debt: S.tot.debt, net: S.tot.net, basis: S.tot.basis, detail });
  save(); status("스냅샷 저장 (총 " + S.db.snaps.length + "건)");
}

/* ── 7. 시장 지수 ─────────────────────────────────────────────────────── */
const IDX_SYM = { "S&P 500": "^GSPC", "NASDAQ 100": "^NDX", "KOSPI": "^KS11", "KOSDAQ": "^KQ11" };
async function loadIndexes(){
  const from = $("#ixRange").value; $("#ixMsg").textContent = "불러오는 중…";
  replace($("#ixCharts"), INDEXES.map((nm, i) => h("div", { class: "box" }, h("h3", null, nm, " ", h("span", { class: "hint", id: "ixn" + i })), h("div", { class: "bd", id: "ix" + i }))));
  const res = await pool(INDEXES, nm => api.history("US", IDX_SYM[nm], from), 4);
  let ok = 0;
  res.forEach((r, i) => {
    const nm = INDEXES[i];
    if(!r.ok || !r.value.rows.length){ emptyChart($("#ix" + i), nm + " 조회 실패" + (r.ok ? "" : " (" + r.error.message + ")")); return; }
    const hst = r.value.rows, chg = (hst.at(-1)[1] - hst[0][1]) / hst[0][1] * 100;
    lineChart($("#ix" + i), { height: 250, dateFmt: "ym", series: [{ name: nm, color: PAL[i % PAL.length], pts: hst.map(([d, p]) => [+dOf(d), p]), area: true, label: false }], legend: false });
    $("#ixn" + i).textContent = "현재 " + fmtNum(hst.at(-1)[1], 2) + " · 기간변동 " + (chg >= 0 ? "▲" : "▼") + " " + Math.abs(chg).toFixed(2) + "%"; ok++;
  });
  $("#ixMsg").textContent = ok ? ok + "개 지수 갱신" : "조회 실패";
}

/* ── 시세 갱신 ────────────────────────────────────────────────────────── */
async function refreshQuotes(){
  const list = active().filter(a => a.mode === "AUTO" && a.code);
  const kr = [...new Set(list.filter(a => (a.market || "KR") === "KR").map(a => a.code))];
  const us = [...new Set(list.filter(a => a.market === "US").map(a => a.code))];
  status("시세 조회 중 (" + (kr.length + us.length) + "종목 · 서버 동시 처리)"); progress(1, 2);
  const r = await api.quote({ kr, us });                 // 프로토타입의 13회 순차 → 1회 왕복
  S.quoteErrs = {};
  const today = todayISO();
  for(const k in r.quotes){
    const q = r.quotes[k];
    if(k === "FX"){ S.fx = { USD: q.USD }; S.db.set.fx = S.fx; continue; }
    if(k.startsWith("IDX:")){ S.idx[k.slice(4)] = q; continue; }
    S.quotes[k] = q.price; S.quoteAt[k] = today; putHist(k, today, q.price);
  }
  for(const k in r.errors){
    if(k === "FX"){ S.fx = S.db.set.fx || S.fx; S.quoteErrs["환율"] = r.errors[k]; continue; }
    if(k.startsWith("IDX:")) continue;
    const ks = Object.keys(S.db.hist[k] || {}).sort();
    if(ks.length){ S.quotes[k] = S.db.hist[k][ks.at(-1)]; S.quoteAt[k] = ks.at(-1); }
    S.quoteErrs[k] = r.errors[k] + (ks.length ? " → " + ks.at(-1) + " 시세 사용" : "");
  }
  active().forEach(a => { if(a.cls === "부동산" && a.value) S.quotes[priceKey(a)] = +a.value; });
  progress(0, 0); save(); renderAll();
  const n = Object.keys(S.quoteErrs).length;
  status("시세 갱신 완료 " + new Date().toLocaleTimeString("ko-KR") + (n ? " · 실패 " + n + "건 (자산 목록 하단 참조)" : ""));
}

/* ── 8. 설정 ──────────────────────────────────────────────────────────── */
const GUIDE = [
  ["데이터 보관", "자산 원본은 이 브라우저의 IndexedDB에 있고, 서버에는 잠금 암호로 암호화한 봉투만 올라갑니다. 서버·Cloudflare는 내용을 읽을 수 없습니다."],
  ["잠금 암호", "서버는 암호를 모릅니다. 잃어버리면 복구할 수 없으니 JSON 백업을 주기적으로 내려받으세요."],
  ["개인정보", "계좌번호는 뒤 4자리만 저장됩니다. 소유자는 실명 대신 별칭을 권장합니다. 주민등록번호는 입력란 자체가 없습니다."],
  ["참고 수치", "시세·실거래가·경과이자는 참고용 추정치이며 실제 처분가액·세후 수령액과 다를 수 있습니다. 예금 이자는 만기일까지만 계산되며 [세후] 옵션을 켜면 15.4%를 뗍니다."],
  ["출처", "국내 시세: 네이버 금융 / 해외·지수: Yahoo Finance / 환율: Frankfurter(ECB) / 실거래가: 국토교통부 OpenAPI. 모두 서버가 조회하며 인증키는 서버에만 있습니다."]];
function renderSettings(){
  replace($("#guide"), h("ul", { style: { margin: 0, paddingLeft: "18px", lineHeight: 1.9 } }, GUIDE.map(([t, b]) => h("li", null, h("b", null, t), " — ", b))));
  replace($("#acctInfo"), h("b", null, S.me.email), " · 가구 ", h("b", null, S.hh.name), " (" + S.hh.role + ")",
    h("label", { style: { marginLeft: "14px" } }, h("input", { type: "checkbox", id: "setTax", checked: !!S.db.set.afterTax }), " 이자 세후(15.4%)로 표시"));
  $("#setTax").addEventListener("change", e => { S.db.set.afterTax = e.target.checked; save(); renderAll(); });
  paintStore();
}
function download(name, blob){ const a = h("a", { href: URL.createObjectURL(blob), download: name }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
function exportJson(){ download("가족자산_백업_" + todayISO().replace(/-/g, "") + ".json", new Blob([JSON.stringify(S.db, null, 1)], { type: "application/json" })); status("JSON 백업 내려받음"); }
function exportCsv(){
  const cols = ACOLS.filter(c => !c.key.startsWith("_"));
  const cell = v => { const t = String(v == null ? "" : v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const lines = [cols.map(c => cell(c.label)).join(",")].concat(filteredRows().map(r => cols.map(c => cell(c.key === "name" ? r.name : c.render ? textOf(c.render(r)) : r[c.key])).join(",")));
  download("자산목록_" + todayISO().replace(/-/g, "") + ".csv", new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
}
const textOf = v => Array.isArray(v) ? v.map(textOf).join("") : (v && v.nodeType) ? v.textContent : String(v == null ? "" : v);
function importJson(file){
  const fr = new FileReader();
  fr.onload = async () => {
    try{
      const d = JSON.parse(fr.result);
      if(!d || !Array.isArray(d.assets)) throw new Error("형식이 올바르지 않습니다");
      if(!confirm("현재 데이터에 백업 파일을 병합합니다 (같은 id는 최신 쪽). 계속할까요?")) return;
      exportJson();                                           // 되돌릴 수 있게 현재 상태를 먼저 내려받는다
      S.db = Store.merge(Store.migrate(d), S.db);
      await save({ syncNow: true }); boot2(); status("불러오기 완료 — 자산 " + S.db.assets.length + "건");
    }catch(e){ alert("불러오기 실패: " + e.message); }
  };
  fr.readAsText(file);
}
async function loadSample(){
  const { sample } = await import("./sample.js");
  const s = sample(nextId);
  S.db.assets.push(...s.assets); S.db.trades.push(...s.trades);
  for(const k in s.hist) S.db.hist[k] = { ...(S.db.hist[k] || {}), ...s.hist[k] };
  save(); boot2();
}

/* ── 이벤트 연결 ──────────────────────────────────────────────────────── */
function bind(){
  renderNav();
  $("#today").textContent = " " + new Date().toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
  $("#btnRefresh").addEventListener("click", async () => { const b = $("#btnRefresh"); b.disabled = true;
    try{ await refreshQuotes(); }catch(e){ progress(0, 0); status("시세 갱신 실패: " + e.message); } b.disabled = false; });
  $("#btnSnap").addEventListener("click", saveSnapshot);
  ["fCls", "fOwner"].forEach(id => $("#" + id).addEventListener("change", renderAssets));
  $("#fKw").addEventListener("input", renderAssets);
  $("#btnNew").addEventListener("click", () => openAssetForm(0));
  $("#btnEdit").addEventListener("click", () => S.sel.asset ? openAssetForm(S.sel.asset) : alert("표에서 자산 행을 선택하세요."));
  $("#btnDel").addEventListener("click", () => S.sel.asset ? delAsset(S.sel.asset) : alert("표에서 자산 행을 선택하세요."));
  const ta = $("#tblAssets");
  ta.addEventListener("click", e => {
    const th = e.target.closest("th[data-sort]");
    if(th){ const f = th.dataset.sort; S.sort = S.sort.f === f ? { f, dir: -S.sort.dir } : { f, dir: 1 }; renderAssets(); return; }
    const tr = e.target.closest("tr[data-id]"); if(tr) selectRow(tr);
  });
  ta.addEventListener("dblclick", e => { const td = e.target.closest("td.editable"); if(td) beginEdit(td); });
  ta.addEventListener("keydown", e => {
    const tr = e.target.closest("tr[data-id]"); if(!tr || e.target !== tr) return;
    if(e.key === "Enter"){ e.preventDefault(); selectRow(tr); beginEdit(tr.querySelector("td[data-f=name]")); }
    else if(e.key === "ArrowDown" && tr.nextElementSibling){ e.preventDefault(); tr.nextElementSibling.focus(); }
    else if(e.key === "ArrowUp" && tr.previousElementSibling){ e.preventDefault(); tr.previousElementSibling.focus(); }
    else if(e.key === "Delete"){ selectRow(tr); delAsset(Number(tr.dataset.id)); }
  });
  $("#tblCat").addEventListener("click", e => { const tr = e.target.closest("tr[data-k]"); if(tr){ S.sel.cat = tr.dataset.k; renderCat(); } });
  $("#dtSel").addEventListener("change", renderDetail); $("#dtRange").addEventListener("change", renderDetail);
  $("#btnTrade").addEventListener("click", openTradeForm);
  $("#tblTrades").addEventListener("click", e => { const b = e.target.closest("button[data-del]"); if(!b) return;
    const id = Number(b.dataset.del); S.db.tomb["trades:" + id] = Date.now(); S.db.trades = S.db.trades.filter(t => t.id !== id); save(); renderDetail(); });
  $("#btnDtFetch").addEventListener("click", async () => {
    const a = byId($("#dtSel").value); if(!a) return;
    status(a.name + " 일별 시세 받는 중…");
    try{ const key = priceKey(a), have = Object.keys(S.db.hist[key] || {}).sort();
      const from = have.length ? addDays(have.at(-1), 1) : addDays(todayISO(), -Math.round(365 * Math.max(parseFloat($("#dtRange").value), 1)));
      const r = await api.history(a.market || "KR", a.code, from); r.rows.forEach(([d, p]) => putHist(key, d, p));
      save(); renderDetail(); status(a.name + " 일별 시세 " + r.rows.length + "일 추가" + (r.cached ? " (서버 캐시)" : ""));
    }catch(e){ status("일별 시세 실패: " + e.message); }
  });
  $("#tblRe").addEventListener("click", e => { const tr = e.target.closest("tr[data-id]"); if(!tr) return;
    S.sel.re = Number(tr.dataset.id); const a = byId(S.sel.re);
    if(a){ $("#reComplex").value = a.complex || ""; $("#reArea").value = a.area || ""; if(a.lawd) $("#reLawd").value = a.lawd; if(RTMS_KINDS.includes(a.cat)) $("#reKind").value = a.cat; }
    renderRe(); });
  $("#reRegion").addEventListener("input", reRegionSearch);
  $("#reLawdSel").addEventListener("change", () => $("#reLawd").value = $("#reLawdSel").value);
  $("#btnReQuery").addEventListener("click", reQuery); $("#btnReApply").addEventListener("click", reApply); $("#btnReHAdd").addEventListener("click", reHistAdd);
  $("#btnTrend").addEventListener("click", runTrend); $("#btnTrendFetch").addEventListener("click", fetchAllHistory); $("#btnIxLoad").addEventListener("click", loadIndexes);
  $("#btnSync").addEventListener("click", syncUp);
  $("#btnInvite").addEventListener("click", async () => { const m = $("#invMsg"); m.textContent = "…";
    try{ const r = await api.household.invite(S.hh.id, $("#invEmail").value.trim(), $("#invRole").value); m.textContent = r.joined ? "즉시 합류했습니다" : "초대 등록 — 첫 로그인 시 합류"; }
    catch(e){ m.textContent = "실패: " + e.message; } });
  $("#btnExport").addEventListener("click", exportJson); $("#btnCsv").addEventListener("click", exportCsv);
  $("#btnImportBtn").addEventListener("click", () => $("#btnImport").click());
  $("#btnImport").addEventListener("change", e => { if(e.target.files[0]) importJson(e.target.files[0]); e.target.value = ""; });
  $("#btnSample").addEventListener("click", () => { if(confirm("샘플 가족 자산 데이터를 추가할까요?")) loadSample(); });
  $("#btnClearSnap").addEventListener("click", () => { if(confirm("스냅샷을 모두 삭제할까요?")){ S.db.snaps = []; save(); paintStore(); } });
  $("#btnLock").addEventListener("click", async () => { await Store.forgetKey(S.hh.id); location.reload(); });
  $("#btnWipe").addEventListener("click", async () => { if(!confirm("이 가구의 모든 자산·거래·시세이력을 삭제합니다. 서버 봉투도 빈 상태로 덮어씁니다. 계속할까요?")) return;
    const t = Date.now(); S.db.assets.forEach(a => S.db.tomb["assets:" + a.id] = t); S.db.trades.forEach(x => S.db.tomb["trades:" + x.id] = t);
    S.db = { ...Store.EMPTY(), set: S.db.set, tomb: S.db.tomb, seq: S.db.seq }; await save({ syncNow: true }); boot2(); status("전체 삭제 완료"); });
  $("#mask").addEventListener("click", e => { if(e.target.id === "mask") closeModal(); });
  document.addEventListener("keydown", e => { if(e.key === "Escape" && $("#mask").classList.contains("on")) closeModal(); });
  window.addEventListener("online", () => { S.online = true; syncUp(); });
  window.addEventListener("beforeunload", e => { if(S.dirty && S.syncing) e.preventDefault(); });
}
function boot2(){ renderQuickAdd(); renderSettings(); renderAll(); showTab(S.db.set.tab || "dash"); }

/* ── 잠금 화면 ────────────────────────────────────────────────────────── */
function askPassphrase({ first }){
  return new Promise(res => {
    const L = $("#lock"); L.hidden = false;
    $("#lockPw2Wrap").hidden = !first;
    $("#lockMsg").textContent = first
      ? "이 가구의 데이터 잠금 암호를 처음 정합니다. 가족과 공유할 암호를 고르세요. 서버는 이 암호를 알지 못하므로 잃어버리면 복구할 수 없습니다."
      : "데이터 잠금 암호를 입력하세요. 이 기기에 기억됩니다.";
    $("#lockPw").focus();
    const go = async () => {
      const pw = $("#lockPw").value; $("#lockErr").textContent = "";
      if(pw.length < 8){ $("#lockErr").textContent = "8자 이상"; return; }
      if(first && pw !== $("#lockPw2").value){ $("#lockErr").textContent = "확인 암호가 다릅니다"; return; }
      $("#lockGo").disabled = true; $("#lockErr").textContent = "키 생성 중 (600,000회 반복)…";
      try{
        const key = await Store.unlock(S.hh.id, pw, { kdfSalt: S.hh.kdfSalt, verifier: S.hh.verifier });
        if(first){ const v = await Store.newVerifier(key, S.hh.kdfSalt); await api.household.setVerifier(S.hh.id, v); S.hh.verifier = v; }
        L.hidden = true; res(key);
      }catch(e){ $("#lockErr").textContent = e.message; $("#lockGo").disabled = false; }
    };
    $("#lockGo").onclick = go;
    $("#lockPw").onkeydown = $("#lockPw2").onkeydown = e => { if(e.key === "Enter") go(); };
  });
}

/* ── 부팅 ─────────────────────────────────────────────────────────────── */
async function boot(){
  status("로그인 확인 중…");
  try{
    const me = await api.me();
    S.me = me.user; S.hh = me.households[0];
  }catch(e){ status("서버 연결 실패: " + e.message + " — 로그인(Access)이 필요합니다"); return; }

  S.key = await Store.storedKey(S.hh.id);
  if(!S.key) S.key = await askPassphrase({ first: !S.hh.verifier });

  const local = await Store.loadLocal(S.hh.id);
  S.db = local || Store.EMPTY();
  if(S.db.set.fx) S.fx = S.db.set.fx;
  active().forEach(a => { const k = priceKey(a);
    if(a.cls === "부동산" && a.value) S.quotes[k] = +a.value;
    else { const ks = Object.keys(S.db.hist[k] || {}).sort(); if(ks.length){ S.quotes[k] = S.db.hist[k][ks.at(-1)]; S.quoteAt[k] = ks.at(-1); } } });
  bind(); boot2();
  status("준비 완료 — 서버 봉투와 동기화 중…");
  await syncUp();
  if(!S.db.assets.length && confirm("등록된 자산이 없습니다.\n\n구조를 살펴볼 수 있는 샘플 데이터를 넣을까요? (설정에서 언제든 전체 삭제)")) await loadSample();
  status("준비 완료 — [시세 갱신]을 눌러보세요");
}
boot();
