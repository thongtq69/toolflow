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
  profileDir: './profile',                          // user data dir cho Chromium (cookies/login)
  outputDir: './projects/default/output',           // legacy single-project path
  framesPath: './projects/default/frames.json',     // legacy single-project path
  projectId: '',                                    // Flow project ID (paste từ wizard)
  workers: 1,                                       // số tab parallel mỗi project
  headless: false,                                  // false để qua bot detection
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
let lastGenAt = 0; // GLOBAL — Flow rate-limit per-account, scoping per-project would 2x rate at IP level

// ─── Project registry + per-project state ───
const PROJECTS_REGISTRY_PATH = resolveDir('./projects.json');
const projects = new Map(); // slug → project state

const loadProjectsRegistry = () => {
  try { return JSON.parse(fsSync.readFileSync(PROJECTS_REGISTRY_PATH, 'utf8')); }
  catch { return { projects: [{ slug: 'default', name: 'Default', projectId: appConfig.projectId, workers: WORKER_COUNT }] }; }
};
const saveProjectsRegistry = (reg) => fsSync.writeFileSync(PROJECTS_REGISTRY_PATH, JSON.stringify(reg, null, 2));

const makeProject = (meta) => {
  const slug = meta.slug;
  const root = resolveDir(`./projects/${slug}`);
  const projectId = meta.projectId || '';
  // profileDir: nếu có → tách Google account riêng. Nếu null/empty → share PROFILE_DIR global.
  // Path tương đối resolve về repo root (vd: 'profile-cafe' → /repo/profile-cafe).
  const profileDir = meta.profileDir ? resolveDir(meta.profileDir) : null;
  return {
    slug,
    name: meta.name || slug,
    projectId,
    projectUrl: projectId ? `https://labs.google/fx/tools/flow/project/${projectId}` : 'https://labs.google/fx/tools/flow',
    workersTarget: Math.max(1, Math.min(parseInt(meta.workers, 10) || 1, 4)),
    profileDir, // null = share global; absolute path = browser context riêng
    framesPath: path.join(root, 'frames.json'),
    outputDir: path.join(root, 'output'),
    statePath: path.join(root, 'output', 'state.json'),
    overridesPath: path.join(root, 'output', '_overrides.json'),
    customFramesPath: path.join(root, 'output', '_custom_frames.json'),
    jobs: new Map(),
    queue: [],
    jobAbort: false,
    dispatching: false,
    logBuffer: [],
    pagePool: [], // [{ page, busy, id, settingsVerified, projectSlug }]
    ctx: null,    // browser context riêng (chỉ set nếu profileDir != null), share global ctx ngược lại
  };
};

// Bootstrap project folder + frames.json từ template nếu chưa có (máy B clone repo về,
// .gitignore bỏ frames.json + output/ nên project folders trống).
const bootstrapProject = (proj) => {
  const projRoot = path.dirname(proj.framesPath);
  try { fsSync.mkdirSync(path.join(projRoot, 'output'), { recursive: true }); } catch {}
  if (fsSync.existsSync(proj.framesPath)) return;
  console.log(`[bootstrap] ${proj.slug}: tạo frames.json từ template`);
  const exampleSrc = path.resolve(__dirname, 'frames.example.json');
  let content;
  try {
    const tpl = JSON.parse(fsSync.readFileSync(exampleSrc, 'utf8'));
    tpl.project = tpl.project || {};
    tpl.project.flow_project_id = proj.projectId;
    tpl.project.name = proj.name;
    content = JSON.stringify(tpl, null, 2);
  } catch (e) {
    content = JSON.stringify({
      project: { name: proj.name, flow_project_id: proj.projectId },
      blocks: { setting: '', style: '' },
      frames: [],
    }, null, 2);
  }
  fsSync.writeFileSync(proj.framesPath, content);
};

const initProjects = () => {
  const reg = loadProjectsRegistry();
  for (const meta of (reg.projects || [])) {
    const proj = makeProject(meta);
    projects.set(meta.slug, proj);
    bootstrapProject(proj);
  }
  if (projects.size === 0) {
    const proj = makeProject({ slug: 'default', name: 'Default', projectId: appConfig.projectId, workers: WORKER_COUNT });
    projects.set('default', proj);
    bootstrapProject(proj);
  }
};
initProjects();

const getProject = (slug) => {
  const p = projects.get(slug);
  if (!p) throw Object.assign(new Error(`Project "${slug}" không tồn tại`), { httpStatus: 404 });
  return p;
};
const defaultProject = () => projects.get('default') || projects.values().next().value;

let ctx;
// Mỗi project có proj.pagePool dedicated. allWorkers() aggregate cho UI/legacy.
const allWorkers = () => {
  const out = [];
  for (const p of projects.values()) out.push(...p.pagePool);
  return out;
};
// Legacy alias: aggregate view + push routes vào default project. Cho code legacy
// (debugShot, ensureLivePage, /api/setup/launch-browser, /api/config re-nav).
const pagePool = new Proxy([], {
  get(_t, k) {
    const arr = allWorkers();
    if (k === 'length') return arr.length;
    if (k === 'push') return (...items) => {
      const dp = defaultProject();
      if (dp) for (const it of items) dp.pagePool.push(it);
      return allWorkers().length;
    };
    if (typeof k === 'symbol' || k === 'find' || k === 'map' || k === 'filter' || k === 'forEach' || k === 'some' || k === 'every' || k === 'slice' || k === 'indexOf') {
      const v = arr[k];
      return typeof v === 'function' ? v.bind(arr) : v;
    }
    if (typeof k === 'string' && /^\d+$/.test(k)) return arr[+k];
    return arr[k];
  },
  set(_t, k, v) {
    if (k === 'length' && Number(v) === 0) {
      // Legacy clear: clear all per-project pools (used khi relaunch ctx)
      for (const p of projects.values()) p.pagePool.length = 0;
      return true;
    }
    return true; // swallow other writes silently
  },
});
// Recover worker page nếu bị user đóng. Handle cả case ctx chết hoàn toàn.
const recoverWorkerPage = async (proj, w) => {
  let projCtx = proj.ctx || ctx;
  let ctxAlive = false;
  try {
    if (projCtx) { projCtx.pages(); ctxAlive = true; }
  } catch { ctxAlive = false; }

  if (!ctxAlive) {
    // Ctx chết hoàn toàn → relaunch
    const profilePath = proj.profileDir
      ? path.resolve(proj.profileDir)
      : path.resolve(USER_DATA_DIR);
    console.warn(`[recover ${proj.slug}] ctx dead → relaunching profile ${profilePath}`);
    ctxByProfile.delete(profilePath);
    try { await projCtx?.close(); } catch {}
    projCtx = await launchCtx(profilePath);
    proj.ctx = projCtx;
    if (!proj.profileDir) ctx = projCtx; // share global ctx
  }

  console.warn(`[recover ${proj.slug}] ${w.id} → new page`);
  w.page = await projCtx.newPage();
  await w.page.goto(proj.projectUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  w.settingsVerified = false;
};

const acquireWorker = async (proj) => {
  if (!proj) proj = defaultProject();
  // Auto-launch workers nếu pagePool empty (project mới tạo run-time chưa launch).
  if (proj.pagePool.length === 0) {
    console.log(`[acquireWorker ${proj.slug}] pagePool empty → tự launch workers`);
    try { await launchProjectWorkers(proj); }
    catch (e) { console.error(`[acquireWorker ${proj.slug}] launchProjectWorkers fail: ${e.message}`); }
    if (proj.pagePool.length === 0) {
      throw new Error(`Project "${proj.slug}" không có worker — projectId không hợp lệ hoặc browser launch fail. Check log + restart server.`);
    }
  }
  while (true) {
    const w = proj.pagePool.find(w => !w.busy);
    if (w) {
      if (w.page?.isClosed?.()) {
        try {
          await recoverWorkerPage(proj, w);
        } catch (e) {
          console.error(`[acquireWorker ${proj.slug}] ${w.id} recover failed: ${e.message}`);
        }
      }
      w.busy = true;
      return w;
    }
    await sleep(500);
  }
};
const releaseWorker = (w) => { if (w) w.busy = false; };

const ts = () => new Date().toISOString().replace(/[:.]/g, '-');

// ────────────────────────────────────────────────────────────
// LOG BUFFER + SSE BROADCAST
// ────────────────────────────────────────────────────────────
const LOG_MAX = 300; // giảm từ 800 → 300 cho nhẹ memory + ít DOM thrash trên client
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
// Each project has its own jobs Map: frame_id → { workerId, status, frameIdx, frameId, total, attempts, lastError, lastVariants, startedAt, mode }
// status: running | waiting_pick | failed | done
// mode: 'serial' | 'batch'  — serial = HITL pause; batch = parallel, no auto-advance

// Backward-compat single-job view (most-recent active or failed/done) — scoped to a project
const computePrimaryJob = (proj) => {
  const map = proj.jobs;
  if (map.size === 0) return { status: 'idle', frameIdx: -1, frameId: null, total: 0, attempts: 0, lastError: null, lastVariants: null, startedAt: null };
  // Prefer waiting_pick → running → failed → done
  const order = ['waiting_pick', 'running', 'failed', 'done'];
  for (const s of order) {
    for (const j of map.values()) if (j.status === s) return j;
  }
  return [...map.values()][0];
};

const broadcastJob = (proj) => {
  if (!proj) proj = defaultProject();
  const list = [...proj.jobs.values()];
  const primary = computePrimaryJob(proj);
  broadcast({ type: 'jobs', slug: proj.slug, jobs: list, queue: proj.queue.length, primary });
  // legacy single-job event for older clients
  broadcast({ type: 'job', slug: proj.slug, job: primary });
};

const loadFrames = async (proj) => {
  const raw = await fs.readFile(proj.framesPath, 'utf8');
  const cfg = JSON.parse(raw);
  // Merge custom frames vào sau builtin frames
  const custom = await loadCustomFrames(proj);
  cfg.frames = [...cfg.frames, ...custom];
  return cfg;
};
const loadState = async (proj) => {
  try { return JSON.parse(await fs.readFile(proj.statePath, 'utf8')); }
  catch { return { picked: {} }; }
};
const saveState = async (proj, s) => {
  await fs.mkdir(proj.outputDir, { recursive: true });
  await fs.writeFile(proj.statePath, JSON.stringify(s, null, 2));
};

// ─── Overrides (prompt edits) ───
const loadOverrides = async (proj) => {
  try { return JSON.parse(await fs.readFile(proj.overridesPath, 'utf8')); }
  catch { return {}; }
};
const saveOverrides = async (proj, o) => {
  await fs.mkdir(proj.outputDir, { recursive: true });
  await fs.writeFile(proj.overridesPath, JSON.stringify(o, null, 2));
};

// ─── Custom frames (user added) ───
const loadCustomFrames = async (proj) => {
  try { return JSON.parse(await fs.readFile(proj.customFramesPath, 'utf8')); }
  catch { return []; }
};
const saveCustomFrames = async (proj, arr) => {
  await fs.mkdir(proj.outputDir, { recursive: true });
  await fs.writeFile(proj.customFramesPath, JSON.stringify(arr, null, 2));
};

// ─── Archive prior attempt trước khi gen mới (preserve data) ───
const archiveFrameIfExists = async (proj, frame_id) => {
  const dir = path.join(proj.outputDir, frame_id);
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
  console.log(`[archive ${proj.slug}] ${frame_id} → attempts/${archiveId}`);
  return archiveId;
};

// debugShot writes vào OUTPUT_DIR/_debug. Auto-prune keep last DEBUG_KEEP files.
const DEBUG_KEEP = 10;
const debugShot = async (label, page = null) => {
  try {
    const dir = path.join(OUTPUT_DIR, '_debug');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${ts()}_${label}.png`);
    const targetPage = page || pagePool[0]?.page;
    if (!targetPage) return null;
    await targetPage.screenshot({ path: file, fullPage: false });
    console.log(`  [debug-shot] ${file}`);
    // Auto-prune older shots — giữ last DEBUG_KEEP files
    fs.readdir(dir).then(async (files) => {
      const pngs = files.filter(f => f.endsWith('.png')).sort();
      if (pngs.length <= DEBUG_KEEP) return;
      const toDelete = pngs.slice(0, pngs.length - DEBUG_KEEP);
      for (const f of toDelete) await fs.unlink(path.join(dir, f)).catch(() => {});
    }).catch(() => {});
    return file;
  } catch (e) {
    console.warn('  [debug-shot] failed:', e.message);
  }
};

// Map<absProfilePath, ctx> — share ctx giữa các project có cùng profileDir
const ctxByProfile = new Map();

const launchCtx = async (absProfile) => {
  if (ctxByProfile.has(absProfile)) return ctxByProfile.get(absProfile);
  console.log(`[init] launching ctx for profile: ${absProfile}`);
  const c = await chromium.launchPersistentContext(absProfile, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  ctxByProfile.set(absProfile, c);
  return c;
};

const initBrowser = async () => {
  const totalWorkers = [...projects.values()].reduce((s, p) => s + (p.workersTarget || 0), 0);
  console.log(`[init] projects=${projects.size}  total_workers=${totalWorkers}`);

  // Global ctx (cho project share account chung — không có profileDir riêng)
  const sharedAbsProfile = path.resolve(USER_DATA_DIR);
  const hasSharedProjects = [...projects.values()].some(p => !p.profileDir);
  if (hasSharedProjects) {
    ctx = await launchCtx(sharedAbsProfile);
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let firstPageUsed = false;
  for (const proj of projects.values()) {
    try {
      await launchProjectWorkers(proj, { reuseFirstPage: !firstPageUsed });
      if (proj.pagePool.length > 0 && !proj.profileDir) firstPageUsed = true;
    } catch (e) {
      console.error(`[init ${proj.slug}] launch fail: ${e.message} — skip, project sẽ tự launch khi acquireWorker`);
    }
  }
  console.log(`[init] ✓ ${allWorkers().length} worker(s) ready across ${projects.size} project(s) trong ${ctxByProfile.size} browser ctx`);
};

// Launch workers cho 1 project: tạo ctx (nếu profile riêng) + N pages.
// Gọi từ initBrowser (startup) và POST /api/projects (tạo project run-time).
// idempotent: nếu pagePool đã đủ workers → no-op.
const UUID_RE_GLOBAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const launchProjectWorkers = async (proj, { reuseFirstPage = false } = {}) => {
  const target = proj.workersTarget || 1;
  if (proj.pagePool.length >= target) return; // đủ rồi
  if (!proj.projectUrl || proj.projectUrl === 'https://labs.google/fx/tools/flow') {
    console.warn(`[launch ${proj.slug}] chưa có projectId — skip workers`);
    return;
  }
  if (!UUID_RE_GLOBAL.test(proj.projectId)) {
    console.warn(`[launch ${proj.slug}] projectId "${proj.projectId}" không phải UUID — skip workers`);
    return;
  }

  let projCtx;
  if (proj.profileDir) {
    projCtx = await launchCtx(proj.profileDir);
    console.log(`[launch ${proj.slug}] tài khoản riêng: ${proj.profileDir}`);
  } else {
    if (!ctx) {
      const sharedAbsProfile = path.resolve(USER_DATA_DIR);
      ctx = await launchCtx(sharedAbsProfile);
    }
    projCtx = ctx;
  }
  proj.ctx = projCtx;

  const startIdx = proj.pagePool.length;
  for (let i = startIdx; i < target; i++) {
    let p;
    if (reuseFirstPage && projCtx === ctx && i === startIdx) {
      p = projCtx.pages()[0] || await projCtx.newPage();
    } else {
      p = await projCtx.newPage();
    }
    const wid = `${proj.slug}-W${i + 1}`;
    console.log(`[launch ${wid}] navigate to ${proj.projectUrl}`);
    try {
      await p.goto(proj.projectUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await p.waitForTimeout(4000);
      const url = p.url();
      if (url.includes('accounts.google.com') || url.includes('signin')) {
        console.error(`[launch ${wid}] ❌ Browser bị redirect về login. Cookie expired? (profile=${proj.profileDir || 'shared'})`);
      }
      proj.pagePool.push({ page: p, busy: false, id: wid, settingsVerified: false, projectSlug: proj.slug });
      console.log(`[launch ${wid}] ✓ ready at ${url}`);
    } catch (e) {
      console.error(`[launch ${wid}] ❌ failed: ${e.message}`);
    }
  }
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

  // Click + button. Material Icon name 'add_2' là universal (không đổi theo locale).
  // Vietnamese UI: "add_2Tạo" · English UI: "add_2Create" — match theo icon name.
  const addBtn = page.locator('button').filter({ hasText: /^add_2\s*\S+$/ }).first();
  await addBtn.click({ timeout: 8000 });
  await humanPause(500, 1000);

  // Đợi dialog picker mở
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });

  // Tìm "Upload image" / "Tải ảnh lên" / "Tải hình ảnh lên" trong dialog.
  // Match cả 3 ngôn ngữ + icon name 'upload' nếu có.
  const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 8000 });
  const uploadRegex = /upload\s*image|t[aả]i\s*[aả]nh|t[aả]i\s*h[iì]nh|file_upload|drive_folder_upload/i;
  const uploadTrigger = page.locator('[role="dialog"]').getByText(uploadRegex).first();
  await uploadTrigger.click({ timeout: 5000 }).catch(async (e) => {
    await debugShot('ref_upload_btn_missing');
    throw new Error(`Không tìm được "Upload image"/"Tải ảnh" button: ${e.message}`);
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

// Click button settings popup → verify x4 + 9:16 active → click nếu chưa, đóng popup.
// Settings button = model dropdown ở prompt bar (text = model name hiện tại).
// Model name thay đổi theo Flow rollout (Nano Banana, Imagen, Veo, Gemini...) + locale,
// nên dùng nhiều strategy fallback thay vì hardcode 1 regex.
const ensureSettings = async (worker, { ratio = '9:16', count = 'x4' } = {}) => {
  if (worker.settingsVerified) return;
  const page = worker.page;
  console.log(`  [${worker.id} setup] verify settings (${ratio} + ${count})`);

  const ratioMap = { '16:9': 'crop_16_9', '4:3': 'crop_landscape', '1:1': 'crop_square', '3:4': 'crop_portrait', '9:16': 'crop_9_16' };
  const ratioIcon = ratioMap[ratio] || 'crop_9_16';

  // Helper: check ratio/count buttons có visible (popup đã mở chưa)?
  const popupOpen = async () => {
    return await page.evaluate((iconText) => {
      const btns = [...document.querySelectorAll('button')];
      const ratioBtn = btns.find(b => b.textContent.includes(iconText));
      const countBtn = btns.find(b => /^(x[1-4]|×[1-4])$/.test(b.textContent.trim()));
      return !!(ratioBtn && countBtn);
    }, ratioIcon).catch(() => false);
  };

  // Nếu popup đã mở sẵn (rare case sau resize/reload) → skip click
  if (!(await popupOpen())) {
    // Strategy 1: text-based (model names + dropdown markers, locale-flex)
    const modelRegex = /Nano\s*Banana|Imagen|Veo\s*\d?|Gemini|Flow\s+(?:Gen|Image|Video)|chevron_right|expand_more|arrow_drop_down|tune/i;
    const settingsBtn = page.locator('button').filter({ hasText: modelRegex }).first();

    let clicked = false;
    try {
      await settingsBtn.waitFor({ state: 'visible', timeout: 15000 });
      await settingsBtn.click({ timeout: 5000 });
      clicked = true;
    } catch (e) {
      console.warn(`  [${worker.id} setup] model button by text fail (${e.message.split('\n')[0]}), thử fallback`);
    }

    // Strategy 2: button có icon expand_more / arrow_drop_down ngay trước prompt textbox
    if (!clicked) {
      try {
        const submitBtn = page.getByRole('button', { name: /^arrow_forward\b/ }).last();
        const fallbackBtn = submitBtn.locator('xpath=preceding::button[normalize-space(.)!="" and (contains(.,"expand_more") or contains(.,"arrow_drop_down") or contains(.,"tune"))][1]');
        await fallbackBtn.click({ timeout: 5000 });
        clicked = true;
      } catch (e) {
        // continue to retry / fail
      }
    }

    if (!clicked) {
      await debugShot(`settings_btn_not_found_${worker.id}`, page);
      throw new Error(`Không tìm thấy nút settings/model trên Flow UI (model name có thể đã đổi). Thử mở Flow trực tiếp xem model gì đang active, hoặc bấm 🔑 reset login.`);
    }
  }

  // Đợi popup render (ratio + count buttons xuất hiện)
  await page.waitForFunction((iconText) => {
    const btns = [...document.querySelectorAll('button')];
    return btns.some(b => b.textContent.includes(iconText));
  }, ratioIcon, { timeout: 5000 }).catch(() => null);
  await humanPause(400, 800);

  // Check + click ratio nếu chưa active
  const ratioCheck = await page.evaluate((iconText) => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes(iconText));
    return btn ? { found: true, active: btn.getAttribute('data-state') === 'active' || btn.getAttribute('aria-pressed') === 'true' } : { found: false };
  }, ratioIcon);
  if (ratioCheck.found && !ratioCheck.active) {
    console.log(`  [setup] click ratio ${ratio}`);
    await page.locator(`button:has-text("${ratioIcon}")`).first().click({ timeout: 5000 });
    await humanPause(400, 800);
  } else if (ratioCheck.active) {
    console.log(`  [setup] ✓ ratio ${ratio} đã active`);
  } else {
    console.warn(`  [setup] ⚠ không thấy nút ratio ${ratioIcon} trong popup`);
  }

  // Check + click count
  const countCheck = await page.evaluate((target) => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === target);
    return btn ? { found: true, active: btn.getAttribute('data-state') === 'active' || btn.getAttribute('aria-pressed') === 'true' } : { found: false };
  }, count);
  if (countCheck.found && !countCheck.active) {
    console.log(`  [setup] click count ${count}`);
    await page.locator(`button`).filter({ hasText: new RegExp(`^${count}$`) }).first().click({ timeout: 5000 });
    await humanPause(400, 800);
  } else if (countCheck.active) {
    console.log(`  [setup] ✓ count ${count} đã active`);
  } else {
    console.warn(`  [setup] ⚠ không thấy nút count ${count} trong popup`);
  }

  await page.keyboard.press('Escape');
  await humanPause(400, 800);
  worker.settingsVerified = true;
};

const ensureProjectRoot = async (page, proj) => {
  const targetUrl = proj?.projectUrl || PROJECT_URL;
  const projectId = proj?.projectId || PROJECT_ID;
  const url = page.url();
  if (!projectId) return; // no specific project — leave page as-is
  if (!url.includes(`/project/${projectId}`) || url.includes('/edit/')) {
    console.log(`  [nav ${proj?.slug || 'default'}] back to project root`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  }
};

// Submit button luôn ở dưới cùng prompt bar, accessible name = "arrow_forward <text>".
// English: "arrow_forward Create" · Vietnamese: "arrow_forward Tạo".
// Dùng regex match icon name 'arrow_forward' (Material Icons — universal).
const findCreateButton = async (page) => {
  const btn = page.getByRole('button', { name: /^arrow_forward\b/ }).last();
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
const genFrameOnce = async ({ worker, prompt, referenceFiles = [], proj = null }) => {
  const page = worker.page;
  const wid = worker.id;
  // ─── Anti-detection: cooldown giữa 2 lần gen (GLOBAL cho mọi worker và project — share rate limit per IP/account)
  const elapsed = (Date.now() - lastGenAt) / 1000;
  if (lastGenAt > 0 && elapsed < COOLDOWN_AFTER_GEN_MIN) {
    const wait = rand(COOLDOWN_AFTER_GEN_MIN - elapsed, COOLDOWN_AFTER_GEN_MAX - elapsed);
    console.log(`  [${wid} cooldown] sleep ${wait.toFixed(1)}s before next gen`);
    await sleep(wait * 1000);
  }

  await ensureProjectRoot(page, proj);
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
const genFrame = async ({ worker, prompt, referenceFiles = [], maxRetries = 3, proj = null }) => {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await genFrameOnce({ worker, prompt, referenceFiles, proj });
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

const downloadImage = async (url, filepath, browserCtx = null) => {
  // Mở URL ảnh trong tab mới → goto trả response trực tiếp, không CORS-check
  // Optional: dùng ctx của project (multi-account) thay vì global ctx
  const useCtx = browserCtx || ctx;
  const dlPage = await useCtx.newPage();
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
const runOneFrame = async (proj, cfg, frameIdx, worker, mode = 'serial') => {
  const f = cfg.frames[frameIdx];

  const overrides = await loadOverrides(proj);
  const ov = overrides[f.frame_id] || {};
  const effectiveAction = ov.action || f.action;
  // Override có thể có default_reference riêng (kể cả null = bỏ default). 'default_reference' in ov
  // dùng để phân biệt "không override default" vs "override null".
  const effectiveDefault = ('default_reference' in ov) ? ov.default_reference : f.default_reference;
  const effectiveExtraRefs = Array.isArray(ov.extra_references)
    ? ov.extra_references
    : (Array.isArray(f.extra_references) ? f.extra_references : []);
  const fullPrompt = `${cfg.blocks.setting}\n\n${cfg.blocks.style}\n\n${effectiveAction}`;

  const state = await loadState(proj);
  const refs = [];
  // Resolve frame ref → file path. Ưu tiên: (1) variant đã pick → (2) fallback v1.png nếu có
  // → (3) null nếu frame chưa gen lần nào.
  const resolveFrameRef = (frameId) => {
    const picked = state.picked?.[frameId];
    if (picked) {
      const p = picked.filePath
        ? (path.isAbsolute(picked.filePath) ? picked.filePath : path.join(proj.outputDir, picked.filePath))
        : path.join(proj.outputDir, frameId, `v${(picked.pickedIdx ?? 0) + 1}.png`);
      return { path: p, source: 'picked' };
    }
    // Fallback: dùng v1.png nếu frame đã gen nhưng chưa pick
    const v1 = path.join(proj.outputDir, frameId, 'v1.png');
    if (fsSync.existsSync(v1)) return { path: v1, source: 'v1-fallback' };
    return null;
  };
  if (effectiveDefault) {
    const r = resolveFrameRef(effectiveDefault);
    if (r) {
      refs.push(r.path);
      if (r.source === 'v1-fallback') console.log(`[refs ${proj.slug}] ${f.frame_id}: default_reference ${effectiveDefault} chưa pick → dùng v1.png fallback`);
    } else console.warn(`[refs ${proj.slug}] ${f.frame_id}: default_reference ${effectiveDefault} chưa gen — skip`);
  }
  for (const fid of effectiveExtraRefs) {
    if (fid === effectiveDefault) continue; // dedupe
    const r = resolveFrameRef(fid);
    if (r) {
      refs.push(r.path);
      if (r.source === 'v1-fallback') console.log(`[refs ${proj.slug}] ${f.frame_id}: extra_reference ${fid} chưa pick → dùng v1.png fallback`);
    } else console.warn(`[refs ${proj.slug}] ${f.frame_id}: extra_reference ${fid} chưa gen — skip`);
  }
  // reference_files: override > frame def. Override = ảnh upload qua UI Edit panel.
  const effectiveRefFiles = Array.isArray(ov.reference_files)
    ? ov.reference_files
    : (Array.isArray(f.reference_files) ? f.reference_files : []);
  for (const rf of effectiveRefFiles) {
    refs.push(path.isAbsolute(rf) ? rf : path.join(proj.outputDir, rf));
  }

  await archiveFrameIfExists(proj, f.frame_id);

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
  proj.jobs.set(f.frame_id, j);
  broadcastJob(proj);

  console.log(`\n[job ${proj.slug}/${worker.id}] ▶ ${f.frame_id} (${frameIdx + 1}/${cfg.frames.length}) — ${f.topic}  mode=${mode}`);
  console.log(`[job ${proj.slug}/${worker.id}]   refs=${refs.length} ${refs.map(r => path.basename(path.dirname(r)) + '/' + path.basename(r)).join(', ')}  prompt-len=${fullPrompt.length}`);

  try {
    const { variants, attempts } = await genFrame({ worker, prompt: fullPrompt, referenceFiles: refs, maxRetries: 3, proj });
    if (proj.jobAbort) {
      j.status = 'failed';
      j.lastError = 'aborted';
      proj.jobs.set(f.frame_id, j);
      broadcastJob(proj);
      return;
    }

    const downloaded = [];
    for (let i = 0; i < variants.length; i++) {
      const local = path.join(proj.outputDir, f.frame_id, `v${i + 1}.png`);
      await downloadImage(variants[i].fifeUrl, local, worker.page.context());
      downloaded.push({ ...variants[i], localPath: local });
    }

    const metaPath = path.join(proj.outputDir, f.frame_id, 'meta.json');
    await fs.writeFile(metaPath, JSON.stringify({
      frame_id: f.frame_id, prompt: fullPrompt, reference_files: refs,
      attempts, generatedAt: new Date().toISOString(), variants: downloaded
    }, null, 2));

    j.status = 'waiting_pick';
    j.attempts = attempts;
    j.lastVariants = downloaded;
    proj.jobs.set(f.frame_id, j);
    broadcastJob(proj);
    console.log(`[job ${proj.slug}/${worker.id}] ⏸ ${f.frame_id} done (${attempts} attempts) — chờ pick variant`);
  } catch (e) {
    j.status = 'failed';
    j.lastError = e.message;
    proj.jobs.set(f.frame_id, j);
    broadcastJob(proj);
    console.error(`[job ${proj.slug}/${worker.id}] ✗ ${f.frame_id} failed: ${e.message}`);
  }
};

// Dispatcher: lấy frame từ queue, acquire worker, chạy. Trả về khi queue empty.
const runDispatcher = async (proj) => {
  if (proj.dispatching) {
    console.warn(`[dispatcher ${proj.slug}] đã đang chạy, skip — queue=${proj.queue.length} jobs=${proj.jobs.size}`);
    return;
  }
  proj.dispatching = true;
  console.log(`[dispatcher ${proj.slug}] start — queue=${proj.queue.length} pagePool=${proj.pagePool.length}`);
  try {
    const cfg = await loadFrames(proj);
    while (proj.queue.length > 0 && !proj.jobAbort) {
      const item = proj.queue.shift();
      const f = cfg.frames[item.frameIdx];
      if (!f || f.frame_id !== item.frame_id) continue; // stale
      // Safety: skip nếu frame đang running hoặc waiting_pick (chống loop khi queue
      // bị duplicate do user click nhiều lần "Gen frame này" / "Resume").
      // Re-run hợp lệ phải đi qua /api/retry hoặc /api/skip (xoá job trước rồi push).
      const existing = proj.jobs.get(item.frame_id);
      if (existing && (existing.status === 'running' || existing.status === 'waiting_pick')) {
        console.warn(`[dispatcher ${proj.slug}] skip ${item.frame_id} — already ${existing.status}`);
        continue;
      }
      const worker = await acquireWorker(proj);
      // Chạy frame async, không block dispatcher khi batch mode parallel
      const runP = (async () => {
        try {
          await runOneFrame(proj, cfg, item.frameIdx, worker, item.mode);
        } catch (e) {
          console.error(`[dispatcher ${proj.slug}] runOneFrame ${item.frame_id} threw:`, e.message);
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
    proj.dispatching = false;
  }
};

// Sau khi anh pick (serial mode), advance to next frame
const advanceJob = async (proj, lastFrameIdx, mode = 'serial') => {
  if (proj.jobAbort || mode === 'batch') return;
  const cfg = await loadFrames(proj);
  const nextIdx = lastFrameIdx + 1;
  if (nextIdx >= cfg.frames.length) {
    console.log(`[job ${proj.slug}] ✓ all frames done`);
    return;
  }
  proj.queue.push({ frameIdx: nextIdx, frame_id: cfg.frames[nextIdx].frame_id, mode });
  runDispatcher(proj);
};

const app = express();
app.use(express.json({ limit: '50mb' }));
// Skip noisy paths (state polling + log SSE + static output) khỏi morgan log
// → giảm spam SSE → giảm DOM thrash trên UI
app.use(morgan('tiny', {
  skip: (req) => /^\/(api\/(state|logs)|output|public|favicon|projects\/.+\/output)/.test(req.url),
}));
// Legacy /output → default project (backward compat for UI)
app.use('/output', (req, res, next) => express.static(defaultProject().outputDir)(req, res, next));
// Per-project /projects/:slug/output
app.use('/projects/:slug/output', (req, res, next) => {
  const proj = projects.get(req.params.slug);
  if (!proj) return res.status(404).end();
  express.static(proj.outputDir)(req, res, next);
});
// Static public/ — cache 1 day cho tailwind.js (immutable big asset). HTML/index không cache.
app.use(express.static(PUBLIC_DIR, {
  maxAge: '1d',
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Wrap a per-project handler so legacy + slug routes share the same body.
// `slugSource` is either a fixed slug string ('default') or a function (req) => slug
const wrapProjectHandler = (handler) => async (req, res) => {
  try {
    const slug = req.params.slug || 'default';
    const proj = getProject(slug);
    return await handler(proj, req, res);
  } catch (e) {
    res.status(e.httpStatus || 500).json({ error: e.message });
  }
};

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

// ─── List projects ───
app.get('/api/projects', async (req, res) => {
  try {
    const arr = [];
    for (const proj of projects.values()) {
      let hasFrames = false;
      try { await fs.access(proj.framesPath); hasFrames = true; } catch {}
      arr.push({
        slug: proj.slug,
        name: proj.name,
        projectId: proj.projectId,
        projectUrl: proj.projectUrl,
        workers: proj.workersTarget,
        hasFrames,
        profileDir: proj.profileDir, // null = shared account, string = riêng
        hasOwnProfile: !!proj.profileDir,
      });
    }
    res.json({ projects: arr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add project: tạo entry trong projects.json + folder projects/<slug>/. Workers chỉ launch sau restart.
app.post('/api/projects', async (req, res) => {
  try {
    const { slug, name, projectId, workers = 1, separateProfile = false } = req.body || {};
    if (!slug || !/^[a-z][a-z0-9-]{1,63}$/.test(slug)) return res.status(400).json({ error: 'slug phải bắt đầu bằng chữ, chỉ chữ thường + số + dấu gạch, 2-64 ký tự' });
    if (projects.has(slug)) return res.status(409).json({ error: `slug "${slug}" đã tồn tại` });
    if (!projectId) return res.status(400).json({ error: 'projectId bắt buộc' });
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(projectId)) return res.status(400).json({ error: 'projectId phải là UUID (vd "ab883b63-982a-4df4-80ca-f9d6da04ec64") — paste từ URL Flow project' });
    const w = parseInt(workers, 10);
    if (!Number.isFinite(w) || w < 1 || w > 4) return res.status(400).json({ error: 'workers phải là số 1-4' });

    // separateProfile: true → tạo profileDir riêng cho project, có Google account khác
    const profileDir = separateProfile ? `./profile-${slug}` : null;

    const reg = loadProjectsRegistry();
    reg.projects = reg.projects || [];
    const entry = { slug, name: name || slug, projectId, workers, createdAt: new Date().toISOString() };
    if (profileDir) entry.profileDir = profileDir;
    reg.projects.push(entry);
    saveProjectsRegistry(reg);

    // Tạo project folder + frames.json từ template
    const projRoot = resolveDir(`./projects/${slug}`);
    await fs.mkdir(path.join(projRoot, 'output'), { recursive: true });
    const exampleSrc = path.resolve(__dirname, 'frames.example.json');
    const framesDest = path.join(projRoot, 'frames.json');
    try {
      const src = await fs.readFile(exampleSrc, 'utf8');
      const tpl = JSON.parse(src);
      tpl.project = tpl.project || {};
      tpl.project.flow_project_id = projectId;
      tpl.project.name = name || slug;
      await fs.writeFile(framesDest, JSON.stringify(tpl, null, 2));
    } catch (e) {
      await fs.writeFile(framesDest, JSON.stringify({ project: { name, flow_project_id: projectId }, blocks: { setting: '', style: '' }, frames: [] }, null, 2));
    }

    // Add project struct in-memory + auto-launch workers (không cần restart)
    const proj = makeProject({ slug, name, projectId, workers, profileDir });
    projects.set(slug, proj);

    // Launch workers run-time — không block response
    res.json({ ok: true, slug, workersLaunching: workers });
    (async () => {
      try {
        await launchProjectWorkers(proj);
        console.log(`[projects] + ${slug} (${projectId}) — ${proj.pagePool.length}/${workers} worker(s) ready`);
      } catch (e) {
        console.error(`[projects] + ${slug} launch workers fail: ${e.message}`);
      }
    })();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete project: remove entry trong projects.json + xoá folder projects/<slug>/
// (chỉ in-memory state + folder; workers đã launch sẽ idle đến restart).
// Không cho phép xoá 'default' hoặc project đang chạy job.
app.delete('/api/projects/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    if (slug === 'default') return res.status(400).json({ error: 'Không xoá được project "default"' });
    const proj = projects.get(slug);
    if (!proj) return res.status(404).json({ error: `Project "${slug}" không tồn tại` });
    if (proj.jobs.size > 0 || proj.queue.length > 0) {
      return res.status(409).json({ error: `Project "${slug}" đang có ${proj.jobs.size} job + ${proj.queue.length} queue, stop trước rồi xoá` });
    }
    // Đóng workers (pages) trước khi xoá folder/registry
    proj.jobAbort = true;
    for (const w of proj.pagePool) {
      try { await w.page?.close(); } catch {}
    }
    proj.pagePool.length = 0;
    // Đóng ctx riêng (chỉ khi profileDir riêng, không share). Cleanup ctxByProfile cache.
    if (proj.profileDir && proj.ctx) {
      try { await proj.ctx.close(); } catch {}
      const profilePath = path.resolve(proj.profileDir);
      ctxByProfile.delete(profilePath);
    }
    proj.ctx = null;

    // Xoá entry registry
    const reg = loadProjectsRegistry();
    reg.projects = (reg.projects || []).filter(p => p.slug !== slug);
    saveProjectsRegistry(reg);
    projects.delete(slug);
    // Xoá folder project (frames, output, _overrides, _custom_frames)
    const projRoot = path.dirname(proj.framesPath);
    try { await fs.rm(projRoot, { recursive: true, force: true }); }
    catch (e) { console.warn(`[projects] - ${slug}: xoá folder fail: ${e.message}`); }
    // Xoá profile dir nếu là profile riêng (không xoá nếu share)
    if (proj.profileDir) {
      try { await fs.rm(proj.profileDir, { recursive: true, force: true }); console.log(`[projects] - ${slug}: xoá profile dir ${proj.profileDir}`); }
      catch (e) { console.warn(`[projects] - ${slug}: xoá profileDir fail: ${e.message}`); }
    }
    console.log(`[projects] - ${slug} đã xoá (workers + ctx + folder).`);
    res.json({ ok: true, slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reset login cho project — xoá cookies, mở trang accounts.google.com để user login
// Worker đầu tiên brought to front để dễ thấy.
app.post('/api/projects/:slug/reset-login', async (req, res) => {
  try {
    const slug = req.params.slug;
    const proj = projects.get(slug);
    if (!proj) return res.status(404).json({ error: `Project "${slug}" không tồn tại` });
    if (proj.jobs.size > 0 || proj.queue.length > 0) {
      return res.status(409).json({ error: `Project "${slug}" đang có job, stop trước rồi reset` });
    }
    if (!proj.ctx) return res.status(400).json({ error: 'Project chưa launch browser ctx' });
    try {
      await proj.ctx.clearCookies();
      console.log(`[reset-login ${slug}] ✓ cleared cookies`);
    } catch (e) {
      return res.status(500).json({ error: `clearCookies fail: ${e.message}` });
    }
    // Worker 1: mở trang login Google + bring to front
    const w0 = proj.pagePool[0];
    if (w0) {
      try {
        await w0.page.bringToFront();
        await w0.page.goto('https://accounts.google.com/signin?continue=https://labs.google/fx/tools/flow', {
          waitUntil: 'domcontentloaded', timeout: 30000
        });
        w0.settingsVerified = false;
      } catch (e) { console.warn(`[reset-login ${slug}] open login ${w0.id} failed: ${e.message}`); }
    }
    // Workers còn lại nav background về Flow root (sẽ tự redirect login khi cookie missing)
    for (const w of proj.pagePool.slice(1)) {
      try {
        await w.page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'domcontentloaded', timeout: 30000 });
        w.settingsVerified = false;
      } catch (e) { console.warn(`[reset-login ${slug}] re-nav ${w.id} failed: ${e.message}`); }
    }
    res.json({ ok: true, slug, message: `Đã mở trang login Google trên tab Chromium. Login account mới — bot tự detect.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Check login status: poll endpoint cho UI biết khi nào user login xong
app.get('/api/projects/:slug/login-status', async (req, res) => {
  try {
    const slug = req.params.slug;
    const proj = projects.get(slug);
    if (!proj) return res.status(404).json({ error: `Project "${slug}" không tồn tại` });
    if (!proj.ctx) return res.json({ loggedIn: false, reason: 'no ctx' });
    try {
      const cookies = await proj.ctx.cookies(['https://accounts.google.com', 'https://labs.google']);
      const loggedIn = cookies.some(c =>
        /\.?google\.com$/.test(c.domain) &&
        /^(SID|SAPISID|SSID|HSID|APISID|__Secure-)/i.test(c.name)
      );
      const w0 = proj.pagePool[0];
      const currentUrl = w0?.page?.url() || '';
      res.json({ loggedIn, currentUrl, slug });
    } catch (e) {
      res.json({ loggedIn: false, reason: e.message });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sau khi user login xong → nav workers về project URL + verify settings
app.post('/api/projects/:slug/login-complete', async (req, res) => {
  try {
    const slug = req.params.slug;
    const proj = projects.get(slug);
    if (!proj) return res.status(404).json({ error: `Project "${slug}" không tồn tại` });
    if (!proj.ctx || !proj.projectUrl) return res.status(400).json({ error: 'Project chưa setup' });
    const cookies = await proj.ctx.cookies(['https://accounts.google.com', 'https://labs.google']);
    const loggedIn = cookies.some(c => /\.?google\.com$/.test(c.domain) && /^(SID|SAPISID|SSID|HSID|APISID|__Secure-)/i.test(c.name));
    if (!loggedIn) return res.status(400).json({ error: 'Chưa detect login — kiểm tra lại' });
    // Nav tất cả workers về project URL
    for (const w of proj.pagePool) {
      try {
        await w.page.goto(proj.projectUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        w.settingsVerified = false;
      } catch (e) { console.warn(`[login-complete ${slug}] nav ${w.id} fail: ${e.message}`); }
    }
    console.log(`[login-complete ${slug}] ✓ ${proj.pagePool.length} worker(s) ready với account mới`);
    res.json({ ok: true, slug, message: `${proj.pagePool.length} worker(s) đã sẵn sàng với account mới` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── State (per-project) ───
const handleState = async (proj, req, res) => {
  const cfg = await loadFrames(proj);
  const state = await loadState(proj);
  const overrides = await loadOverrides(proj);
  const customFrames = await loadCustomFrames(proj);
  const jobsList = [...proj.jobs.values()];
  const jobsByFrame = Object.fromEntries(jobsList.map(j => [j.frameId, j]));
  const framesWithStatus = cfg.frames.map(f => {
    const picked = state.picked?.[f.frame_id];
    const override = overrides[f.frame_id];
    let status = 'pending';
    if (jobsByFrame[f.frame_id]) status = jobsByFrame[f.frame_id].status;
    else if (picked) status = 'picked';
    const hasOv = !!(override?.action
      || (override && 'default_reference' in override)
      || (Array.isArray(override?.extra_references) && override.extra_references.length > 0)
      || (Array.isArray(override?.reference_files) && override.reference_files.length > 0));
    // Có ảnh trên đĩa? (đã gen ít nhất 1 lần — kể cả chưa pick)
    const hasOutput = fsSync.existsSync(path.join(proj.outputDir, f.frame_id, 'v1.png'));
    return { ...f, status, picked, override, has_override: hasOv, has_output: hasOutput };
  });
  res.json({
    slug: proj.slug,
    name: proj.name,
    projectId: proj.projectId,
    frames: framesWithStatus,
    blocks: cfg.blocks,
    project: cfg.project,
    state,
    job: computePrimaryJob(proj),  // legacy single-job
    jobs: jobsList,                 // multi-job array
    jobs_by_frame: jobsByFrame,
    queue_size: proj.queue.length,
    workers: proj.pagePool.map(w => ({ id: w.id, busy: w.busy, settingsVerified: w.settingsVerified, projectSlug: w.projectSlug })),
    worker_count: proj.pagePool.length,
    overrides,
    custom_frames: customFrames
  });
};
app.get('/api/state', wrapProjectHandler(handleState));
app.get('/api/p/:slug/state', wrapProjectHandler(handleState));

// ─── Frame detail ───
const handleFrame = async (proj, req, res) => {
  const id = req.params.id;
  const dir = path.join(proj.outputDir, id);
  const result = { frame_id: id, slug: proj.slug, current: null, attempts: [] };

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
};
app.get('/api/frame/:id', wrapProjectHandler(handleFrame));
app.get('/api/p/:slug/frame/:id', wrapProjectHandler(handleFrame));

// ─── Re-pick variant (đổi lựa chọn frame đã pick mà KHÔNG re-run) ───
const handleRepick = async (proj, req, res) => {
  const { frame_id, attempt_id = 'current', variant_idx } = req.body || {};
  if (!frame_id || variant_idx === undefined) return res.status(400).json({ error: 'frame_id và variant_idx bắt buộc' });

  const metaPath = attempt_id === 'current'
    ? path.join(proj.outputDir, frame_id, 'meta.json')
    : path.join(proj.outputDir, frame_id, 'attempts', attempt_id, 'meta.json');
  const meta = await fs.readFile(metaPath, 'utf8').then(JSON.parse).catch(() => null);
  if (!meta) return res.status(404).json({ error: 'frame meta không tìm thấy' });
  if (!meta.variants?.[variant_idx]) return res.status(400).json({ error: 'variant_idx invalid' });

  const filePath = attempt_id === 'current'
    ? path.join(proj.outputDir, frame_id, `v${variant_idx + 1}.png`)
    : path.join(proj.outputDir, frame_id, 'attempts', attempt_id, `v${variant_idx + 1}.png`);

  const state = await loadState(proj);
  state.picked = state.picked || {};
  state.picked[frame_id] = {
    mediaId: meta.variants[variant_idx].mediaId,
    pickedIdx: variant_idx,
    attempt_id,
    pickedAt: new Date().toISOString(),
    fifeUrl: meta.variants[variant_idx].fifeUrl,
    filePath,
  };
  await saveState(proj, state);
  console.log(`[repick ${proj.slug}] ${frame_id} attempt=${attempt_id} v${variant_idx + 1}`);
  res.json({ ok: true });
};
app.post('/api/repick', wrapProjectHandler(handleRepick));
app.post('/api/p/:slug/repick', wrapProjectHandler(handleRepick));

// ─── Save / clear frame override (action prompt + extra_references) ───
const handleOverridePrompt = async (proj, req, res) => {
  const body = req.body || {};
  const { frame_id, action, default_reference, extra_references, reference_files, _clear } = body;
  if (!frame_id) return res.status(400).json({ error: 'frame_id bắt buộc' });
  const overrides = await loadOverrides(proj);

  if (_clear) {
    delete overrides[frame_id];
    await saveOverrides(proj, overrides);
    console.log(`[override ${proj.slug}] cleared ${frame_id} (all fields)`);
    return res.json({ ok: true, overrides });
  }

  const cur = { ...(overrides[frame_id] || {}) };

  if (action !== undefined) {
    if (action === '') delete cur.action;
    else cur.action = action;
  }
  // default_reference override: undefined = không thay đổi, null/'' = bỏ default, string = override
  // Body field 'default_reference' present (kể cả null) → áp dụng. Dùng 'in' để phân biệt.
  if ('default_reference' in (req.body || {})) {
    if (default_reference == null || default_reference === '') {
      cur.default_reference = null; // explicit null = bỏ default
    } else {
      cur.default_reference = default_reference;
    }
  }
  if (extra_references !== undefined) {
    if (!Array.isArray(extra_references) || extra_references.length === 0) delete cur.extra_references;
    else cur.extra_references = [...new Set(extra_references.filter(x => typeof x === 'string' && x.trim()))];
  }
  // reference_files: array path/URL ảnh upload từ máy (anchor / character ref)
  // Override 'reference_files' nếu defined (mảng rỗng = clear, không sửa frame def)
  if (reference_files !== undefined) {
    if (!Array.isArray(reference_files) || reference_files.length === 0) delete cur.reference_files;
    else cur.reference_files = reference_files.filter(x => typeof x === 'string' && x.trim());
  }

  const hasContent = cur.action != null
    || 'default_reference' in cur
    || (Array.isArray(cur.extra_references) && cur.extra_references.length > 0)
    || (Array.isArray(cur.reference_files) && cur.reference_files.length > 0);

  if (hasContent) {
    cur.updatedAt = new Date().toISOString();
    overrides[frame_id] = cur;
    console.log(`[override ${proj.slug}] ${frame_id} updated — action=${cur.action ? cur.action.length + 'ch' : '-'}  default=${cur.default_reference ?? (('default_reference' in cur) ? 'null' : '-')}  extra_refs=${(cur.extra_references || []).join(',') || '-'}  uploads=${(cur.reference_files || []).length}`);
  } else {
    delete overrides[frame_id];
    console.log(`[override ${proj.slug}] cleared ${frame_id}`);
  }
  await saveOverrides(proj, overrides);
  res.json({ ok: true, overrides });
};
app.post('/api/override-prompt', wrapProjectHandler(handleOverridePrompt));
app.post('/api/p/:slug/override-prompt', wrapProjectHandler(handleOverridePrompt));

// ─── Edit blocks (setting/style) — sửa frames.json blocks trực tiếp ───
const handleBlocks = async (proj, req, res) => {
  const { setting, style } = req.body || {};
  // Đọc frames.json (raw) để giữ nguyên project meta + custom_frames merge.
  // Defensive: nếu frames.json missing (bootstrap fail trên máy B clone), tự bootstrap lại.
  let cfg;
  try {
    const raw = await fs.readFile(proj.framesPath, 'utf8');
    cfg = JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn(`[blocks ${proj.slug}] frames.json missing — re-bootstrap`);
      bootstrapProject(proj);
      const raw = await fs.readFile(proj.framesPath, 'utf8');
      cfg = JSON.parse(raw);
    } else {
      throw e;
    }
  }
  cfg.blocks = cfg.blocks || {};
  if (typeof setting === 'string') cfg.blocks.setting = setting;
  if (typeof style === 'string') cfg.blocks.style = style;
  await fs.mkdir(path.dirname(proj.framesPath), { recursive: true });
  await fs.writeFile(proj.framesPath, JSON.stringify(cfg, null, 2));
  console.log(`[blocks ${proj.slug}] saved — setting=${(cfg.blocks.setting || '').length}ch  style=${(cfg.blocks.style || '').length}ch`);
  res.json({ ok: true, blocks: cfg.blocks });
};
app.post('/api/blocks', wrapProjectHandler(handleBlocks));
app.post('/api/p/:slug/blocks', wrapProjectHandler(handleBlocks));

// ─── Add custom frame ───
const handleAddFrame = async (proj, req, res) => {
  const { frame_id, topic, action, default_reference, reference_files = [], extra_references = [] } = req.body || {};
  if (!frame_id || !action) return res.status(400).json({ error: 'frame_id và action bắt buộc' });
  // Conflict với builtin frames hoặc existing custom?
  const cfg = await loadFrames(proj);
  if (cfg.frames.some(f => f.frame_id === frame_id)) return res.status(409).json({ error: `frame_id "${frame_id}" đã tồn tại` });
  const custom = await loadCustomFrames(proj);
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
  await saveCustomFrames(proj, custom);
  console.log(`[custom ${proj.slug}] + ${frame_id}: ${topic || ''}`);
  res.json({ ok: true });
};
app.post('/api/add-frame', wrapProjectHandler(handleAddFrame));
app.post('/api/p/:slug/add-frame', wrapProjectHandler(handleAddFrame));

// ─── Delete custom frame ───
const handleDeleteCustomFrame = async (proj, req, res) => {
  const id = req.params.id;
  const custom = await loadCustomFrames(proj);
  const filtered = custom.filter(f => f.frame_id !== id);
  if (filtered.length === custom.length) return res.status(404).json({ error: 'custom frame không tồn tại' });
  await saveCustomFrames(proj, filtered);
  console.log(`[custom ${proj.slug}] - ${id}`);
  res.json({ ok: true });
};
app.delete('/api/custom-frame/:id', wrapProjectHandler(handleDeleteCustomFrame));
app.delete('/api/p/:slug/custom-frame/:id', wrapProjectHandler(handleDeleteCustomFrame));

// ─── SSE log stream (legacy: emits global log buffer + default project's jobs) ───
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
  const dp = defaultProject();
  res.write(`data: ${JSON.stringify({ type: 'jobs', slug: dp.slug, jobs: [...dp.jobs.values()], queue: dp.queue.length, primary: computePrimaryJob(dp) })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'job', slug: dp.slug, job: computePrimaryJob(dp) })}\n\n`);
  sseClients.add(res);
  const heartbeat = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 15000);
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
});

// ─── Start (serial mode, HITL pause) ───
const handleStart = async (proj, req, res) => {
  proj.jobAbort = false;
  const cfg = await loadFrames(proj);
  const primary = computePrimaryJob(proj);
  const fromIdx = req.body?.from_idx ?? (primary.frameIdx >= 0 ? primary.frameIdx + 1 : 0);
  if (fromIdx < 0 || fromIdx >= cfg.frames.length) return res.status(400).json({ error: 'from_idx out of range' });
  if (fromIdx === 0 && req.body?.reset_state !== false) {
    await saveState(proj, { picked: {}, startedAt: new Date().toISOString() });
    proj.jobs.clear();
    console.log(`[job ${proj.slug}] ⌫ reset state vì start từ frame 0`);
  }
  console.log(`[job ${proj.slug}] ▶▶ start from frame index ${fromIdx} (${cfg.frames[fromIdx].frame_id})`);
  // Dedupe: skip nếu frame đã trong queue hoặc đang running/waiting_pick (user spam Resume)
  const targetFid = cfg.frames[fromIdx].frame_id;
  const inQueue = proj.queue.some(q => q.frame_id === targetFid);
  const existing = proj.jobs.get(targetFid);
  if (inQueue || (existing && (existing.status === 'running' || existing.status === 'waiting_pick'))) {
    console.warn(`[job ${proj.slug}] skip Start ${targetFid} — đã ${existing?.status || 'in queue'}`);
    res.json({ ok: true, fromIdx, mode: 'serial', slug: proj.slug, skipped: true });
    return;
  }
  // Serial mode: enqueue 1 frame, dispatcher sẽ pause sau xong (HITL pick → advance)
  proj.queue.push({ frameIdx: fromIdx, frame_id: targetFid, mode: 'serial' });
  res.json({ ok: true, fromIdx, mode: 'serial', slug: proj.slug });
  runDispatcher(proj).catch(e => console.error(`[dispatcher ${proj.slug}] crash:`, e.message));
};
app.post('/api/start', wrapProjectHandler(handleStart));
app.post('/api/p/:slug/start', wrapProjectHandler(handleStart));

// ─── Batch start (parallel, no auto-advance) ───
const handleBatchStart = async (proj, req, res) => {
  proj.jobAbort = false;
  const cfg = await loadFrames(proj);
  const { frame_ids } = req.body || {};
  if (!Array.isArray(frame_ids) || frame_ids.length === 0) return res.status(400).json({ error: 'frame_ids[] bắt buộc' });
  const items = [];
  const skipped = [];
  for (const fid of frame_ids) {
    const idx = cfg.frames.findIndex(f => f.frame_id === fid);
    if (idx < 0) return res.status(400).json({ error: `frame_id "${fid}" không tồn tại` });
    // Dedupe: skip nếu đã có trong queue hoặc đang running/waiting_pick.
    // Tránh trường hợp user click nhanh "Gen frame này" → push N entry → bot loop F01.
    const inQueue = proj.queue.some(q => q.frame_id === fid);
    const j = proj.jobs.get(fid);
    if (inQueue || (j && (j.status === 'running' || j.status === 'waiting_pick'))) {
      skipped.push(fid);
      continue;
    }
    items.push({ frameIdx: idx, frame_id: fid, mode: 'batch' });
  }
  for (const it of items) proj.queue.push(it);
  console.log(`[batch ${proj.slug}] ▶▶ enqueued ${items.length} frames, ${proj.pagePool.length} workers parallel` + (skipped.length ? ` — skipped ${skipped.length} dupe (${skipped.join(',')})` : ''));
  res.json({ ok: true, count: items.length, skipped, workers: proj.pagePool.length, slug: proj.slug });
  runDispatcher(proj).catch(e => console.error(`[dispatcher ${proj.slug}] crash:`, e.message));
};
app.post('/api/batch-start', wrapProjectHandler(handleBatchStart));
app.post('/api/p/:slug/batch-start', wrapProjectHandler(handleBatchStart));

// ─── Pick variant ───
const handlePick = async (proj, req, res) => {
  const { frame_id, variant_idx } = req.body || {};
  const j = proj.jobs.get(frame_id);
  if (!j) return res.status(404).json({ error: `no active job for ${frame_id}` });
  if (j.status !== 'waiting_pick') return res.status(409).json({ error: `${frame_id} not waiting_pick (status=${j.status})` });
  if (!j.lastVariants?.[variant_idx]) return res.status(400).json({ error: 'invalid variant_idx' });
  const state = await loadState(proj);
  state.picked = state.picked || {};
  state.picked[frame_id] = {
    mediaId: j.lastVariants[variant_idx].mediaId,
    pickedIdx: variant_idx,
    pickedAt: new Date().toISOString(),
    fifeUrl: j.lastVariants[variant_idx].fifeUrl,
  };
  await saveState(proj, state);
  proj.jobs.delete(frame_id);
  broadcastJob(proj);
  console.log(`[job ${proj.slug}] ✓ ${frame_id} picked v${variant_idx + 1}`);
  res.json({ ok: true });
  if (j.mode === 'serial') {
    (async () => { try { await advanceJob(proj, j.frameIdx, 'serial'); } catch (e) { console.error(e.message); } })();
  }
};
app.post('/api/pick', wrapProjectHandler(handlePick));
app.post('/api/p/:slug/pick', wrapProjectHandler(handlePick));

// ─── Skip ───
const handleSkip = async (proj, req, res) => {
  const { frame_id } = req.body || {};
  const target = frame_id || computePrimaryJob(proj).frameId;
  const j = proj.jobs.get(target);
  if (!j) return res.status(404).json({ error: `no active job for ${target}` });
  if (!['waiting_pick', 'failed'].includes(j.status)) return res.status(409).json({ error: `cannot skip in ${j.status}` });
  console.log(`[job ${proj.slug}] ⏭ skip ${target}`);
  proj.jobs.delete(target);
  broadcastJob(proj);
  res.json({ ok: true });
  if (j.mode === 'serial') {
    (async () => { try { await advanceJob(proj, j.frameIdx, 'serial'); } catch (e) { console.error(e.message); } })();
  }
};
app.post('/api/skip', wrapProjectHandler(handleSkip));
app.post('/api/p/:slug/skip', wrapProjectHandler(handleSkip));

// ─── Retry ───
const handleRetry = async (proj, req, res) => {
  const { frame_id } = req.body || {};
  const target = frame_id || computePrimaryJob(proj).frameId;
  const j = proj.jobs.get(target);
  if (!j) return res.status(404).json({ error: `no active job for ${target}` });
  if (!['failed', 'waiting_pick'].includes(j.status)) return res.status(409).json({ error: `cannot retry in ${j.status}` });
  const idx = j.frameIdx;
  const mode = j.mode;
  proj.jobs.delete(target);
  console.log(`[job ${proj.slug}] ↻ retry ${target}`);
  res.json({ ok: true });
  // Re-enqueue
  proj.queue.push({ frameIdx: idx, frame_id: target, mode });
  runDispatcher(proj).catch(e => console.error(e.message));
};
app.post('/api/retry', wrapProjectHandler(handleRetry));
app.post('/api/p/:slug/retry', wrapProjectHandler(handleRetry));

// ─── Stop ───
const handleStop = (proj, req, res) => {
  proj.jobAbort = true;
  proj.queue.length = 0;
  proj.dispatching = false; // cờ kẹt từ dispatcher cũ → reset để Gen lần sau chạy được
  for (const j of proj.jobs.values()) if (j.status === 'running') { j.status = 'failed'; j.lastError = 'stopped'; }
  broadcastJob(proj);
  console.log(`[job ${proj.slug}] ■ stop signal sent — queue cleared, abort sau frame đang chạy`);
  res.json({ ok: true });
};
app.post('/api/stop', wrapProjectHandler(handleStop));
app.post('/api/p/:slug/stop', wrapProjectHandler(handleStop));

// ─── Reset ───
const handleReset = async (proj, req, res) => {
  await saveState(proj, { picked: {}, resetAt: new Date().toISOString() });
  proj.jobs.clear();
  proj.queue.length = 0;
  proj.jobAbort = false;
  proj.dispatching = false; // cờ kẹt → reset để dispatcher chạy lại được
  broadcastJob(proj);
  console.log(`[job ${proj.slug}] ⌫ reset state.json + jobs`);
  res.json({ ok: true });
};
app.post('/api/reset', wrapProjectHandler(handleReset));
app.post('/api/p/:slug/reset', wrapProjectHandler(handleReset));

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
    // Apply project change immediately — sync default project state + projects.json registry
    if (updates.projectId && updates.projectId !== PROJECT_ID) {
      PROJECT_ID = updates.projectId;
      PROJECT_URL = `https://labs.google/fx/tools/flow/project/${PROJECT_ID}`;
      const dp = defaultProject();
      if (dp) {
        dp.projectId = PROJECT_ID;
        dp.projectUrl = PROJECT_URL;
      }
      // Persist vào projects.json registry để survive restart
      try {
        const reg = loadProjectsRegistry();
        const entry = (reg.projects || []).find(p => p.slug === 'default');
        if (entry) {
          entry.projectId = PROJECT_ID;
          saveProjectsRegistry(reg);
          console.log(`[config] synced default projectId → projects.json`);
        }
      } catch (e) { console.error(`[config] sync registry fail: ${e.message}`); }
      // Re-nav chỉ workers của default project
      for (const w of (dp?.pagePool || [])) {
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

// Helper: đảm bảo default project có ít nhất 1 page sống. Dùng cho setup wizard.
// Handle ctx chết hoàn toàn (clear ctxByProfile cache + relaunch).
const ensureLivePage = async () => {
  const dp = defaultProject();
  if (!dp) throw new Error('No default project');
  const sharedAbsProfile = path.resolve(USER_DATA_DIR);

  // Probe ctx alive
  let ctxAlive = false;
  try {
    if (ctx) { ctx.pages(); ctxAlive = true; }
  } catch { ctxAlive = false; }

  if (!ctxAlive) {
    console.warn('[recover] global ctx died → relaunching persistent context');
    // Clear stale entry in cache
    ctxByProfile.delete(sharedAbsProfile);
    try { await ctx?.close(); } catch {}
    // Reset all default project's worker references (pages were tied to dead ctx)
    dp.pagePool.length = 0;
    ctx = await launchCtx(sharedAbsProfile);
    dp.ctx = ctx;
    const p = ctx.pages()[0] || await ctx.newPage();
    dp.pagePool.push({ page: p, busy: false, id: 'default-W1', settingsVerified: false, projectSlug: 'default' });
    console.log('[recover] ctx relaunched, default-W1 ready');
  }

  // Replace any closed pages
  for (const w of dp.pagePool) {
    if (w.page?.isClosed?.()) {
      console.warn(`[recover] ${w.id} page closed → creating new page`);
      try {
        w.page = await ctx.newPage();
        w.settingsVerified = false;
      } catch (e) {
        // If newPage fails, ctx might be dead again → mark for next call
        console.error(`[recover] newPage fail: ${e.message}`);
        ctxAlive = false;
      }
    }
  }
  if (dp.pagePool.length === 0) {
    const p = await ctx.newPage();
    dp.pagePool.push({ page: p, busy: false, id: 'default-W1', settingsVerified: false, projectSlug: 'default' });
  }
  return dp.pagePool[0];
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
const handleUploadReference = async (proj, req, res) => {
  const { filename, base64 } = req.body || {};
  if (!filename || !base64) return res.status(400).json({ error: 'filename + base64 bắt buộc' });
  // Strip data URL prefix nếu có ("data:image/png;base64,...")
  const b64 = base64.replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) return res.status(400).json({ error: 'base64 invalid' });
  if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'File quá lớn (>20MB)' });
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const tsName = new Date().toISOString().replace(/[:.]/g, '-');
  const uploadsDir = path.join(proj.outputDir, '_uploads');
  await fs.mkdir(uploadsDir, { recursive: true });
  const filepath = path.join(uploadsDir, `${tsName}_${safeName}`);
  await fs.writeFile(filepath, buf);
  console.log(`[upload ${proj.slug}] saved ${path.basename(filepath)} (${(buf.length / 1024).toFixed(1)} KB)`);
  res.json({ ok: true, path: filepath, size: buf.length });
};
app.post('/api/upload-reference', wrapProjectHandler(handleUploadReference));
app.post('/api/p/:slug/upload-reference', wrapProjectHandler(handleUploadReference));

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

const closeAllCtx = async () => {
  for (const c of ctxByProfile.values()) {
    try { await c.close(); } catch {}
  }
};
process.on('SIGTERM', async () => { await closeAllCtx(); process.exit(0); });
process.on('SIGINT', async () => { await closeAllCtx(); process.exit(0); });

await initBrowser();
app.listen(PORT, () => {
  console.log(`[server] flow-bot on http://localhost:${PORT}  HEADLESS=${HEADLESS}`);
});
