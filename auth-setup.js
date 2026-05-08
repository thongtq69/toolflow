// Chạy 1 lần đầu tiên để login Google → cookie persist vào userDataDir
// Lần sau server.js mở browser cùng userDataDir là đã có session

import { chromium } from 'playwright';
import path from 'path';

const USER_DATA_DIR = process.env.PROFILE_DIR || path.resolve('./profile');
const FLOW_URL = 'https://labs.google/fx/tools/flow';

const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
});

const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(FLOW_URL);

console.log('\n>>> Đã mở Flow. Anh login Google bằng vohuuhai2018@gmail.com');
console.log('>>> Sau khi vào được Flow project list, đóng browser này.');
console.log('>>> Cookie sẽ persist trong:', USER_DATA_DIR, '\n');

// Chờ user đóng tab/browser thủ công
await new Promise((resolve) => {
  ctx.on('close', resolve);
  page.on('close', () => setTimeout(resolve, 1500));
});

await ctx.close().catch(() => {});
console.log('✓ Auth setup xong. Profile lưu tại', USER_DATA_DIR);
