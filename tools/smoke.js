/** 실제 Chromium에서 앱을 띄워 검증한다 — 가짜 /api 로.
 *  검증: 잠금 화면 → 키 파생 → 샘플 로드 → 표·차트 렌더 → XSS 무해화 → 서버로 나가는 봉투에 평문 없음.
 *  실행: npm run smoke   (PW_CORE=<playwright-core 경로> 로 위치 지정 가능) */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, extname } from "node:path";
import { existsSync, readdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const pwPath = process.env.PW_CORE || "playwright-core";
const { chromium } = require(pwPath);
// 최신 Chromium은 --headless=old 를 지원하지 않으므로 headless_shell(구 헤드리스 전용 바이너리)을 우선한다
const exe = process.env.CHROME || [...findChrome("/opt/pw-browsers"), "/opt/pw-browsers/chromium"].find(p => existsSync(p));

function findChrome(root){
  const shells = [], full = [];
  try{ for(const d of readdirSync(root)){
    const hs = join(root, d, "chrome-linux", "headless_shell"); if(existsSync(hs)) shells.push(hs);
    const ch = join(root, d, "chrome-linux", "chrome");         if(existsSync(ch)) full.push(ch);
  } }catch{}
  return [...shells, ...full];
}

/* ── 가짜 API ─────────────────────────────────────────────────────────── */
const state = { version: 0, envelope: null, verifier: null, puts: [] };
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const body = () => new Promise(r => { let s = ""; req.on("data", c => s += c); req.on("end", () => r(s ? JSON.parse(s) : null)); });
  if(url.pathname.startsWith("/api/")){
    if(url.pathname === "/api/me") return send(200, { user: { id: "u1", email: "test@example.com", name: "test" },
      households: [{ id: "h1", name: "테스트 가족", role: "owner", kdfSalt: "c2FsdHNhbHRzYWx0c2FsdA==", verifier: state.verifier }] });
    if(url.pathname === "/api/vault" && req.method === "GET") return send(200, { version: state.version, envelope: state.envelope });
    if(url.pathname === "/api/vault" && req.method === "PUT"){ const b = await body(); state.puts.push(b);
      if(b.baseVersion !== state.version) return send(409, { error: "conflict", version: state.version });
      state.version++; state.envelope = b.envelope; return send(200, { version: state.version }); }
    if(url.pathname === "/api/household/verifier"){ state.verifier = await body(); return send(200, { ok: true }); }
    if(url.pathname === "/api/quote") return send(200, { quotes: { "KR:005930": { price: 71000, diff: 500, rate: 0.7 }, "KR:360750": { price: 25500 },
      "US:AAPL": { price: 210 }, FX: { USD: 1380 }, "IDX:KOSPI": { price: 2800, diff: 10, rate: 0.36 } }, errors: { "KR:000660": "시세 없음" } });
    if(url.pathname === "/api/history") return send(200, { rows: [["2026-08-01", 70000], ["2026-08-15", 70500], ["2026-09-01", 71000]], cached: false });
    if(url.pathname === "/api/rtms") return send(200, { months: ["202609", "202608"], cachedMonths: 1, errors: [], totalDeals: 3,
      deals: [{ date: "2026-08-14", name: "송도더샵", dong: "송도동", area: 84.98, floor: "12", amount: 920e6, unit: 10826 }],
      summary: { value: 925e6, n: 3, outliers: 0, unitMedian: 10880, unitMin: 10700, unitMax: 11000, lastDate: "2026-08-14", lastAmount: 920e6 }, msg: "" });
    return send(404, { error: "no" });
  }
  let p = join("app", url.pathname === "/" ? "index.html" : url.pathname);
  try{ await stat(p); }catch{ p = "app/index.html"; }
  res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" });
  res.end(await readFile(p));
});

/* ── 테스트 ───────────────────────────────────────────────────────────── */
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail && !ok ? " — " + detail : "")); };

await new Promise(r => server.listen(0, r));
const port = server.address().port;
console.log("smoke: http://localhost:" + port + "  chromium=" + exe);
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("console", m => { if(m.type() === "error") errors.push("console: " + m.text()); });
page.on("dialog", d => d.accept());                 // 샘플 데이터 confirm → 수락

try{
  await page.goto("http://localhost:" + port + "/", { waitUntil: "load" });
  await page.waitForSelector("#lock:not([hidden])", { timeout: 10000 });
  check("잠금 화면이 먼저 뜬다 (검증기 없음 → 최초 설정)", await page.isVisible("#lockPw2"));
  await page.fill("#lockPw", "family-secret-2026"); await page.fill("#lockPw2", "family-secret-2026");
  await page.click("#lockGo");
  await page.waitForFunction(() => document.querySelector("#lock").hidden, null, { timeout: 30000 });   // PBKDF2 600k
  check("잠금 해제 (브라우저에서 PBKDF2 600,000회)", true);
  check("검증기가 서버에 등록됐다", !!state.verifier && !!state.verifier.ct);

  await page.waitForFunction(() => document.querySelectorAll("#tblAssets tbody tr[data-id]").length > 10, null, { timeout: 15000 });
  const n = await page.$$eval("#tblAssets tbody tr[data-id]", r => r.length);
  check("샘플 자산 " + n + "건 렌더", n > 20);
  check("헤더 총자산 표시", /총자산 \d/.test(await page.textContent("#hdTotal")));
  check("대시보드 도넛 SVG", !!(await page.$("#chPie svg")));
  check("소유자별 누적막대 SVG", !!(await page.$("#chOwner svg")));

  /* 서버로 나간 봉투 검사 — 종단간 암호화 */
  await page.waitForFunction(() => /동기화됨/.test(document.querySelector("#syncMsg").textContent), null, { timeout: 15000 });
  const put = state.puts.at(-1), raw = JSON.stringify(put);
  check("서버에 PUT된 봉투에 ct/iv/kdf가 있다", !!(put && put.envelope && put.envelope.ct && put.envelope.iv && put.envelope.kdf));
  check("봉투에 자산명 평문이 없다", !raw.includes("송도") && !raw.includes("삼성전자"));
  check("봉투에 금액 평문이 없다", !raw.includes("920000000") && !raw.includes("80000000"));
  check("봉투에 잠금 암호가 없다", !raw.includes("family-secret"));
  check("kdf 반복 600,000", put.envelope.kdf.iterations === 600000);

  /* XSS: 자산명에 페이로드 */
  await page.click("#nav-assets");
  const payload = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>'"`;
  await page.fill("#qa-name", payload); await page.click("#qaAdd");
  await page.waitForTimeout(300);
  const xss = await page.evaluate(() => window.__xss);
  const imgs = await page.$$eval("#tblAssets img, #tblAssets script", e => e.length);
  const cellText = await page.evaluate(p => [...document.querySelectorAll("#tblAssets td")].some(td => td.textContent.includes(p)), payload);
  check("XSS 페이로드가 실행되지 않았다", xss === undefined, "window.__xss=" + xss);
  check("페이로드가 요소로 해석되지 않았다 (img/script 0개)", imgs === 0, imgs + "개");
  check("페이로드가 문자 그대로 표시된다", cellText);

  /* 정렬·인라인 편집·키보드 */
  await page.click("#tblAssets th[data-sort=value]");
  check("머리글 클릭 정렬", !!(await page.$("#tblAssets th.asc, #tblAssets th.desc")));
  const firstRow = await page.$("#tblAssets tbody tr[data-id]");
  await firstRow.focus(); await page.keyboard.press("Enter");
  check("Enter로 인라인 편집 진입", !!(await page.$("#tblAssets td input")));
  await page.keyboard.press("Escape");
  check("Escape로 복원", !(await page.$("#tblAssets td input")));

  /* 시세 갱신 (가짜 서버 1회 왕복) */
  await page.click("#btnRefresh");
  await page.waitForFunction(() => /시세 갱신 완료/.test(document.querySelector("#status").textContent), null, { timeout: 10000 });
  check("시세 갱신 완료 + 실패 목록 표시", !(await page.$eval("#quoteErrs", e => e.hidden)));
  check("KOSPI 지수 카드", /2,800/.test(await page.textContent("#idxCards")));

  /* 추이 */
  await page.click("#nav-trend"); await page.click("#btnTrend");
  await page.waitForSelector("#chTrend1 svg", { timeout: 10000 });
  check("자산 추이 차트 (투입원금 시계열)", true);
  check("추정 구간 안내 표시", /추정/.test(await page.textContent("#trFlags")));

  /* 부동산 실거래가 */
  await page.click("#nav-re"); await page.click("#tblRe tbody tr[data-id]");
  await page.click("#btnReQuery");
  await page.waitForSelector("#reMsg.ok", { timeout: 10000 });
  check("실거래가 추정 (중위값·이상치) 표시", /추정 시세/.test(await page.textContent("#reMsg")));
  check("부동산 시세 추이 SVG", !!(await page.$("#chRe svg")));

  /* 가계부 */
  await page.click("#nav-ledger");
  await page.waitForSelector("#lq-amt", { timeout: 10000 });
  check("헤더 버전 표시", /^v\d+\.\d+\.\d+$/.test((await page.textContent("#ver")).trim()));
  const lgAdd = async (cat, sub, amt, memo) => { await page.selectOption("#lq-cat", cat); await page.selectOption("#lq-sub", sub);
    await page.fill("#lq-amt", amt); await page.fill("#lq-memo", memo); await page.press("#lq-memo", "Enter"); await page.waitForTimeout(150); };
  await lgAdd("수입", "월급", "350만", "9월 급여");
  await lgAdd("식비", "마트", "40,000", "장보기");
  await lgAdd("저축", "적금", "50만", "청년적금");
  await lgAdd("이체", "카드대금", "1,000,000", "카드값");           // 어느 합계에도 없어야 한다
  await lgAdd("식비", "외식", `<img src=x onerror="window.__xss2=1">`, "");   // 금액 자리에 페이로드 → 거부
  await lgAdd("식비", "외식", "20,000", `<img src=x onerror="window.__xss2=1">`); // 내용에 페이로드 → 텍스트
  const rows = await page.$$eval("#lg-month tbody tr[data-id]", r => r.length);
  check("가계부 항목 4건 렌더 (잘못된 금액 1건은 거부)", rows === 5, rows + "건");
  const cardsTxt = await page.textContent("#lg-month .cards");
  check("수입 350만 · 지출 6만 · 저축 50만", /수입350만원/.test(cardsTxt) && /지출6만원/.test(cardsTxt) && /저축50만원/.test(cardsTxt), cardsTxt.slice(0, 120));
  check("잔여 = 수입 − 지출 − 저축 (이체 제외)", /잔여294만원/.test(cardsTxt), cardsTxt);
  check("가계부 내용 XSS 미실행", (await page.evaluate(() => window.__xss2)) === undefined);
  check("가계부 내용 XSS 텍스트 렌더", await page.evaluate(() => [...document.querySelectorAll("#lg-month td")].some(td => td.textContent.includes("onerror"))) && (await page.$$eval("#lg-month img", e => e.length)) === 0);
  check("대분류별 지출 도넛", !!(await page.$("#lgDonut svg")));
  await page.click("#lgNav button[data-view=year]");
  await page.waitForSelector("#lyCh1 svg", { timeout: 5000 });
  check("연간표 렌더 (총 수입 행)", /총 수입/.test(await page.textContent("#lg-year")));
  await page.click("#lgNav button[data-view=fund]");
  await page.selectOption("#lf-cat", "저축"); await page.fill("#lf-amt", "30만"); await page.press("#lf-amt", "Enter"); await page.waitForTimeout(150);
  await page.selectOption("#lf-cat", "예비비"); await page.selectOption("#lf-sub", "여행"); await page.fill("#lf-amt", "10만"); await page.press("#lf-amt", "Enter"); await page.waitForTimeout(150);
  check("예비비 잔액 20만", /20만원/.test(await page.textContent("#lg-fund .cards")), await page.textContent("#lg-fund .cards"));
  await page.click("#lgNav button[data-view=set]");
  await page.fill("#lr-name", "관리비"); await page.fill("#lr-amt", "15만"); await page.fill("#lr-day", "10"); await page.click("#lrAdd"); await page.waitForTimeout(150);
  await page.click("#lgNav button[data-view=month]"); await page.click("#lgFill"); await page.waitForTimeout(200);
  check("고정지출 규칙 → 이달 항목 생성", /규칙/.test(await page.textContent("#lg-month tbody")));
  check("규칙 채우기 버튼은 채운 뒤 비활성", await page.$eval("#lgFill", b => b.disabled));

  /* 설정 · 세후 토글 */
  await page.click("#nav-set");
  const before = await page.textContent("#hdTotal");
  await page.click("#setTax"); await page.waitForTimeout(200);
  check("세후 토글이 총자산을 바꾼다", (await page.textContent("#hdTotal")) !== before);

  /* 재로드: 키가 기기에 남아 잠금 없이 열리고, 서버 봉투를 복호화해 병합 */
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll("#tblAssets tbody tr[data-id]").length > 10, null, { timeout: 15000 });
  check("재로드 후 잠금 화면 없이 복원 (IndexedDB의 CryptoKey)", await page.$eval("#lock", e => e.hidden));
  check("재로드 후 XSS 페이로드 자산도 여전히 텍스트", await page.evaluate(() => window.__xss === undefined));
  await page.click("#nav-ledger"); await page.waitForSelector("#lq-amt", { timeout: 5000 });
  const lgAfter = await page.$$eval("#lg-month tbody tr[data-id]", r => r.length);
  check("재로드 후 가계부 항목 복원 (봉투 v3 왕복)", lgAfter >= 6, lgAfter + "건");
  const rawL = JSON.stringify(state.puts.at(-1));
  check("봉투에 가계부 평문 없음", !rawL.includes("장보기") && !rawL.includes("청년적금"));

  check("페이지 오류 없음", errors.length === 0, errors.slice(0, 3).join(" | "));
}catch(e){ check("예외 없이 완료", false, e.message); errors.forEach(x => console.log("   ", x)); }

await browser.close(); server.close();
const fail = results.filter(r => !r.ok).length;
console.log(`\nsmoke: ${results.length - fail}/${results.length} passed`);
process.exit(fail ? 1 : 0);
