/** core/ 의 런타임 모듈을 app/core/ 로 복사한다.
 *  wrangler [assets] 는 ./app 만 서빙하므로 app 이 ../core 를 직접 참조할 수 없다.
 *  테스트 파일과 README는 제외. 실행: npm run build */
import { mkdirSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
const src = "core", dst = join("app", "core");
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
let n = 0;
for(const f of readdirSync(src)){
  if(!f.endsWith(".js") || f.endsWith(".test.js")) continue;
  copyFileSync(join(src, f), join(dst, f)); n++;
}
console.log(`build: core/ → app/core/ (${n} files)`);
