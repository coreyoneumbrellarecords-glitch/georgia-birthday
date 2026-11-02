// Walk every chapter at mobile + desktop sizes with a fake mic. Fails on any console error or uncaught exception.
// Run: node tests/walkthrough.mjs   (screenshots land in ./screenshots)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'screenshots');
await rm(shots, { recursive: true, force: true });
await mkdir(shots, { recursive: true });

const server = createServer(async (req, res) => {
  try {
    const body = await readFile(path.join(root, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  } catch (e) { res.writeHead(500).end(String(e)); }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/?fast`;

// sustained white noise stands in for someone blowing on the mic
const blowWav = path.join(os.tmpdir(), 'gb-blow.wav');
{
  const rate = 16000, n = rate * 20, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round((Math.random() * 2 - 1) * 12000), 44 + i * 2);
  await writeFile(blowWav, buf);
}
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${blowWav}`, '--autoplay-policy=no-user-gesture-required'],
});
const failures = [];

async function run(label, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1, permissions: ['microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  let n = 0;
  const shot = async (name) => page.screenshot({ path: path.join(shots, `${label}-${String(++n).padStart(2, '0')}-${name}.png`) });
  const cur = () => page.evaluate(() => window.__gb.cur());
  const waitCh = (i) => page.waitForFunction((i) => window.__gb.cur() === i, i, { timeout: 15000 });
  const waitDone = () => page.waitForFunction(() => document.querySelector('#skipCh').textContent.includes('Continue'), null, { timeout: 30000 });
  const tap = (sel) => page.locator(sel).click();
  const step = async (name, fn) => {
    try { await fn(); } catch (e) { errors.push(`step "${name}" failed: ${e.message.split('\n')[0]}`); await shot(`FAIL-${name}`).catch(() => {}); throw e; }
  };

  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    await step('gate', async () => {
      await shot('gate');
      await page.mouse.click(viewport.width / 2, viewport.height * 0.8); // tap the gates (also unlocks audio)
      await page.waitForTimeout(700);
      await shot('gate-opening');
      await waitCh(1);
    });

    await step('clock', async () => {
      await page.waitForFunction(() => +document.querySelector('#tollNum').textContent >= 6, null, { timeout: 15000 });
      await shot('clock-tolling');
      await tap('#replayCh'); // replay the chapter mid-way
      await page.waitForFunction(() => document.querySelector('#tollNum').textContent === '0');
      await waitDone();
      if ((await page.textContent('#tollNum')) !== '26') throw new Error('clock did not reach 26');
      await shot('clock-26');
      await tap('#skipCh'); await waitCh(2);
    });

    await step('tarot', async () => {
      await page.waitForTimeout(500);
      for (const c of await page.locator('.tarot').all()) { await c.click(); await page.waitForTimeout(250); }
      await page.waitForTimeout(900);
      await shot('tarot');
      await waitDone();
      await tap('#skipCh'); await waitCh(3);
    });

    await step('seance', async () => {
      await page.waitForFunction(() => document.querySelector('#spelled').textContent.length >= 6, null, { timeout: 15000 });
      await shot('seance-spelling');
      await waitDone();
      const spelled = (await page.textContent('#spelled')).trim();
      if (spelled !== 'HAPPY BIRTHDAY GEORGIA') throw new Error(`seance spelled "${spelled}"`);
      await shot('seance-done');
      await tap('#skipCh'); await waitCh(4);
    });

    await step('cake', async () => {
      await page.waitForTimeout(800);
      await shot('cake-lit');
      await tap('#micBtn');
      const peak = await page.evaluate(() => new Promise((r) => { let m = 0; const t0 = performance.now(); (function f() {
        const v = +(/scaleX\(([\d.]+)\)/.exec(document.querySelector('#micFill').style.transform) || [0, 0])[1]; m = Math.max(m, v);
        performance.now() - t0 < 2500 ? requestAnimationFrame(f) : r(m); })(); }));
      console.log(`  [${label}] mic meter peak level ${peak.toFixed(2)}`);
      if (!(peak > 0)) throw new Error('mic stream produced no signal');
      const lit = await page.locator('.c:not(.out)').count();
      console.log(`  [${label}] fake mic snuffed ${26 - lit}/26 candles`);
      if (lit > 0) {
        await page.locator('#cake').click({ position: { x: 150, y: 120 } }); // tap-to-snuff path
        await page.waitForTimeout(300);
        if (await page.locator('.c:not(.out)').count() >= lit) throw new Error('tap did not snuff a candle');
        await tap('#blowBtn');
      }
      await page.waitForTimeout(700);
      await shot('cake-blackout');
      await waitDone();
      await shot('cake-after');
      await tap('#skipCh'); await waitCh(5);
    });

    await step('grimoire', async () => {
      await page.waitForTimeout(800);
      await shot('grimoire-cover');
      await tap('#cover'); await page.waitForTimeout(1300);
      await page.locator('#seal').click({ force: true }); // it pulses forever, so never "stable"
      await page.waitForTimeout(3000);
      if (!(await page.locator('#letter.reading-ink').count())) throw new Error('seal did not start the letter');
      await shot('grimoire-letter');
      await tap('#pgNext'); await page.waitForTimeout(3500);
      await shot('grimoire-reasons');
      await tap('#pgNext'); await page.waitForTimeout(1300);
      await page.fill('#wishText', 'A year as loud and lovely as she is');
      await tap('#burnBtn'); await page.waitForTimeout(1200);
      await shot('grimoire-wish-burning');
      await page.waitForTimeout(2500);
      await tap('#pgNext'); await page.waitForTimeout(1300);
      const stars = page.locator('.star');
      if ((await stars.count()) !== 26) throw new Error('expected 26 stars');
      for (const i of [0, 7, 19]) { await stars.nth(i).click({ force: true }); await page.waitForTimeout(200); }
      if (!(await page.textContent('#starCount')).startsWith('3 /')) throw new Error('star taps not counted');
      await shot('grimoire-stars');
      await page.keyboard.press('ArrowRight'); await page.waitForTimeout(1300); // keyboard page turn
      await shot('grimoire-last');
      await tap('#toFinale'); await waitCh(6);
    });

    await step('finale', async () => {
      await page.waitForSelector('#finaleBtns.show', { timeout: 15000 });
      await page.waitForTimeout(1500);
      await shot('finale');
      await tap('#secretBtn'); await page.waitForTimeout(800);
      if (await page.locator('#egg').isHidden()) throw new Error('secret button did not open egg');
      await shot('easter-egg');
      await tap('#eggClose');
      for (const k of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']) await page.keyboard.press(k);
      await page.waitForTimeout(300);
      if (await page.locator('#egg').isHidden()) throw new Error('konami code did not open egg');
      await page.keyboard.press('Escape');
      await tap('#muteBtn');
      if ((await page.evaluate(() => localStorage.getItem('gb-muted'))) !== '1') throw new Error('mute not stored');
      await tap('#muteBtn');
    });

    await step('navigation', async () => {
      await page.locator('.node').nth(3).click(); await waitCh(3); // jump via progress sigil
      await page.locator('.node').nth(6).click(); await waitCh(6);
      await page.waitForSelector('#finaleBtns.show', { timeout: 15000 });
      await tap('#replayAll'); await waitCh(0);
      await page.waitForTimeout(500);
      // moon easter egg: 6 taps
      const moon = await page.evaluate(() => { const w = innerWidth, h = innerHeight; return { x: w * (w < 600 ? 0.8 : 0.78), y: h * (w < 600 ? 0.082 : 0.16) }; });
      for (let i = 0; i < 6; i++) { await page.mouse.click(moon.x, moon.y); await page.waitForTimeout(80); }
      if (await page.locator('#egg').isHidden()) throw new Error('moon taps did not open egg');
      await tap('#eggClose');
    });
  } catch (e) { /* recorded in errors */ }

  await ctx.close();
  console.log(`${errors.length ? '✗' : '✓'} ${label} ${viewport.width}x${viewport.height}: ${n} screenshots${errors.length ? '' : ', no errors'}`);
  errors.forEach((e) => console.log('   ' + e));
  failures.push(...errors.map((e) => `${label}: ${e}`));
}

await run('mobile', { width: 390, height: 844 }, true);
await run('desktop', { width: 1440, height: 900 }, false);
await browser.close();
server.close();
process.exit(failures.length ? 1 : 0);
