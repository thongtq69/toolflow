// Express server wrap Playwright. UI đầy đủ ở public/index.html, người dùng cấu hình qua /api/config.

import express from 'express';
import morgan from 'morgan';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'node:fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, './public');
const CONFIG_PATH = path.resolve(__dirname, './config.json');

// ─── Config layer (UI-driven, ENV override) ───
const CONFIG_DEFAULTS = {
  profileDir: './profile',           // user data dir cho Chromium (cookies/login)
  outputDir: './output',             // nơi lưu ảnh gen + state.json
  framesPath: './frames.json',       // file storyboard
  projectId: '',                     // Flow project ID (paste từ wizard)
  workers: 1,                        // số tab parallel
  headless: false,                   // false để qua bot detection
  port: 3737,
  cooldownMin: 20,
  cooldownMax: 50,
  typeDelayMs: 80,
  configured: false,
};
const loadConfig = () => {
  try { return { ...CONFIG_DEFAULTS, ...JSON.parse(fsSync.readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch { return { ...CONFIG_DEFAULTS }; }
};
const saveConfig = (cfg) => fsSync.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
let appConfig = loadConfig();

const num = (v, d) => { const n = parseInt(v); return Number.isFinite(n) ? n : d; };
const resolveDir = (p) => path.isAbsolute(p) ? p : path.resolve(__dirname, p);

const USER_DATA_DIR = resolveDir(process.env.PROFILE_DIR || appConfig.profileDir);
const OUTPUT_DIR = resolveDir(process.env.OUTPUT_DIR || appConfig.outputDir);
const FRAMES_PATH = resolveDir(process.env.FRAMES_PATH || appConfig.framesPath);
let PROJECT_ID = process.env.FLOW_PROJECT_ID || appConfig.projectId || '';
let PROJECT_URL = PROJECT_ID
  ? `https://labs.google/fx/tools/flow/project/${PROJECT_ID}`
  : 'https://labs.google/fx/tools/flow';
const HEADLESS = (process.env.HEADLESS === 'true') || appConfig.headless;
const PORT = num(process.env.PORT, appConfig.port);
const TYPE_DELAY_MS = num(process.env.TYPE_DELAY_MS, appConfig.typeDelayMs);
const COOLDOWN_AFTER_GEN_MIN = num(process.env.COOLDOWN_MIN, appConfig.cooldownMin);
const COOLDOWN_AFTER_GEN_MAX = num(process.env.COOLDOWN_MAX, appConfig.cooldownMax);
const WORKER_COUNT = num(process.env.WORKERS, appConfig.workers); // số tab parallel (cùng browser context)
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const humanPause = (min = 800, max = 2400) => sleep(rand(min, max));
let lastGenAt = 0;

let ctx;
const pagePool = []; // [{ page, busy, id, settingsVerified }]
const acquireWorker = async () => {
  // wait for free worker
  while (true) {
    const w = pagePool.find(w => !w.busy);
    if (w) { w.busy = true; return w; }
    await sleep(500);
  }
};
const releaseWorker = (w) => { if (w) w.busy = false; };

const ts = () => new Date().toISOString().replace(/[:.]/g, '-');

// ────────────────────────────────────────────────────────────
// LOG BUFFER + SSE BROADCAST
// ────────────────────────────────────────────────────────────
const LOG_MAX = 800;
const logBuffer = [];
const sseClients = new Set();
const stripColors = (s) => String(s).replace(/\[\d+(;\d+)*m/g, '');
const broadcast = (msg) => {
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  for (const c of sseClients) { try { c.write(payload); } catch {} }
};
const pushLog = (level, text) => {
  const entry = { ts: Date.now(), level, text: stripColors(text) };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  broadcast({ type: 'log', entry });
};
const fmtArgs = (args) => args.map(x => typeof x === 'string' ? x : (x instanceof Error ? x.stack || x.message : JSON.stringify(x))).join(' ');
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
const _origWarn = console.warn.bind(console);
console.log = (...a) => { pushLog('info', fmtArgs(a)); _origLog(...a); };
console.error = (...a) => { pushLog('error', fmtArgs(a)); _origErr(...a); };
console.warn = (...a) => { pushLog('warn', fmtArgs(a)); _origWarn(...a); };

// ────────────────────────────────────────────────────────────
// JOB STATE (multi-worker pipeline runner)
// ────────────────────────────────────────────────────────────
// jobs Map: frame_id → { workerId, status, frameIdx, frameId, total, attempts, lastError, lastVariants, startedAt, mode }
// status: running | waiting_pick | failed | done
// mode: 'serial' | 'batch'  — serial = HITL pause; batch = parallel, no auto-advance
const jobs = new Map();
const queue = []; // pending [{ frameIdx, frame_id, mode }]
let jobAbort = false;
let dispatching = false;

// Backward-compat single-job view (most-recent active or failed/done)
const computePrimaryJob = () => {
  if (jobs.size === 0) return { status: 'idle', frameIdx: -1, frameId: null, total: 0, attempts: 0, lastError: null, lastVariants: null, startedAt: null };
  // Prefer waiting_pick → running → failed → done
  const order = ['waiting_pick', 'running', 'failed', 'done'];
  for (const s of order) {
    for (const j of jobs.values()) if (j.status === s) return j;
  }
  return [...jobs.values()][0];
};

const broadcastJob = () => {
  const list = [...jobs.values()];
  broadcast({ type: 'jobs', jobs: list, queue: queue.length, primary: computePrimaryJob() });
  // legacy single-job event for older clients
  broadcast({ type: 'job', job: computePrimaryJob() });
};

const loadFrames = async () => {
  const raw = await fs.readFile(FRAMES_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  // Merge custom frames vào sau builtin frames
  const custom = await loadCustomFrames();
  cfg.frames = [...cfg.frames, ...custom];
  return cfg;
};
const loadState = async () => {
  try { return JSON.parse(await fs.readFile(path.join(OUTPUT_DIR, 'state.json'), 'utf8')); }
  catch { return { picked: {} }; }
};
const saveState = async (s) => {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUTPUT_DIR, 'state.json'), JSON.stringify(s, null, 2));
};

// ─── Overrides (prompt edits) ───
const OVERRIDES_PATH = path.join(OUTPUT_DIR, '_overrides.json');
const loadOverrides = async () => {
  try { return JSON.parse(await fs.readFile(OVERRIDES_PATH, 'utf8')); }
  catch { return {}; }
};
const saveOverrides = async (o) => {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(OVERRIDES_PATH, JSON.stringify(o, null, 2));
};

// ─── Custom frames (user added) ───
const CUSTOM_FRAMES_PATH = path.join(OUTPUT_DIR, '_custom_frames.json');
const loadCustomFrames = async () => {
  try { return JSON.parse(await fs.readFile(CUSTOM_FRAMES_PATH, 'utf8')); }
  catch { return []; }
};
const saveCustomFrames = async (arr) => {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(CUSTOM_FRAMES_PATH, JSON.stringify(arr, null, 2));
};

// ─── Archive prior attempt trước khi gen mới (preserve data) ───
const archiveFrameIfExists = async (frame_id) => {
  const dir = path.join(OUTPUT_DIR, frame_id);
  const metaPath = path.join(dir, 'meta.json');
  const existing = await fs.readFile(metaPath, 'utf8').then(JSON.parse).catch(() => null);
  if (!existing) return null;
  const archiveId = (existing.generatedAt || new Date().toISOString()).replace(/[:.]/g, '-');
  const archiveDir = path.join(dir, 'attempts', archiveId);
  await fs.mkdir(archiveDir, { recursive: true });
  const files = await fs.readdir(dir).catch(() => []);
  for (const file of files) {
    if (/^v\d+\.png$/.test(file) || file === 'meta.json') {
      await fs.rename(path.join(dir, file), path.join(archiveDir, file)).catch(() => {});
    }
  }
  console.log(`[archive] ${frame_id} → attempts/${archiveId}`);
  return archiveId;
};

const debugShot = async (label, page = null) => {
  try {
    const dir = path.join(OUTPUT_DIR, '_debug');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${ts()}_${label}.png`);
    const targetPage = page || pagePool[0]?.page;
    if (!targetPage) return null;
    await targetPage.screenshot({ path: file, fullPage: false });
    console.log(`  [debug-shot] ${file}`);
    return file;
  } catch (e) {
    console.warn('  [debug-shot] failed:', e.message);
  }
};

const initBrowser = async () => {
  const absProfile = path.resolve(USER_DATA_DIR);
  console.log(`[init] launching browser (workers=${WORKER_COUNT}), profile=`, absProfile);
  ctx = await chromium.launchPersistentContext(absProfile, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  for (let i = 0; i < WORKER_COUNT; i++) {
    let p;
    if (i === 0) p = ctx.pages()[0] || await ctx.newPage();
    else p = await ctx.newPage();
    console.log(`[init W${i + 1}] navigate to project URL`);
    await p.goto(PROJECT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForTimeout(4000);
    const url = p.url();
    if (url.includes('accounts.google.com') || url.includes('signin')) {
      console.error(`[init W${i + 1}] ❌ Browser bị redirect về login. Cookie expired?`);
    }
    pagePool.push({ page: p, busy: false, id: `W${i + 1}`, settingsVerified: false });
    console.log(`[init W${i + 1}] ✓ ready at ${url}`);
  }
  console.log(`[init] ✓ ${pagePool.length} worker(s) ready`);
};

// x4 trigger 4 request batchGenerateImages liên tiếp. Track 2 counter:
//   - responseTotal: ALL responses (kể cả 403 rate-limit) → biết Flow đã trả đủ
//   - responseSuccess: response 200 có valid media → tích lũy ảnh
// Resolve khi responseTotal >= requestCount (sau grace 3s), hoặc idle, hoặc timeout.
const captureGenBatch = (page, timeoutMs = 300_000, idleMs = 180_000) => {
  return new Promise((resolve, reject) => {
    const allMedia = [];
    let requestCount = 0;
    let responseTotal = 0;
    let responseSuccess = 0;
    let lastReqAt = 0;
    let idleTimer;
    let graceTimer;

    const finish = (reason) => {
      clearTimeout(timeoutTimer);
      clearTimeout(idleTimer);
      clearTimeout(graceTimer);
      page.off('request', reqHandler);
      page.off('response', respHandler);
      const summary = `req=${requestCount} resp=${responseTotal} success=${responseSuccess} media=${allMedia.length}`;
      if (allMedia.length > 0) {
        console.log(`    [capture] resolve "${reason}" — ${summary}`);
        resolve(allMedia);
      } else {
        reject(new Error(`No valid media within ${reason}. ${summary}`));
      }
    };

    const timeoutTimer = setTimeout(() => finish('timeout'), timeoutMs);

    const reqHandler = (req) => {
      const url = req.url();
      if (url.includes('flowMedia:batchGenerateImages') && req.method() === 'POST') {
        requestCount++;
        lastReqAt = Date.now();
        console.log(`    [capture] req #${requestCount} detected`);
      }
    };

    const checkAllResponded = () => {
      // Resolve khi đã nhận đủ response cho mọi request (kể cả 403)
      if (requestCount > 0 && responseTotal >= requestCount && Date.now() - lastReqAt > 3000) {
        clearTimeout(graceTimer);
        // Grace 5s để bắt response retry tự động (nếu có)
        graceTimer = setTimeout(() => finish(`all ${requestCount} responses received`), 5000);
        return true;
      }
      return false;
    };

    let rateLimit403Count = 0;
    const respHandler = async (response) => {
      const url = response.url();
      if (!url.includes('flowMedia:batchGenerateImages')) return;
      const status = response.status();
      responseTotal++;
      if (status === 403 || status === 429) rateLimit403Count++;
      let mediaCount = 0;
      let validMedia = [];
      try {
        const body = await response.json();
        if (body?.media?.length) {
          mediaCount = body.media.length;
          // Filter ra chỉ valid media (có fifeUrl, không bị FAILED status)
          validMedia = body.media.filter(m =>
            m.image?.generatedImage?.fifeUrl &&
            m.mediaMetadata?.mediaStatus?.mediaGenerationStatus !== 'MEDIA_GENERATION_STATUS_FAILED'
          );
          if (validMedia.length > 0) {
            allMedia.push(...validMedia);
            responseSuccess++;
          }
        }
      } catch (e) {}
      console.log(`    [capture] resp #${responseTotal}/${requestCount || '?'} status=${status} media=${mediaCount} valid=${validMedia.length} total=${allMedia.length}`);

      // Hard rate-limit detect: tất cả response 403/429 và đã nhận đủ → fail nhanh, không chờ idle 180s
      if (requestCount > 0 && responseTotal >= requestCount && rateLimit403Count === responseTotal && responseSuccess === 0) {
        clearTimeout(graceTimer);
        graceTimer = setTimeout(() => {
          clearTimeout(timeoutTimer);
          clearTimeout(idleTimer);
          page.off('request', reqHandler);
          page.off('response', respHandler);
          console.log(`    [capture] ✗ rate-limit detected — ${rateLimit403Count}/${responseTotal} responses 403`);
          reject(new Error(`Rate limited by Flow API (HTTP 403 on all ${responseTotal}/${requestCount} requests). Account/IP đang bị Google chặn — đợi vài giờ hoặc đổi IP/account.`));
        }, 1500);
        return;
      }

      // Match-count check (early resolve)
      if (checkAllResponded()) return;

      // Fallback: reset idle timer
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish('idle'), idleMs);
    };

    page.on('request', reqHandler);
    page.on('response', respHandler);
  });
};

// Click + button → mở Reference Picker → click "Upload image" → upload local file
// → đợi chip ref hiện trong prompt bar. Bypass library search by mediaId vì thumbnail
// URL không chứa mediaId raw → không match được.
const setReference = async (page, filePath) => {
  if (!filePath) return;
  const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
  if (!fileExists) throw new Error(`Reference file not found: ${filePath}`);
  console.log(`  [ref] uploading ${path.basename(filePath)} (${path.dirname(filePath).split('/').pop()})`);

  // Đếm chip ref hiện tại trong prompt bar (để detect "có chip mới" sau upload)
  const beforeCount = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')];
    return imgs.filter(img => {
      const r = img.getBoundingClientRect();
      return r.y > 500 && r.x < 600 && r.width > 20 && r.width < 100 && img.naturalWidth > 0;
    }).length;
  });

  // Click + button (text 'add_2Create' trong UI)
  const addBtn = page.locator('button').filter({ hasText: /^add_2\s*Create$/ }).first();
  await addBtn.click({ timeout: 8000 });
  await humanPause(500, 1000);

  // Đợi dialog picker mở
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });

  // Tìm "Upload image" link/button trong dialog → click sẽ trigger file chooser
  const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 8000 });
  const uploadTrigger = page.locator('[role="dialog"]').getByText(/upload\s+image/i).first();
  await uploadTrigger.click({ timeout: 5000 }).catch(async (e) => {
    await debugShot('ref_upload_btn_missing');
    throw new Error(`Không tìm được "Upload image" button: ${e.message}`);
  });

  const fileChooser = await fileChooserPromise.catch(async (e) => {
    await debugShot('ref_filechooser_timeout');
    throw new Error(`File chooser không xuất hiện sau click Upload: ${e.message}`);
  });
  await fileChooser.setFiles(filePath);
  console.log('  [ref] file submitted, đợi chip ref hiện trong prompt bar...');

  // ⚠️ ĐỢI chip ref hiện trong prompt bar — quy tắc Flow chỉ "hiểu" khi chip có mặt
  const ok = await page.waitForFunction((before) => {
    const imgs = [...document.querySelectorAll('img')];
    const chips = imgs.filter(img => {
      const r = img.getBoundingClientRect();
      return r.y > 500 && r.x < 600 && r.width > 20 && r.width < 100 && img.naturalWidth > 0 && img.complete;
    });
    return chips.length > before;
  }, beforeCount, { timeout: 25000 }).catch(() => null);

  if (!ok) {
    await debugShot('ref_chip_not_appearing');
    throw new Error('Chip ref không hiện trong prompt bar sau 25s upload');
  }
  console.log('  [ref] ✓ chip ref đã hiện');
  await humanPause(600, 1200);
};

// Click button settings popup → verify x4 + 9:16 active → click nếu chưa, đóng popup
const ensureSettings = async (worker, { ratio = '9:16', count = 'x4' } = {}) => {
  if (worker.settingsVerified) return;
  const page = worker.page;
  console.log(`  [${worker.id} setup] verify settings (${ratio} + ${count})`);
  const settingsBtn = page.locator('button').filter({ hasText: /Nano Banana|Imagen/ }).first();
  await settingsBtn.click({ timeout: 5000 });
  await humanPause(600, 1200);

  // Check + click ratio nếu chưa active
  const ratioMap = { '16:9': 'crop_16_9', '4:3': 'crop_landscape', '1:1': 'crop_square', '3:4': 'crop_portrait', '9:16': 'crop_9_16' };
  const ratioIcon = ratioMap[ratio] || 'crop_9_16';
  const ratioCheck = await page.evaluate((iconText) => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes(iconText));
    return btn ? { found: true, active: btn.getAttribute('data-state') === 'active' } : { found: false };
  }, ratioIcon);
  if (ratioCheck.found && !ratioCheck.active) {
    console.log(`  [setup] click ratio ${ratio}`);
    await page.locator(`button:has-text("${ratioIcon}")`).first().click({ timeout: 5000 });
    await humanPause(400, 800);
  } else if (ratioCheck.active) {
    console.log(`  [setup] ✓ ratio ${ratio} đã active`);
  }

  // Check + click count
  const countCheck = await page.evaluate((target) => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === target);
    return btn ? { found: true, active: btn.getAttribute('data-state') === 'active' } : { found: false };
  }, count);
  if (countCheck.found && !countCheck.active) {
    console.log(`  [setup] click count ${count}`);
    await page.locator(`button`).filter({ hasText: new RegExp(`^${count}$`) }).first().click({ timeout: 5000 });
    await humanPause(400, 800);
  } else if (countCheck.active) {
    console.log(`  [setup] ✓ count ${count} đã active`);
  }

  await page.keyboard.press('Escape');
  await humanPause(400, 800);
  worker.settingsVerified = true;
};

const ensureProjectRoot = async (page) => {
  const url = page.url();
  if (!url.includes(`/project/${PROJECT_ID}`) || url.includes('/edit/')) {
    console.log('  [nav] back to project root');
    await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  }
};

// Submit button luôn ở dưới cùng prompt bar, accessible name = "arrow_forward Create"
const findCreateButton = async (page) => {
  const btn = page.getByRole('button', { name: 'arrow_forward Create' }).last();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  return btn;
};

// Prompt textbox = textbox NGAY TRƯỚC submit button trong DOM order.
// Dùng XPath `preceding::*[@role="textbox"][1]` lấy textbox cuối nằm trước button.
const findPromptTextbox = async (page) => {
  const submitBtn = await findCreateButton(page);
  const tb = submitBtn.locator('xpath=preceding::*[@role="textbox"][1]');
  await tb.waitFor({ state: 'visible', timeout: 10000 });
  return tb;
};

// Single attempt — không retry. Throw nếu Google flag hoặc lỗi UI.
const genFrameOnce = async ({ worker, prompt, referenceFiles = [] }) => {
  const page = worker.page;
  const wid = worker.id;
  // ─── Anti-detection: cooldown giữa 2 lần gen (global cho mọi worker — share rate limit)
  const elapsed = (Date.now() - lastGenAt) / 1000;
  if (lastGenAt > 0 && elapsed < COOLDOWN_AFTER_GEN_MIN) {
    const wait = rand(COOLDOWN_AFTER_GEN_MIN - elapsed, COOLDOWN_AFTER_GEN_MAX - elapsed);
    console.log(`  [${wid} cooldown] sleep ${wait.toFixed(1)}s before next gen`);
    await sleep(wait * 1000);
  }

  await ensureProjectRoot(page);
  await humanPause(1500, 3500); // wait page settle, mô phỏng user nhìn xung quanh

  await ensureSettings(worker, { ratio: '9:16', count: 'x4' });

  // ⚠️ QUY TẮC: paste ảnh REF TRƯỚC, đợi chip ref hiện, RỒI mới type prompt + submit.
  // Đảo ngược sẽ làm Flow không "hiểu" reference.
  for (const refFile of referenceFiles) {
    await setReference(page, refFile);
  }

  console.log(`  [${wid} step 1/4] find prompt textbox`);
  const textbox = await findPromptTextbox(page);

  // Mouse: di chuột tới textbox tự nhiên trước khi click
  const tbBox = await textbox.boundingBox();
  if (tbBox) {
    await page.mouse.move(tbBox.x + tbBox.width / 2, tbBox.y + tbBox.height / 2, { steps: 10 });
    await humanPause(200, 600);
  }

  console.log(`  [${wid} step 2/4] insertText prompt (${prompt.length} chars, atomic)`);
  await textbox.click({ timeout: 10000 });
  await humanPause(400, 900);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a').catch(() => {});
  await sleep(rand(150, 350));
  await page.keyboard.press('Delete').catch(() => {});
  await sleep(rand(300, 700));
  // Dùng insertText (CDP atomic) thay cho keyboard.type — tránh trigger Enter giữa chừng vì \n\n
  await page.keyboard.insertText(prompt);
  await humanPause(1200, 2400);

  let typed = await textbox.textContent().catch(() => '');
  console.log(`  [${wid} verify] textbox content (first 80): "${typed.slice(0, 80)}..."  len=${typed.length}/${prompt.length}`);
  if (!typed.includes(prompt.slice(0, 30))) {
    console.warn(`  [${wid} verify] insertText không đủ — fallback type slowly với prompt joined bằng space`);
    await debugShot('inserttext_failed', page);
    // Fallback: clear, type với prompt đã thay \n\n bằng " | " (separator không gây trigger)
    const safePrompt = prompt.replace(/\n\n/g, ' | ').replace(/\n/g, ' ');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a').catch(() => {});
    await sleep(rand(150, 350));
    await page.keyboard.press('Delete').catch(() => {});
    await sleep(rand(300, 700));
    await page.keyboard.insertText(safePrompt);
    await humanPause(1200, 2400);
    typed = await textbox.textContent().catch(() => '');
    console.log(`  [${wid} verify-2] after safe fallback: "${typed.slice(0, 80)}..."  len=${typed.length}`);
    if (!typed.includes(safePrompt.slice(0, 30))) {
      await debugShot('typing_failed_final', page);
      throw new Error(`Prompt didn't reach textbox after fallback. Got: "${typed.slice(0, 100)}"`);
    }
  }

  console.log(`  [${wid} step 3/4] hover + click Create + wait response`);
  const reqLog = [];
  const respLog = [];
  const reqLogger = (req) => {
    if (req.url().includes('aisandbox-pa') && req.method() === 'POST') {
      const u = req.url().split('googleapis.com')[1] || req.url();
      reqLog.push(u);
      console.log(`    [req] POST ${u}`);
    }
  };
  const submitTime = Date.now();
  const respLogger = async (resp) => {
    if (resp.url().includes('flowMedia:batchGenerateImages')) {
      const status = resp.status();
      let body = null;
      try { body = await resp.json(); } catch (e) {}
      const mediaCount = body?.media?.length ?? 0;
      const failed = body?.media?.filter(m => m.mediaMetadata?.mediaStatus?.mediaGenerationStatus === 'MEDIA_GENERATION_STATUS_FAILED' || (m.image?.generatedImage && !m.image.generatedImage.fifeUrl)).length ?? 0;
      respLog.push({ status, mediaCount, failed });
      const tElapsed = ((Date.now() - submitTime) / 1000).toFixed(1);
      console.log(`    [resp +${tElapsed}s] ${status}  media=${mediaCount}  failed=${failed}`);
    }
  };
  page.on('request', reqLogger);
  page.on('response', respLogger);

  const capturePromise = captureGenBatch(page, 300_000, 180_000);
  const createBtn = await findCreateButton(page);
  const btnBox = await createBtn.boundingBox();
  if (btnBox) {
    await page.mouse.move(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2, { steps: 12 });
    await humanPause(300, 800);
  }

  await createBtn.click({ timeout: 10000 });
  console.log(`    [click] submitted at ${new Date().toISOString()}`);

  let media;
  try {
    media = await capturePromise;
  } catch (e) {
    await debugShot('capture_timeout', page);
    throw new Error(`${e.message}. Requests: ${JSON.stringify(reqLog)}. Responses: ${JSON.stringify(respLog)}`);
  } finally {
    page.off('request', reqLogger);
    page.off('response', respLogger);
    lastGenAt = Date.now();
  }

  // Detect failed generation (Google flagged)
  const failedItems = media.filter(m => m.mediaMetadata?.mediaStatus?.mediaGenerationStatus === 'MEDIA_GENERATION_STATUS_FAILED');
  if (failedItems.length > 0) {
    await debugShot('google_flagged', page);
    throw new Error(`Google flagged ${failedItems.length}/${media.length} variants. Cooldown 24-48h hoặc pivot Vertex API.`);
  }
  console.log(`  [${wid} step 4/4] got ${media.length} media`);

  return media
    .filter(m => m.image?.generatedImage)
    .map(m => ({
      mediaId: m.name,
      mediaGenerationId: m.image.generatedImage.mediaGenerationId,
      fifeUrl: m.image.generatedImage.fifeUrl,
      seed: m.image.generatedImage.seed,
      workflowId: m.workflowId,
      aspectRatio: m.image.generatedImage.aspectRatio,
      prompt: m.image.generatedImage.prompt,
    }));
};

// Wrapper: gọi genFrameOnce, nếu Google flag → wait random 60-180s → retry, max N lần
const genFrame = async ({ worker, prompt, referenceFiles = [], maxRetries = 3 }) => {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await genFrameOnce({ worker, prompt, referenceFiles });
      if (attempt > 1) console.log(`  [${worker.id}] ✓ Retry attempt ${attempt} thành công`);
      return { variants: result, attempts: attempt };
    } catch (e) {
      lastErr = e;
      const isFlag = /flagged|FAILED|unusual activity/i.test(e.message);
      if (!isFlag) throw e; // lỗi khác → throw ngay
      if (attempt === maxRetries) {
        console.error(`  [${worker.id}] ✗ Retry hết ${maxRetries} lần, vẫn flag`);
        throw new Error(`Failed after ${maxRetries} retries: ${e.message}`);
      }
      const waitS = 60 + Math.random() * 120;
      console.log(`  [${worker.id}] ⚠️ Attempt ${attempt}/${maxRetries} flag, đợi ${waitS.toFixed(0)}s rồi retry...`);
      await sleep(waitS * 1000);
    }
  }
  throw lastErr;
};

const downloadImage = async (url, filepath) => {
  // Mở URL ảnh trong tab mới → goto trả response trực tiếp, không CORS-check
  const dlPage = await ctx.newPage();
  try {
    const resp = await dlPage.goto(url, { timeout: 30000, waitUntil: 'load' });
    if (!resp || !resp.ok()) {
      throw new Error(`Download status=${resp?.status() ?? '?'}`);
    }
    const buf = await resp.body();
    await fs.mkdir(path.dirname(filepath), { recursive: true });
    await fs.writeFile(filepath, buf);
    return filepath;
  } finally {
    await dlPage.close();
  }
};

// ────────────────────────────────────────────────────────────
// JOB RUNNER (multi-worker, supports serial HITL + batch parallel)
// ────────────────────────────────────────────────────────────
const runOneFrame = async (cfg, frameIdx, worker, mode = 'serial') => {
  const f = cfg.frames[frameIdx];

  const overrides = await loadOverrides();
  const ov = overrides[f.frame_id] || {};
  const effectiveAction = ov.action || f.action;
  const effectiveExtraRefs = Array.isArray(ov.extra_references)
    ? ov.extra_references
    : (Array.isArray(f.extra_references) ? f.extra_references : []);
  const fullPrompt = `${cfg.blocks.setting}\n\n${cfg.blocks.style}\n\n${effectiveAction}`;

  const state = await loadState();
  const refs = [];
  const resolvePickedPath = (frameId) => {
    const picked = state.picked?.[frameId];
    if (!picked) return null;
    return picked.filePath
      ? (path.isAbsolute(picked.filePath) ? picked.filePath : path.join(OUTPUT_DIR, picked.filePath))
      : path.join(OUTPUT_DIR, frameId, `v${(picked.pickedIdx ?? 0) + 1}.png`);
  };
  if (f.default_reference) {
    const p = resolvePickedPath(f.default_reference);
    if (p) refs.push(p);
    else console.warn(`[refs] ${f.frame_id}: default_reference ${f.default_reference} chưa được pick — skip`);
  }
  for (const fid of effectiveExtraRefs) {
    if (fid === f.default_reference) continue; // dedupe
    const p = resolvePickedPath(fid);
    if (p) refs.push(p);
    else console.warn(`[refs] ${f.frame_id}: extra_reference ${fid} chưa được pick — skip`);
  }
  if (Array.isArray(f.reference_files)) {
    for (const rf of f.reference_files) {
      refs.push(path.isAbsolute(rf) ? rf : path.join(OUTPUT_DIR, rf));
    }
  }

  await archiveFrameIfExists(f.frame_id);

  const j = {
    workerId: worker.id,
    status: 'running',
    frameId: f.frame_id,
    frameIdx,
    total: cfg.frames.length,
    attempts: 0,
    lastError: null,
    lastVariants: null,
    startedAt: new Date().toISOString(),
    mode,
  };
  jobs.set(f.frame_id, j);
  broadcastJob();

  console.log(`\n[job ${worker.id}] ▶ ${f.frame_id} (${frameIdx + 1}/${cfg.frames.length}) — ${f.topic}  mode=${mode}`);
  console.log(`[job ${worker.id}]   refs=${refs.length} ${refs.map(r => path.basename(path.dirname(r)) + '/' + path.basename(r)).join(', ')}  prompt-len=${fullPrompt.length}`);

  try {
    const { variants, attempts } = await genFrame({ worker, prompt: fullPrompt, referenceFiles: refs, maxRetries: 3 });
    if (jobAbort) {
      j.status = 'failed';
      j.lastError = 'aborted';
      jobs.set(f.frame_id, j);
      broadcastJob();
      return;
    }

    const downloaded = [];
    for (let i = 0; i < variants.length; i++) {
      const local = path.join(OUTPUT_DIR, f.frame_id, `v${i + 1}.png`);
      await downloadImage(variants[i].fifeUrl, local);
      downloaded.push({ ...variants[i], localPath: local });
    }

    const metaPath = path.join(OUTPUT_DIR, f.frame_id, 'meta.json');
    await fs.writeFile(metaPath, JSON.stringify({
      frame_id: f.frame_id, prompt: fullPrompt, reference_files: refs,
      attempts, generatedAt: new Date().toISOString(), variants: downloaded
    }, null, 2));

    j.status = 'waiting_pick';
    j.attempts = attempts;
    j.lastVariants = downloaded;
    jobs.set(f.frame_id, j);
    broadcastJob();
    console.log(`[job ${worker.id}] ⏸ ${f.frame_id} done (${attempts} attempts) — chờ pick variant`);
  } catch (e) {
    j.status = 'failed';
    j.lastError = e.message;
    jobs.set(f.frame_id, j);
    broadcastJob();
    console.error(`[job ${worker.id}] ✗ ${f.frame_id} failed: ${e.message}`);
  }
};

// Dispatcher: lấy frame từ queue, acquire worker, chạy. Trả về khi queue empty.
const runDispatcher = async () => {
  if (dispatching) return;
  dispatching = true;
  try {
    const cfg = await loadFrames();
    while (queue.length > 0 && !jobAbort) {
      const item = queue.shift();
      const f = cfg.frames[item.frameIdx];
      if (!f || f.frame_id !== item.frame_id) continue; // stale
      const worker = await acquireWorker();
      // Chạy frame async, không block dispatcher khi batch mode parallel
      const runP = (async () => {
        try {
          await runOneFrame(cfg, item.frameIdx, worker, item.mode);
        } catch (e) {
          console.error(`[dispatcher] runOneFrame ${item.frame_id} threw:`, e.message);
        } finally {
          releaseWorker(worker);
        }
      })();
      // Serial mode: đợi xong rồi mới dispatch frame tiếp (HITL pause sẽ wait pick)
      if (item.mode === 'serial') {
        await runP;
        // Serial: dừng sau 1 frame, đợi pick xong queue tiếp.
        break;
      } else {
        // Batch: 1s grace để tránh spam parallel browser settings
        await sleep(1000);
      }
    }
  } finally {
    dispatching = false;
  }
};

// Sau khi anh pick (serial mode), advance to next frame
const advanceJob = async (lastFrameIdx, mode = 'serial') => {
  if (jobAbort || mode === 'batch') return;
  const cfg = await loadFrames();
  const nextIdx = lastFrameIdx + 1;
  if (nextIdx >= cfg.frames.length) {
    console.log('[job] ✓ all frames done');
    return;
  }
  queue.push({ frameIdx: nextIdx, frame_id: cfg.frames[nextIdx].frame_id, mode });
  runDispatcher();
};

const app = express();
app.use(express.json({ limit: '50mb' }));
// Skip noisy paths (state polling + log SSE + static output) khỏi morgan log
// → giảm spam SSE → giảm DOM thrash trên UI
app.use(morgan('tiny', {
  skip: (req) => /^\/(api\/(state|logs)|output|public|favicon)/.test(req.url),
}));
app.use('/output', express.static(OUTPUT_DIR));
app.use(express.static(PUBLIC_DIR));

app.get('/health', async (req, res) => {
  try {
    const w0 = pagePool[0];
    res.json({ ok: true, browserReady: pagePool.length > 0, workers: pagePool.length, url: w0?.page?.url() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/debug-screenshot', async (req, res) => {
  try {
    const file = await debugShot('manual');
    res.json({ ok: true, file });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/gen-frame', async (req, res) => {
  const { frame_id, prompt, reference_files = [], download = true, max_retries = 3 } = req.body || {};
  if (!frame_id || !prompt) {
    return res.status(400).json({ error: 'frame_id và prompt bắt buộc' });
  }
  console.log(`\n[gen-frame] ${frame_id}: "${prompt.slice(0, 80)}..."  refs=${reference_files.length}  maxRetries=${max_retries}`);
  try {
    const { variants: images, attempts } = await genFrame({ prompt, referenceFiles: reference_files, maxRetries: max_retries });
    if (download) {
      for (let i = 0; i < images.length; i++) {
        const local = path.join(OUTPUT_DIR, frame_id, `v${i + 1}.png`);
        await downloadImage(images[i].fifeUrl, local);
        images[i].localPath = local;
      }
    }
    const metaPath = path.join(OUTPUT_DIR, frame_id, 'meta.json');
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      frame_id, prompt, reference_files, attempts, generatedAt: new Date().toISOString(), variants: images
    }, null, 2));
    console.log(`  ✓ ${frame_id} done after ${attempts} attempt(s), ${images.length} variants saved`);
    res.json({ frame_id, count: images.length, attempts, variants: images });
  } catch (e) {
    console.error(`  ✗ ${frame_id} failed:`, e.message);
    await debugShot(`fail_${frame_id}`);
    res.status(500).json({ error: e.message, debug_screenshot: 'output/_debug/' });
  }
});

// ────────────────────────────────────────────────────────────
// /api/* — UI ĐIỀU KHIỂN PIPELINE
// ────────────────────────────────────────────────────────────
app.get('/api/state', async (req, res) => {
  try {
    const cfg = await loadFrames();
    const state = await loadState();
    const overrides = await loadOverrides();
    const customFrames = await loadCustomFrames();
    const jobsList = [...jobs.values()];
    const jobsByFrame = Object.fromEntries(jobsList.map(j => [j.frameId, j]));
    const framesWithStatus = cfg.frames.map(f => {
      const picked = state.picked?.[f.frame_id];
      const override = overrides[f.frame_id];
      let status = 'pending';
      if (jobsByFrame[f.frame_id]) status = jobsByFrame[f.frame_id].status;
      else if (picked) status = 'picked';
      const hasOv = !!(override?.action || (Array.isArray(override?.extra_references) && override.extra_references.length > 0));
      return { ...f, status, picked, override, has_override: hasOv };
    });
    res.json({
      frames: framesWithStatus,
      blocks: cfg.blocks,
      project: cfg.project,
      state,
      job: computePrimaryJob(),  // legacy single-job
      jobs: jobsList,             // multi-job array
      jobs_by_frame: jobsByFrame,
      queue_size: queue.length,
      workers: pagePool.map(w => ({ id: w.id, busy: w.busy, settingsVerified: w.settingsVerified })),
      worker_count: pagePool.length,
      overrides,
      custom_frames: customFrames
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Frame detail: current meta + attempts list ───
app.get('/api/frame/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const dir = path.join(OUTPUT_DIR, id);
    const result = { frame_id: id, current: null, attempts: [] };

    const cur = await fs.readFile(path.join(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (cur) result.current = { ...cur, attempt_id: 'current' };

    const attemptsDir = path.join(dir, 'attempts');
    const aids = await fs.readdir(attemptsDir).catch(() => []);
    for (const aid of aids.sort().reverse()) {
      const meta = await fs.readFile(path.join(attemptsDir, aid, 'meta.json'), 'utf8')
        .then(JSON.parse).catch(() => null);
      if (meta) result.attempts.push({ ...meta, attempt_id: aid });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Re-pick variant (đổi lựa chọn frame đã pick mà KHÔNG re-run) ───
app.post('/api/repick', async (req, res) => {
  try {
    const { frame_id, attempt_id = 'current', variant_idx } = req.body || {};
    if (!frame_id || variant_idx === undefined) return res.status(400).json({ error: 'frame_id và variant_idx bắt buộc' });

    const metaPath = attempt_id === 'current'
      ? path.join(OUTPUT_DIR, frame_id, 'meta.json')
      : path.join(OUTPUT_DIR, frame_id, 'attempts', attempt_id, 'meta.json');
    const meta = await fs.readFile(metaPath, 'utf8').then(JSON.parse).catch(() => null);
    if (!meta) return res.status(404).json({ error: 'frame meta không tìm thấy' });
    if (!meta.variants?.[variant_idx]) return res.status(400).json({ error: 'variant_idx invalid' });

    const filePath = attempt_id === 'current'
      ? path.join(OUTPUT_DIR, frame_id, `v${variant_idx + 1}.png`)
      : path.join(OUTPUT_DIR, frame_id, 'attempts', attempt_id, `v${variant_idx + 1}.png`);

    const state = await loadState();
    state.picked = state.picked || {};
    state.picked[frame_id] = {
      mediaId: meta.variants[variant_idx].mediaId,
      pickedIdx: variant_idx,
      attempt_id,
      pickedAt: new Date().toISOString(),
      fifeUrl: meta.variants[variant_idx].fifeUrl,
      filePath,
    };
    await saveState(state);
    console.log(`[repick] ${frame_id} attempt=${attempt_id} v${variant_idx + 1}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Save / clear frame override (action prompt + extra_references) ───
// Body: { frame_id, action?, extra_references? }
//   - action === ''  → clear action override
//   - action === undefined → don't touch action
//   - extra_references === [] → clear refs override
//   - extra_references === undefined → don't touch refs
app.post('/api/override-prompt', async (req, res) => {
  try {
    const { frame_id, action, extra_references } = req.body || {};
    if (!frame_id) return res.status(400).json({ error: 'frame_id bắt buộc' });
    const overrides = await loadOverrides();
    const cur = { ...(overrides[frame_id] || {}) };

    if (action !== undefined) {
      if (action === '') delete cur.action;
      else cur.action = action;
    }
    if (extra_references !== undefined) {
      if (!Array.isArray(extra_references) || extra_references.length === 0) delete cur.extra_references;
      else cur.extra_references = [...new Set(extra_references.filter(x => typeof x === 'string' && x.trim()))];
    }

    const hasContent = cur.action != null
      || (Array.isArray(cur.extra_references) && cur.extra_references.length > 0);

    if (hasContent) {
      cur.updatedAt = new Date().toISOString();
      overrides[frame_id] = cur;
      console.log(`[override] ${frame_id} updated — action=${cur.action ? cur.action.length + 'ch' : '-'}  extra_refs=${(cur.extra_references || []).join(',') || '-'}`);
    } else {
      delete overrides[frame_id];
      console.log(`[override] cleared ${frame_id}`);
    }
    await saveOverrides(overrides);
    res.json({ ok: true, overrides });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Add custom frame ───
app.post('/api/add-frame', async (req, res) => {
  try {
    const { frame_id, topic, action, default_reference, reference_files = [], extra_references = [] } = req.body || {};
    if (!frame_id || !action) return res.status(400).json({ error: 'frame_id và action bắt buộc' });
    // Conflict với builtin frames hoặc existing custom?
    const cfg = await loadFrames();
    if (cfg.frames.some(f => f.frame_id === frame_id)) return res.status(409).json({ error: `frame_id "${frame_id}" đã tồn tại` });
    const custom = await loadCustomFrames();
    const cleanExtraRefs = Array.isArray(extra_references)
      ? [...new Set(extra_references.filter(x => typeof x === 'string' && x.trim() && x !== default_reference))]
      : [];
    custom.push({
      frame_id,
      tag: `[${frame_id}-CUSTOM]`,
      topic: topic || frame_id,
      default_reference: default_reference || null,
      extra_references: cleanExtraRefs,
      selectable_references: [default_reference, ...cleanExtraRefs].filter(Boolean),
      extra_anchor: null,
      action,
      reference_files,
      custom: true,
      createdAt: new Date().toISOString(),
    });
    await saveCustomFrames(custom);
    console.log(`[custom] + ${frame_id}: ${topic || ''}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Delete custom frame ───
app.delete('/api/custom-frame/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const custom = await loadCustomFrames();
    const filtered = custom.filter(f => f.frame_id !== id);
    if (filtered.length === custom.length) return res.status(404).json({ error: 'custom frame không tồn tại' });
    await saveCustomFrames(filtered);
    console.log(`[custom] - ${id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/logs', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`: connected\n\n`);
  for (const e of logBuffer.slice(-300)) res.write(`data: ${JSON.stringify({ type: 'log', entry: e })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'jobs', jobs: [...jobs.values()], queue: queue.length, primary: computePrimaryJob() })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'job', job: computePrimaryJob() })}\n\n`);
  sseClients.add(res);
  const heartbeat = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 15000);
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
});

app.post('/api/start', async (req, res) => {
  jobAbort = false;
  const cfg = await loadFrames();
  const primary = computePrimaryJob();
  const fromIdx = req.body?.from_idx ?? (primary.frameIdx >= 0 ? primary.frameIdx + 1 : 0);
  if (fromIdx < 0 || fromIdx >= cfg.frames.length) return res.status(400).json({ error: 'from_idx out of range' });
  if (fromIdx === 0 && req.body?.reset_state !== false) {
    await saveState({ picked: {}, startedAt: new Date().toISOString() });
    jobs.clear();
    console.log('[job] ⌫ reset state vì start từ frame 0');
  }
  console.log(`[job] ▶▶ start from frame index ${fromIdx} (${cfg.frames[fromIdx].frame_id})`);
  // Serial mode: enqueue 1 frame, dispatcher sẽ pause sau xong (HITL pick → advance)
  queue.push({ frameIdx: fromIdx, frame_id: cfg.frames[fromIdx].frame_id, mode: 'serial' });
  res.json({ ok: true, fromIdx, mode: 'serial' });
  runDispatcher().catch(e => console.error('[dispatcher] crash:', e.message));
});

// Batch parallel: enqueue nhiều frames, workers chạy song song, KHÔNG auto-advance
app.post('/api/batch-start', async (req, res) => {
  jobAbort = false;
  const cfg = await loadFrames();
  const { frame_ids } = req.body || {};
  if (!Array.isArray(frame_ids) || frame_ids.length === 0) return res.status(400).json({ error: 'frame_ids[] bắt buộc' });
  const items = [];
  for (const fid of frame_ids) {
    const idx = cfg.frames.findIndex(f => f.frame_id === fid);
    if (idx < 0) return res.status(400).json({ error: `frame_id "${fid}" không tồn tại` });
    items.push({ frameIdx: idx, frame_id: fid, mode: 'batch' });
  }
  for (const it of items) queue.push(it);
  console.log(`[batch] ▶▶ enqueued ${items.length} frames, ${pagePool.length} workers parallel`);
  res.json({ ok: true, count: items.length, workers: pagePool.length });
  runDispatcher().catch(e => console.error('[dispatcher] crash:', e.message));
});

app.post('/api/pick', async (req, res) => {
  const { frame_id, variant_idx } = req.body || {};
  const j = jobs.get(frame_id);
  if (!j) return res.status(404).json({ error: `no active job for ${frame_id}` });
  if (j.status !== 'waiting_pick') return res.status(409).json({ error: `${frame_id} not waiting_pick (status=${j.status})` });
  if (!j.lastVariants?.[variant_idx]) return res.status(400).json({ error: 'invalid variant_idx' });
  const state = await loadState();
  state.picked = state.picked || {};
  state.picked[frame_id] = {
    mediaId: j.lastVariants[variant_idx].mediaId,
    pickedIdx: variant_idx,
    pickedAt: new Date().toISOString(),
    fifeUrl: j.lastVariants[variant_idx].fifeUrl,
  };
  await saveState(state);
  jobs.delete(frame_id);
  broadcastJob();
  console.log(`[job] ✓ ${frame_id} picked v${variant_idx + 1}`);
  res.json({ ok: true });
  if (j.mode === 'serial') {
    (async () => { try { await advanceJob(j.frameIdx, 'serial'); } catch (e) { console.error(e.message); } })();
  }
});

app.post('/api/skip', async (req, res) => {
  // Skip = pick gì cũng được, chỉ advance. Target: frame_id hoặc primary.
  const { frame_id } = req.body || {};
  const target = frame_id || computePrimaryJob().frameId;
  const j = jobs.get(target);
  if (!j) return res.status(404).json({ error: `no active job for ${target}` });
  if (!['waiting_pick', 'failed'].includes(j.status)) return res.status(409).json({ error: `cannot skip in ${j.status}` });
  console.log(`[job] ⏭ skip ${target}`);
  jobs.delete(target);
  broadcastJob();
  res.json({ ok: true });
  if (j.mode === 'serial') {
    (async () => { try { await advanceJob(j.frameIdx, 'serial'); } catch (e) { console.error(e.message); } })();
  }
});

app.post('/api/retry', async (req, res) => {
  const { frame_id } = req.body || {};
  const target = frame_id || computePrimaryJob().frameId;
  const j = jobs.get(target);
  if (!j) return res.status(404).json({ error: `no active job for ${target}` });
  if (!['failed', 'waiting_pick'].includes(j.status)) return res.status(409).json({ error: `cannot retry in ${j.status}` });
  const cfg = await loadFrames();
  const idx = j.frameIdx;
  const mode = j.mode;
  jobs.delete(target);
  console.log(`[job] ↻ retry ${target}`);
  res.json({ ok: true });
  // Re-enqueue
  queue.push({ frameIdx: idx, frame_id: target, mode });
  runDispatcher().catch(e => console.error(e.message));
});

app.post('/api/stop', (req, res) => {
  jobAbort = true;
  queue.length = 0;
  for (const j of jobs.values()) if (j.status === 'running') j.status = 'failed', j.lastError = 'stopped';
  broadcastJob();
  console.log('[job] ■ stop signal sent — queue cleared, abort sau frame đang chạy');
  res.json({ ok: true });
});

app.post('/api/reset', async (req, res) => {
  await saveState({ picked: {}, resetAt: new Date().toISOString() });
  jobs.clear();
  queue.length = 0;
  jobAbort = false;
  broadcastJob();
  console.log('[job] ⌫ reset state.json + job');
  res.json({ ok: true });
});

// ────────────────────────────────────────────────────────────
// SETUP / CONFIG (UI-driven first-run + runtime settings)
// ────────────────────────────────────────────────────────────
app.get('/api/config', async (req, res) => {
  const hasCookies = await checkLoggedIn();
  let hasFrames = false;
  try { await fs.access(FRAMES_PATH); hasFrames = true; } catch {}
  res.json({
    config: appConfig,
    runtime: {
      profileDir: USER_DATA_DIR,
      outputDir: OUTPUT_DIR,
      framesPath: FRAMES_PATH,
      projectId: PROJECT_ID,
      projectUrl: PROJECT_URL,
      port: PORT,
      workers: WORKER_COUNT,
      headless: HEADLESS,
      typeDelayMs: TYPE_DELAY_MS,
      cooldownMin: COOLDOWN_AFTER_GEN_MIN,
      cooldownMax: COOLDOWN_AFTER_GEN_MAX,
      hasCookies,
      hasFrames,
      workersReady: pagePool.length,
    },
    setupComplete: !!PROJECT_ID && hasCookies && hasFrames && pagePool.length > 0,
  });
});

const extractProjectId = (input) => {
  if (!input) return null;
  const trimmed = input.trim();
  // Match URL hoặc raw UUID
  const urlMatch = trimmed.match(/project\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (urlMatch) return urlMatch[1];
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(trimmed)) return trimmed;
  return null;
};

app.put('/api/config', async (req, res) => {
  try {
    const body = req.body || {};
    const updates = {};
    if (body.projectUrl !== undefined || body.projectId !== undefined) {
      const id = extractProjectId(body.projectUrl || body.projectId);
      if (!id) return res.status(400).json({ error: 'Project URL/ID không hợp lệ' });
      updates.projectId = id;
    }
    const numeric = ['workers', 'cooldownMin', 'cooldownMax', 'typeDelayMs', 'port'];
    for (const k of numeric) {
      if (body[k] !== undefined && Number.isFinite(Number(body[k]))) updates[k] = Number(body[k]);
    }
    if (typeof body.headless === 'boolean') updates.headless = body.headless;
    for (const k of ['profileDir', 'outputDir', 'framesPath']) {
      if (typeof body[k] === 'string' && body[k]) updates[k] = body[k];
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid updates' });

    appConfig = { ...appConfig, ...updates, configured: true, savedAt: new Date().toISOString() };
    saveConfig(appConfig);

    let restartRequired = false;
    let reNavigated = false;
    // Apply project change immediately
    if (updates.projectId && updates.projectId !== PROJECT_ID) {
      PROJECT_ID = updates.projectId;
      PROJECT_URL = `https://labs.google/fx/tools/flow/project/${PROJECT_ID}`;
      for (const w of pagePool) {
        try {
          await w.page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
          w.settingsVerified = false;
        } catch (e) { console.error(`[config] re-nav ${w.id} failed:`, e.message); }
      }
      reNavigated = true;
    }
    // Worker count / port / dirs cần restart
    if (
      (updates.workers !== undefined && updates.workers !== WORKER_COUNT) ||
      (updates.port !== undefined && updates.port !== PORT) ||
      updates.profileDir !== undefined ||
      updates.outputDir !== undefined ||
      updates.framesPath !== undefined
    ) {
      restartRequired = true;
    }

    console.log('[config] saved:', JSON.stringify(updates));
    res.json({ ok: true, config: appConfig, restartRequired, reNavigated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Helper: đảm bảo có ít nhất 1 page sống. Nếu ctx hoặc page bị close (user đóng browser tay) → tự tạo lại.
const ensureLivePage = async () => {
  // Nếu ctx đã closed (browser killed) → relaunch
  let ctxAlive = true;
  try {
    if (!ctx || (ctx.pages && !ctx.pages())) ctxAlive = false;
    // Probe ctx by listing pages — if throws, ctx dead
    const pages = ctx?.pages?.() || [];
    if (!Array.isArray(pages)) ctxAlive = false;
  } catch { ctxAlive = false; }

  if (!ctxAlive) {
    console.warn('[recover] ctx died → relaunching persistent context');
    pagePool.length = 0;
    try { await ctx?.close(); } catch {}
    ctx = await chromium.launchPersistentContext(path.resolve(USER_DATA_DIR), {
      headless: HEADLESS,
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const p = ctx.pages()[0] || await ctx.newPage();
    pagePool.push({ page: p, busy: false, id: 'W1', settingsVerified: false });
    console.log('[recover] ctx relaunched, W1 ready');
  }

  // Replace any closed pages in pool
  for (const w of pagePool) {
    if (w.page.isClosed?.()) {
      console.warn(`[recover] ${w.id} page closed → creating new page`);
      w.page = await ctx.newPage();
      w.settingsVerified = false;
    }
  }
  // Nếu pool rỗng → thêm 1 page
  if (pagePool.length === 0) {
    const p = await ctx.newPage();
    pagePool.push({ page: p, busy: false, id: 'W1', settingsVerified: false });
  }
  return pagePool[0];
};

// Mở browser để user login Google manually
app.post('/api/setup/launch-browser', async (req, res) => {
  try {
    const w = await ensureLivePage();
    const url = req.body?.url || PROJECT_URL || 'https://labs.google/fx/tools/flow';
    await w.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await w.page.bringToFront(); } catch {}
    res.json({ ok: true, url, workerId: w.id });
  } catch (e) {
    console.error('[setup/launch-browser] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Helper: detect login bằng ctx.cookies() — đáng tin hơn fs probe (path khác giữa Playwright versions)
const checkLoggedIn = async () => {
  if (!ctx) return false;
  try {
    const cookies = await ctx.cookies(['https://accounts.google.com', 'https://labs.google']);
    // Cần ít nhất 1 cookie từ google domain với SID/session-like name
    return cookies.some(c =>
      /\.?google\.com$/.test(c.domain) &&
      /^(SID|SAPISID|SSID|HSID|APISID|__Secure-)/i.test(c.name)
    );
  } catch (e) {
    console.warn('[checkLoggedIn] failed:', e.message);
    return false;
  }
};

// Setup status (wizard sẽ poll cái này)
app.get('/api/setup/status', async (req, res) => {
  const hasCookies = await checkLoggedIn();
  let hasFrames = false;
  try { await fs.access(FRAMES_PATH); hasFrames = true; } catch {}
  res.json({
    configured: appConfig.configured && !!PROJECT_ID,
    hasProjectId: !!PROJECT_ID,
    hasCookies,
    hasFrames,
    workersReady: pagePool.length,
    setupComplete: !!PROJECT_ID && hasCookies && hasFrames && pagePool.length > 0,
  });
});

// Upload reference image — body { filename, base64 } → save vào output/_uploads/ → trả path
app.post('/api/upload-reference', async (req, res) => {
  try {
    const { filename, base64 } = req.body || {};
    if (!filename || !base64) return res.status(400).json({ error: 'filename + base64 bắt buộc' });
    // Strip data URL prefix nếu có ("data:image/png;base64,...")
    const b64 = base64.replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 0) return res.status(400).json({ error: 'base64 invalid' });
    if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'File quá lớn (>20MB)' });
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const uploadsDir = path.join(OUTPUT_DIR, '_uploads');
    await fs.mkdir(uploadsDir, { recursive: true });
    const filepath = path.join(uploadsDir, `${ts}_${safeName}`);
    await fs.writeFile(filepath, buf);
    console.log(`[upload] saved ${path.basename(filepath)} (${(buf.length / 1024).toFixed(1)} KB)`);
    res.json({ ok: true, path: filepath, size: buf.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trả nội dung frames.example.json để wizard "Dùng template mặc định" pre-fill textarea
app.get('/api/setup/template-frames', async (req, res) => {
  try {
    const tplPath = path.resolve(__dirname, './frames.example.json');
    const content = await fs.readFile(tplPath, 'utf8');
    res.type('application/json').send(content);
  } catch (e) {
    res.status(404).json({ error: 'frames.example.json không tồn tại trong repo' });
  }
});

// Reload template ngay vào frames.json — tiện cho user lúc đầu đã save stub empty
app.post('/api/setup/use-template', async (req, res) => {
  try {
    const tplPath = path.resolve(__dirname, './frames.example.json');
    const content = await fs.readFile(tplPath, 'utf8');
    const parsed = JSON.parse(content);
    if (!parsed.frames || !Array.isArray(parsed.frames)) {
      return res.status(500).json({ error: 'template invalid' });
    }
    await fs.writeFile(FRAMES_PATH, JSON.stringify(parsed, null, 2));
    console.log(`[setup] đã load template (${parsed.frames.length} frames) vào ${FRAMES_PATH}`);
    res.json({ ok: true, framesCount: parsed.frames.length, path: FRAMES_PATH });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload frames.json từ UI (template hoặc paste JSON)
app.post('/api/setup/save-frames', async (req, res) => {
  try {
    const body = req.body || {};
    const data = body.frames || body;
    if (!data || !Array.isArray(data.frames) || !data.blocks) {
      return res.status(400).json({ error: 'frames.json không hợp lệ — cần { project, blocks: {setting, style}, frames: [...] }' });
    }
    await fs.writeFile(FRAMES_PATH, JSON.stringify(data, null, 2));
    console.log(`[setup] saved frames.json (${data.frames.length} frames)`);
    res.json({ ok: true, framesCount: data.frames.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

process.on('SIGTERM', async () => { await ctx?.close(); process.exit(0); });
process.on('SIGINT', async () => { await ctx?.close(); process.exit(0); });

await initBrowser();
app.listen(PORT, () => {
  console.log(`[server] flow-bot on http://localhost:${PORT}  HEADLESS=${HEADLESS}`);
});
