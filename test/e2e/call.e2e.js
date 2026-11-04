'use strict';

/*
 * End-to-end check with real browsers and fake camera/mic devices.
 *   CHROME_PATH=/path/to/chrome npm run test:e2e
 * Opens three participants in one room and verifies that video, audio,
 * mute/camera state, chat and leaving all propagate.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createServer } = require('../../server');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));

test('three-way call in headless Chrome', { skip: !chromePath && 'no Chrome found (set CHROME_PATH)', timeout: 90_000 }, async (t) => {
  const puppeteer = require('puppeteer-core');
  const ctx = createServer({ iceServers: [] }); // host candidates are enough on one machine
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${ctx.server.address().port}`;

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  t.after(async () => {
    await browser.close();
    ctx.io.close();
    await new Promise((r) => ctx.server.close(r));
  });

  const errors = [];
  async function join(name) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', (err) => errors.push(`${name}: ${err.message}`));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`${name}: ${msg.text()}`); });
    await page.goto(`${base}/?room=e2e-room&name=${encodeURIComponent(name)}`);
    // Wait until the camera preview is live, then join.
    await page.waitForFunction(() => {
      const v = document.querySelector('#preview-video');
      return v.srcObject && v.videoWidth > 0;
    });
    await page.click('#join-btn');
    await page.waitForSelector('#room:not([hidden])');
    return page;
  }

  // Every remote tile is showing decoded video and has a live audio track.
  const flowingCheck = (expectedTiles) => {
    const tiles = [...document.querySelectorAll('#grid .tile')];
    if (tiles.length !== expectedTiles) return false;
    return tiles
      .filter((tile) => !tile.classList.contains('self'))
      .every((tile) => {
        const v = tile.querySelector('video');
        const s = v.srcObject;
        return (
          !tile.classList.contains('no-video') &&
          v.videoWidth > 0 &&
          s && s.getAudioTracks().some((tr) => tr.readyState === 'live')
        );
      });
  };
  // Puppeteer serializes the predicate, so the tile count goes in as an argument, not a closure.
  const waitForMedia = (page, tiles, timeout) =>
    page.waitForFunction(flowingCheck, { timeout }, tiles).catch(async (err) => {
      const snapshot = await page.evaluate(() => ({
        app: window.webtalkDebug(),
        tiles: [...document.querySelectorAll('#grid .tile')].map((t) => ({
          cls: t.className,
          videoWidth: t.querySelector('video').videoWidth,
        })),
      }));
      console.error(JSON.stringify({ ...snapshot, errors }, null, 2));
      throw err;
    });

  const alice = await join('Alice');
  const bob = await join('Bob');

  await waitForMedia(alice, 2, 20_000);
  await waitForMedia(bob, 2, 20_000);

  // Chat: Bob writes, Alice sees it with an unread badge.
  await bob.click('#chat-btn');
  await bob.type('#chat-input', 'Merhaba Alice! <script>x</script>');
  await bob.keyboard.press('Enter');
  await alice.waitForFunction(() => !document.querySelector('#unread').hidden);
  const aliceMsg = await alice.$eval('#messages .msg:not(.system):last-child .body', (n) => n.textContent);
  assert.equal(aliceMsg, 'Merhaba Alice! <script>x</script>');
  await bob.waitForFunction(() => document.querySelector('#messages .msg.mine'));

  // Alice mutes and turns camera off: Bob's tile for her reflects that.
  await alice.click('#mic-btn');
  await alice.click('#cam-btn');
  await bob.waitForFunction(() => {
    const tile = [...document.querySelectorAll('#grid .tile:not(.self)')][0];
    return tile.classList.contains('no-video') && !tile.querySelector('.mic-off').hidden;
  });
  // ...and back on (camera is re-acquired, track replaced without renegotiation).
  await alice.click('#mic-btn');
  await alice.click('#cam-btn');
  await waitForMedia(bob, 2, 20_000);
  await bob.waitForFunction(() => document.querySelector('#grid .tile:not(.self) .mic-off').hidden);

  // Third participant joins: full mesh.
  const carol = await join('Carol');
  for (const page of [alice, bob, carol]) await waitForMedia(page, 3, 25_000);

  await alice.screenshot({ path: process.env.E2E_SCREENSHOT || path.join(require('os').tmpdir(), 'webtalk-e2e.png') });

  // Bob leaves: others drop to two tiles, Bob is back in the lobby.
  await bob.click('#leave-btn');
  await bob.waitForSelector('#lobby:not([hidden])');
  await alice.waitForFunction(() => document.querySelectorAll('#grid .tile').length === 2);
  await carol.waitForFunction(() => document.querySelectorAll('#grid .tile').length === 2);
  assert.equal(ctx.rooms.size('e2e-room'), 2);

  assert.deepEqual(errors, []);
});

test('participant without camera/mic still receives media', { skip: !chromePath && 'no Chrome found (set CHROME_PATH)', timeout: 90_000 }, async (t) => {
  const puppeteer = require('puppeteer-core');
  const ctx = createServer({ iceServers: [] });
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${ctx.server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  t.after(async () => {
    await browser.close();
    ctx.io.close();
    await new Promise((r) => ctx.server.close(r));
  });

  async function join(name, { denyMedia = false } = {}) {
    const page = await (await browser.createBrowserContext()).newPage();
    if (denyMedia) {
      await page.evaluateOnNewDocument(() => {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
      });
    }
    await page.goto(`${base}/?room=no-media&name=${name}`);
    await page.waitForFunction(() => document.querySelector('#preview-status').textContent.length > 0);
    await new Promise((r) => setTimeout(r, denyMedia ? 300 : 0));
    if (!denyMedia) await page.waitForFunction(() => document.querySelector('#preview-video').videoWidth > 0);
    await page.click('#join-btn');
    await page.waitForSelector('#room:not([hidden])');
    return page;
  }

  // Tile for `name` shows video (or the avatar when `avatar` is true).
  const tileShows = (name, avatar) => {
    const tile = [...document.querySelectorAll('#grid .tile')].find((t) => t.querySelector('.name').textContent === name);
    if (!tile) return false;
    const v = tile.querySelector('video');
    return avatar ? tile.classList.contains('no-video') : !tile.classList.contains('no-video') && v.videoWidth > 0;
  };

  const viewer = await join('Viewer', { denyMedia: true }); // first in the room, no devices
  const alice = await join('Alice'); // Alice initiates towards the viewer
  await viewer.waitForFunction(tileShows, { timeout: 20_000 }, 'Alice', false);
  await alice.waitForFunction(tileShows, { timeout: 20_000 }, 'Viewer', true);

  const late = await (await browser.createBrowserContext()).newPage(); // newcomer without devices initiates
  await late.evaluateOnNewDocument(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
  });
  await late.goto(`${base}/?room=no-media&name=Late`);
  await new Promise((r) => setTimeout(r, 300));
  await late.click('#join-btn');
  await late.waitForFunction(tileShows, { timeout: 20_000 }, 'Alice', false);
  await late.waitForFunction(() => document.querySelectorAll('#grid .tile').length === 3);
  assert.equal(await late.$eval('#mic-btn', (b) => b.getAttribute('aria-pressed')), 'false');
});
