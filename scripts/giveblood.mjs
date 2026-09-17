#!/usr/bin/env node
/**
 * giveblood — NHS Give Blood auto driver.
 * Harness-neutral: run from ANY agent (Hermes, opencode, Claude Code, or plain
 * terminal). Zero LLM tokens on the happy path — everything is deterministic
 * Playwright automation; stdout is the only interface.
 *
 * Usage:
 *   giveblood login                         authenticate + persist session cookie
 *   giveblood check                         print next available slots (plain text / --json)
 *   giveblood book <slot-ref|"datetime">    book/reschedule a slot
 *   giveblood status                        print current appointment + eligibility
 *   giveblood next                          print next eligible donation date
 *
 * Credentials (NEVER committed, never echoed, never in chat):
 *   source 1: env        GIVEBLOOD_EMAIL / GIVEBLOOD_PASSWORD (one-shot scoped to a process)
 *   source 2: local file ~/.config/giveblood/.env  (Keni-created, chmod 600, out-of-band):
 *                GIVEBLOOD_EMAIL=...
 *                GIVEBLOOD_PASSWORD=...
 *   Process env wins over the .env file. No JSON credential file; no interactive
 *   password prompt (password never touches this script's stdin or the transcript).
 *   Only the authenticated SESSION cookie persists (revocable, ~30 days), in
 *   ~/.config/giveblood/profile (chmod 600) — the password itself is never at rest.
 *
 * One-time security code (new device login): set GIVEBLOOD_OTP (env or .env) for
 * that run, or the script pauses and reads the code from stdin (the code is a
 * short-lived one-time value, not the password). Never stored.
 */

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

// Resolve the globally-installed @playwright/test (this repo is deliberately
// dependency-free so it runs from any harness; nothing is npm-installed locally).
const globalRoot = execSync('npm root -g').toString().trim();
const require = createRequire(import.meta.url);
const { chromium } = require(globalRoot + '/@playwright/test');

const HOME = process.env.HOME || '/home/keni';
const CFG = `${HOME}/.config/giveblood`;
const PROFILE_DIR = `${CFG}/profile`;
const BASE = 'https://my.blood.co.uk';
const LOGIN_URL = `${BASE}/your-account/login`;
const APPTS_URL = `${BASE}/your-account/appointments`;
const HOME_TOWN = process.env.GIVEBLOOD_HOME_TOWN || 'Bedford';   // user's nearest-location variable
const deferralDays = () => parseInt(process.env.GIVEBLOOD_DEFERRAL_DAYS || '84', 10);   // men 84 / women 112 (lazy: env/.env loaded first)

const MONTH_ID = { january:0, february:1, march:2, april:3, may:4, june:5, july:6, august:7, september:8, october:9, november:10, december:11 };
function parseUKDate(s) {   // "Monday 2 November 2026" -> Date
  const m = /[A-Za-z]+\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(s || '');
  if (!m) return null;
  const mon = MONTH_ID[m[2].toLowerCase()];
  if (mon === undefined) return null;
  return new Date(Date.UTC(+m[3], mon, +m[1]));
}
const iso = (d) => d ? d.toISOString().slice(0, 10) : '';

const JSON_OUT = process.argv.includes('--json');

function info(obj, extra = '') {
  if (JSON_OUT) process.stdout.write(JSON.stringify(obj) + '\n');
  else process.stdout.write(extra + '\n');
}

async function loadDotEnv() {
  const fs = await import('node:fs');
  const p = `${CFG}/.env`;
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, 'utf8');
  for (const line of raw.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const [, key, val] = m;
    if (!(key in process.env)) process.env[key] = val.replace(/^["']|["']$/g, '');
  }
}

async function loadCreds() {
  await loadDotEnv();
  const email = process.env.GIVEBLOOD_EMAIL;
  const pw = process.env.GIVEBLOOD_PASSWORD;
  if (email && pw) return { email, password: pw };
  console.error(
    'giveblood: no credentials. Set GIVEBLOOD_EMAIL + GIVEBLOOD_PASSWORD in the\n' +
    '  environment for this process, or create ~/.config/giveblood/.env (chmod 600).\n' +
    'The password is never stored by this script beyond that source.'
  );
  process.exit(2);
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) { console.error('usage: giveblood login|check|book|status|next [--json]'); process.exit(1); }

  const creds = await loadCreds();
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    acceptDownloads: false,
  });
  const page = browser.pages()[0] || await browser.newPage();

  let authResp = null;
  page.on('response', (r) => {
    if (r.url().includes('/api/auth/v2/login')) {
      // status only — never capture the access/refresh token body to the console
      authResp = { status: r.status() };
    }
  });

  const utils = {
    async gotoAuthed(url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (page.url().includes('/login')) {
        await utils.login();
        if (page.url().includes('/login')) { await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}); }
      }
    },
    async login() {
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
      // dismiss the cookie banner if present
      for (const label of ['Accept additional cookies']) {
        const b = page.getByRole('button', { name: label });
        if (await b.count()) await b.first().click().catch(() => {});
      }
      await utils.fillEmail(creds.email);
      await page.locator('input[type="password"]').first().fill(creds.password);
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});

      let otpDone = false;
      let stable = 0;
      const seen = [];
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(500);
        const url = page.url();
        const path = new URL(url).pathname;
        if (seen[seen.length - 1] !== path) seen.push(path);
        // authenticated = on a non-login page that STAYS there (2 consecutive ticks)
        if (!/\/login/.test(path) && !/queue/i.test(path)) {
          stable++;
          if (stable >= 2) return;
        } else stable = 0;
        // one-time security code field?
        const otp = page.locator('input[autocomplete="one-time-code"], input[name*="code" i], input[inputmode="numeric"], input[type="text"][maxlength="6"]');
        if (!otpDone && await otp.count()) {
          let code = process.env.GIVEBLOOD_OTP;
          if (!code) {
            process.stdout.write('OTP_CODE_PROMPT\n');
            const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin });
            code = (await rl[Symbol.asyncIterator]().next()).value?.trim();
            rl.close();
          }
          if (code) { await otp.first().fill(code); await page.keyboard.press('Enter'); otpDone = true; }
          continue;
        }
        const body = await page.locator('body').innerText().catch(() => '');
        const err = /(incorrect|does not (match|exist)|not been recognised|locked|too many|verify your email|invalid)/i.exec(body);
        if (err && !otpDone) {
          console.error('LOGIN_FAILED: ' + err[0]);
          console.error('AUTH_RESP: ' + JSON.stringify(authResp));
          return;
        }
      }
      console.error('LOGIN_TIMEOUT: still on ' + page.url());
      console.error('AUTH_RESP: ' + JSON.stringify(authResp));
      console.error('PATH_DANCE: ' + seen.join(' -> '));
      const body = await page.locator('body').innerText().catch(() => '');
      const m = body.replace(/\s+/g, ' ').match(/(.{0,80}(incorrect|invalid|failed|not|error|lock|secur|account).{0,80})/i);
      if (m) console.error('PAGE_MSG: ' + m[1]);
    },
    async fillEmail(email) {
      await page.getByLabel('Email address').fill(email).catch(async () => {
        await page.locator('input[type="email"], input#email, input[name="email"]').first().fill(email);
      });
    },
    slug(str) { return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); },
    async waitContent() {
      await page.waitForFunction((min) => document.body && document.body.innerText.trim().length > min, 40, { timeout: 15000 }).catch(() => {});
    },
    async autoLoginGoto(url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (page.url().includes('/login')) { await utils.login(); }
      await page.waitForTimeout(800);
    },
    async searchVenues(town) {
      // the booking SPA nondeterministically renders an empty shell (Queue-it/hydration):
      // retry the whole bootstrap+search until a real venues list comes back.
      for (let n = 1; n <= 4; n++) {
        try {
          await utils.gotoAuthed(APPTS_URL);            // bootstrap SPA shell first
          await utils.gotoAuthed(BASE + '/your-account/appointments/book/search/');
          await page.waitForSelector('input[name="searchCriteria"], input[type="text"]', { timeout: 14000 });
          const box = page.locator('input[name="searchCriteria"], input[type="text"]').first();
          await box.fill(town);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(1500);
          if (page.url().includes('location-results')) {
            const m = page.locator('a[href*="donation-venues"]').last();   // prefer the real regional match
            if (await m.count()) { await m.click(); await page.waitForTimeout(700); }
          }
          await page.waitForTimeout(1400);
          const r = await page.evaluate(() => ({
            url: location.href,
            body: document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 4000) : '',
          }));
          if (process.env.GIVEBLOOD_DEBUG) console.error('SEARCH_URL=' + r.url + '\nSEARCH_TXT=' + (r.body || '').slice(0, 1600));
          const venues = utils.parseVenues(r.body || '');
          if (venues.length) return venues;
          await page.waitForTimeout(1200);
        } catch (e) {
          if (process.env.GIVEBLOOD_DEBUG) console.error(`searchVenues retry ${n}: ${e && e.message}`);
        }
      }
      return [];
    },
    parseVenues(txt) {
      const venues = [];
      const bigRe = /([\d.]+)\s+miles\s+away\s+([A-Za-z][A-Za-z .,'\u2019-\d]*?)\s+Appointments from ([A-Za-z]+ \d{1,2} [A-Za-z]+ \d{4})/g;
      let mm;
      while ((mm = bigRe.exec(txt))) {
        const descr = mm[2].replace(/\s+/g, ' ').trim();
        const segs = descr.split(',').map(s => s.trim()).filter(Boolean);
        let name = '', best = 0;
        for (const s of segs) {
          const words = s.split(/\s+/).filter(w => /^[A-Za-z'\u2019-]+$/.test(w));
          if (words.length > best) { name = words.join(' '); best = words.length; }
        }
        if (!name || /view on google|donation venues|sort by|filter|nearest|recommended|soonest/i.test(name)) continue;
        venues.push({ name, distance: parseFloat(mm[1]), date: mm[3], dateLabel: mm[3] });
      }
      const seen = new Set();
      return venues.filter(v => (seen.has(v.name) ? false : seen.add(v.name)));
    },
    async drillVenueDates(town, venueName) {
      // search again, click the target venue -> choose-date, then earliest date -> choose-appointment
      await utils.gotoAuthed(APPTS_URL);
      await utils.gotoAuthed(BASE + '/your-account/appointments/book/search/');
      await page.locator('input[name="searchCriteria"], input[type="text"]').first().fill(town);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
      if (page.url().includes('location-results')) {
        const m = page.locator('a[href*="donation-venues"]').last();
        if (await m.count()) { await m.click(); await page.waitForTimeout(700); }
      }
      await page.waitForTimeout(1200);   // click venue inside the ~3s render window
      let clicked = false;
      const vCard = page.locator('a[href*="choose-date"]').first();
      if (await vCard.count()) { await vCard.click(); clicked = true; await page.waitForTimeout(2600); }
      else {
        const card = page.locator('a,button,[role=button],[tabindex]').filter({ hasText: venueName }).first();
        if (await card.count()) { await card.click(); clicked = true; await page.waitForTimeout(2600); }
      }
      // choose-date: parse day-hours rows
      let bodyD = await page.evaluate(() => document.body ? document.body.innerText : '');
      const dates = [];
      const dayRe = /([A-Za-z]+ \d{1,2} [A-Za-z]+ \d{4})\s+Open from ([\d:.apm\s]+) to ([\d:.apm\s]+)/g;
      let dm;
      while ((dm = dayRe.exec(bodyD))) dates.push({ label: dm[1], hours: `Open ${dm[2].trim()}–${dm[3].trim()}` });
      // earliest date -> choose-appointment
      let times = [];
      let bodyT = '';
      const dateLink = page.locator('a[href*="choose-appointment"]').first();
      if (await dateLink.count()) {
        await dateLink.click(); await page.waitForTimeout(2600);
        bodyT = await page.evaluate(() => document.body ? document.body.innerText : '');
        const timeRe = /(?:^|\s)(\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b)/gi;
        times = [...new Set([...bodyT.matchAll(timeRe)].map(m => m[1].toLowerCase()))];
        if (process.env.GIVEBLOOD_DEBUG) {
          const ctrl = await page.evaluate(() => ({
            url: location.href,
            radios: Array.from(document.querySelectorAll('input[type=radio]')).map(x => ({ v: x.value, label: (x.closest('label')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50), checked: x.checked, name: x.name })),
            checks: Array.from(document.querySelectorAll('input[type=checkbox]')).map(x => ({ label: (x.closest('label')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50), checked: x.checked })),
            buttons: Array.from(document.querySelectorAll('button')).map(b => ({ t: (b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), type: b.type || '' })).filter(b => b.t),
            links: Array.from(document.querySelectorAll('a[href]')).map(a => ({ t: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50), href: a.getAttribute('href') })).filter(l => !/cookie|facebook|twitter|youtube|instagram|privacy|accessibility|terms|0300|sitemap|blog\./.test(l.t) && !l.href.includes('blood.co.uk/') && l.href !== ''),
            body: (document.body ? document.body.innerText : '').slice(0, 1600),
          }));
          console.error('APPT_SCREEN=' + JSON.stringify(ctrl, null, 1));
        }
      }
      return { venue: venueName, clicked, dates, earliest: dates[0] ? dates[0].label : null, times, url: page.url() };
    },
    async toReview(town, wantTime) {
      // full in-flow walk through the booking wizard to the confirm screen
      await utils.gotoAuthed(APPTS_URL);
      await utils.gotoAuthed(BASE + '/your-account/appointments/book/search/');
      await page.locator('input[name="searchCriteria"], input[type="text"]').first().fill(town);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
      if (page.url().includes('location-results')) {
        const m = page.locator('a[href*="donation-venues"]').last();
        if (await m.count()) { await m.click(); await page.waitForTimeout(700); }
      }
      await page.waitForTimeout(1200);
      const vCard = page.locator('a[href*="choose-date"]').first();
      if (await vCard.count()) { await vCard.click(); await page.waitForTimeout(2400); }
      const dt = page.locator('a[href*="choose-appointment"]').first();
      if (await dt.count()) { await dt.click(); await page.waitForTimeout(2400); }
      // pick a slot (default earliest); expand accordion until one is visible, then click in-flow
      let clickedSlot = false;
      const want = (wantTime || '').toLowerCase();
      const slotBase = page.locator('a[href*="check-appointment-details"]');
      const pick = want ? slotBase.filter({ hasText: want }) : slotBase;
      for (let attempt = 0; attempt < 3 && !clickedSlot; attempt++) {
        const total = await pick.count();
        for (let i = 0; i < total; i++) {
          const el = pick.nth(i);
          if (await el.isVisible().catch(() => false)) {
            await el.scrollIntoViewIfNeeded().catch(() => {});
            await el.click({ timeout: 9000, noWaitAfter: true }).catch(async () => { await el.evaluate(o => o.click()); });
            clickedSlot = true;
            break;
          }
        }
        if (!clickedSlot) {
          const expander = page.locator('button:has-text("Afternoon"), button:has-text("Evening"), [role=button]:has-text("Afternoon"), [role=button]:has-text("Evening"), button:has-text("Show all"), button:has-text("Show more")').first();
          if (await expander.count()) { await expander.click({ noWaitAfter: true }).catch(() => {}); await page.waitForTimeout(1200); }
        }
      }
      if (!clickedSlot) { try { await pick.first().click({ force: true, timeout: 8000, noWaitAfter: true }).catch(() => {}); clickedSlot = true; } catch (e) {} }
      await page.waitForTimeout(3000);
      const body = await page.evaluate(() => document.body ? document.body.innerText : '');
      // parse New/Existing appointment date+time cleanly
      const fmtBlock = (label) => {
        const i = body.indexOf(label);
        if (i < 0) return '';
        const seg = body.slice(i, i + 340);
        const m = /([A-Za-z]+ \d{1,2} [A-Za-z]+ \d{4})\s*(\d{1,2}:\d{2}(?:am|pm))/i.exec(seg);
        return m ? `${m[1]} ${m[2].toLowerCase()}` : seg.replace(/\s+/g, ' ').trim().split('Donation type')[0];
      };
      return {
        clickedSlot,
        reviewUrl: page.url(),
        body: body.slice(0, 2200),
        hasConfirmButton: /confirm and book appointment/i.test(body),
        newAppt: fmtBlock('New appointment'),
        existingAppt: fmtBlock('Existing appointment'),
        tooClose: /too close together|replace your existing/i.test(body),
      };
    },
    async currentAppointment() {
      await utils.gotoAuthed(APPTS_URL);
      let body = '';
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(600);
        body = await page.evaluate(() => document.body ? document.body.innerText : '');
        if (/[A-Za-z]+ \d{1,2} [A-Za-z]+ \d{4}|appointments?|November|book/i.test(body) && body.length > 200) break;
      }
      if (process.env.GIVEBLOOD_DEBUG) console.error('APPT_PAGE=' + JSON.stringify({ url: page.url(), body: body.slice(0, 1200) }));
      const dates = [...new Set([...body.matchAll(/[A-Za-z]+ \d{1,2} [A-Za-z]+ \d{4}/g)].map(m => m[0]))];
      let best = null, bestD = Infinity;
      for (const d of dates) { const t = parseUKDate(d); if (t && t.getTime() < bestD) { best = d; bestD = t.getTime(); } }
      const timeM = /(\d{1,2}:\d{2}(?:am|pm))/i.exec(body);
      return { date: best, time: timeM ? timeM[1].toLowerCase() : '', body: body.slice(0, 700) };
    },
    async topSlots(town, afterDate, n) {
      // top-n earliest (date, time) slots at the nearest venue, on/after afterDate
      afterDate = afterDate || null;
      n = n || 3;
      await utils.gotoAuthed(APPTS_URL);
      await utils.gotoAuthed(BASE + '/your-account/appointments/book/search/');
      await page.locator('input[name="searchCriteria"], input[type="text"]').first().fill(town);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
      if (page.url().includes('location-results')) {
        const m = page.locator('a[href*="donation-venues"]').last();
        if (await m.count()) { await m.click(); await page.waitForTimeout(700); }
      }
      await page.waitForTimeout(1200);
      const vCard = page.locator('a[href*="choose-date"]').first();
      if (await vCard.count()) { await vCard.click(); await page.waitForTimeout(2400); }
      const dayLinks = page.locator('a[href*="choose-appointment"]');
      const total = await dayLinks.count();
      const out = [];
      for (let i = 0; i < total && out.length < n; i++) {
        const label = (await dayLinks.nth(i).innerText()).replace(/\s+/g, ' ').trim();
        const dt = parseUKDate(label);
        let dLabel = label;
        if (dt && afterDate && dt.getTime() < afterDate.getTime()) continue;
        // read the date's earliest time without leaving the page: grab the sessionTime from href
        let href = await dayLinks.nth(i).getAttribute('href').catch(() => null);
        let time = '';
        const st = /sessionTime=([A-Za-z 0-9:]+)/.exec(href || '');
        if (st) { const h = st[1]; time = `${h.slice(-4).slice(0,2)}:${h.slice(-2)}`; }
        out.push({ date: label, time });
      }
      return out;
    },
    async toTimes(town, venueRe, dateRe) {
      await utils.autoLoginGoto(APPTS_URL);   // bootstrap SPA shell
      await utils.autoLoginGoto(BASE + '/your-account/appointments/book/search/');
      await page.locator('input[name="searchCriteria"], input[type="text"]').first().fill(town);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2800);
      if (page.url().includes('location-results')) {
        const m = page.locator('a[href*="donation-venues"]').last();
        if (await m.count()) { await m.click(); await page.waitForTimeout(2000); }
      }
      await page.waitForFunction(() => {
        const t = document.body && document.body.innerText;
        return t && (/Appointments from|venues? found|no (more )?(results|venues)/i.test(t));
      }, { timeout: 12000 }).catch(() => {});
      // choose venue
      let venueName = null;
      if (venueRe) {
        const card = page.locator(`text=/${venueRe.source}/`).locator('xpath=ancestor::*[1]');
        // fallback: click by text
        const byText = page.locator(`*:has-text("${venueRe.source}")`).first();
        // simpler: pick the first element whose text matches and is clickable
        const clickable = page.locator('a,button,[role=button],[tabindex]').filter({ hasText: venueRe.source }).first();
        if (await clickable.count()) { await clickable.click(); venueName = venueRe.source; await page.waitForTimeout(3600); }
      } else {
        // click the first venue card (first heading under results)
        const first = page.locator('a,button,[role=button]').filter({ hasText: /Appointments from/ }).locator('..').first();
        // fallback to the first "Appointments from" container's clickable ancestor
        const anyCard = page.locator('h3, [class*=card], [class*=venue]').filter({ hasText: /Appointments from|miles away/ }).first();
        if (await anyCard.count()) { await anyCard.click(); venueName = 'first venue'; await page.waitForTimeout(3600); }
      }
      // choose date
      const dateLink = page.locator('a[href*="choose-appointment"]').first();
      if (await dateLink.count()) { await dateLink.click(); await page.waitForTimeout(3600); }
      const url = page.url();
      const txt = await page.locator('body').innerText();
      return { venue: venueName || 'selected', url, dateLabel: '', times: txt.replace(/\s+/g, ' ').slice(0, 1600) };
    },
  };

  if (cmd === 'login') {
    await utils.login();
    if (authResp) console.error('AUTH_RESP: ' + JSON.stringify(authResp));
    const cookies = await browser.cookies(BASE).catch(() => []);
    info({ ok: true, url: page.url(), authed: !page.url().includes('/login'), cookieCount: cookies.length,
           cookies: cookies.map(c => c.name), auth: authResp && authResp.status }, 'login run -> ' + page.url() + '  [' + cookies.length + ' cookies]');
  }

  else if (cmd === 'check') {
    const town = process.argv[3] || process.env.GIVEBLOOD_HOME_TOWN || HOME_TOWN;
    const venues = await utils.searchVenues(town);
    venues.sort((a, b) => a.distance - b.distance);   // nearest first
    if (JSON_OUT) { process.stdout.write(JSON.stringify({ town, venues }, null, 2) + '\n'); }
    else {
      if (venues.length === 0) { console.log(`No venues/availability near '${town}'.`); process.exit(0); }
      console.log(`Blood donation venues near ${town} — nearest first, appointments from:`);
      for (const v of venues) console.log(`  • ${v.name} (${v.distance} mi) — ${v.dateLabel}`);
      const nearest = venues[0];
      console.log(`\nNearest (${nearest.name}, ${nearest.distance} mi) — dates & times:`);
      const a = await utils.drillVenueDates(town, nearest.name);
      for (const d of a.dates) console.log(`  ${d.label}  (${d.hours})`);
      if (a.earliest) console.log(`\nEarliest date: ${a.earliest}`);
      if (a.times && a.times.length) console.log(`Available times (earliest date): ${a.times.join(', ')}`);
      else if (!a.clicked) console.log('(could not open the venue detail)');
    }
  }

  else if (cmd === 'book') {
      const town = process.argv[3] || process.env.GIVEBLOOD_HOME_TOWN || HOME_TOWN;
      const wantTime = process.env.GB_TIME || '';
      const confirm = process.argv.includes('--confirm');
      const r = await utils.toReview(town, wantTime);
      if (JSON_OUT) process.stdout.write(JSON.stringify({ town, ...r}, null, 2) + '\n');
      else if (!r.clickedSlot || !r.hasConfirmButton) {
        console.log('Could not reach the booking confirmation screen (SPA render issue). Re-run `giveblood login` then retry.');
      } else {
        console.log('New appointment : ' + (r.newAppt || '?'));
        console.log('Existing appt   : ' + (r.existingAppt || '—'));
        if (r.tooClose) console.log('NOTE: dates are too close — confirming will replace your existing appointment.');
        if (!confirm) {
          console.log('\nNot booked (dry run). Re-run with --confirm to actually book the time above.');
        } else {
          console.log('\nConfirming booking…');
          const btn = page.locator('button:has-text("Confirm and book appointment")').first();
          let clicked = false;
          if (await btn.count()) { await btn.click({ noWaitAfter: true }).catch(() => {}); await page.waitForTimeout(4000); clicked = true; }
          const finalUrl = page.url();
          const finalBody = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
          const ok = /confirmation|booked|confirmed/i.test(finalBody) && !/Login|error/i.test(finalUrl);
                  console.log(clicked
                    ? (ok ? 'BOOKED ✓ — ' + finalUrl : 'Clicked confirm; landed on ' + finalUrl + ' — verify outcome.')
                    : 'Could not find the confirm button on the review screen.');
                  console.log((finalBody || '').slice(0, 500));
                }
              }
            }

            else if (cmd === 'next') {
              // current appointment -> deferral expiry -> top-3 eligible (date,time) at the nearest venue
              const town = process.argv[3] || process.env.GIVEBLOOD_HOME_TOWN || HOME_TOWN;
              const ca = await utils.currentAppointment();
              const apptDate = parseUKDate(ca.date);
              const dur = deferralDays();
              const eligible = apptDate ? new Date(apptDate.getTime() + dur * 86400000) : null;
              if (!apptDate) {
                console.log('Could not read your current appointment from the portal. Re-run `giveblood login` and try again.');
                if (!JSON_OUT) console.log((ca.body || '').slice(0, 300));
              } else {
                const venues = await utils.searchVenues(town);
                venues.sort((a, b) => a.distance - b.distance);
                const nearest = venues[0];
                const lines = [];
                lines.push(`Current appointment : ${ca.date}${ca.time ? ' ' + ca.time : ''}`);
                lines.push(`Deferral (${dur} days) : you can next give blood from ${eligible.toISOString().slice(0, 10)}`);
                if (nearest) {
                  const d = await utils.drillVenueDates(town, nearest.name);
                  const top = d.dates
                    .map(x => ({ ...x, dt: parseUKDate(x.label) }))
                    .filter(x => x.dt && eligible && x.dt.getTime() >= eligible.getTime())
                    .slice(0, 3);
                  lines.push(`Nearest venue (${nearest.name}, ${nearest.distance} mi) — earliest eligible slots:`);
                  if (top.length === 0) lines.push('  (no dates on/after your eligible date were returned)');
                  for (const [i, s] of top.entries()) lines.push(`  ${['1.','2.','3.'][i]} ${s.label}`);
                  const firstTimes = d.times && d.times.length ? d.times.slice(0, 3).join(', ') : '';
                  if (top[0] && firstTimes) lines.push(`Times available on ${top[0].label}: ${firstTimes}`);
                }
                if (JSON_OUT) process.stdout.write(JSON.stringify({ town, current: ca.date, deferralDays: dur, eligible: iso(eligible), nearest: nearest && nearest.name }, null, 2) + '\n');
                else console.log(lines.join('\n'));
              }
            }

  else if (cmd === 'status' || cmd === 'check' || cmd === 'book' || cmd === 'next' || cmd === 'debug-dump' || cmd === 'walk-book' || cmd === 'probe' || cmd === 'venue' || cmd === 'cscreen' || cmd === 'review') {
    if (cmd === 'probe') await utils.gotoAuthed(BASE + (process.env.GB_ROUTE || '/your-account/appointments/book/'));
    else await utils.gotoAuthed(APPTS_URL);
  }

  if (cmd === 'venue') {
    const town = process.argv[3] || 'Leeds';
    await utils.gotoAuthed(BASE + '/your-account/appointments/book/search/');
    await page.locator('input[name="searchCriteria"], input[type="text"]').first().fill(town);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
    const clickTarget = process.env.GB_CLICK;
    if (clickTarget) {
      for (const c of clickTarget.split('|').filter(Boolean)) {
        const loc = page.locator(`a:has-text("${c}"), button:has-text("${c}"), [role=button]:has-text("${c}")`).first();
        if (await loc.count()) { await loc.click(); await page.waitForTimeout(3500); }
        else process.stdout.write(JSON.stringify({ note: 'no click target: ' + c }) + '\n');
      }
    }
    const r = await page.evaluate(() => ({
      url: location.href,
      body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 1800),
      links: Array.from(document.querySelectorAll('a[href]')).map(a => ({ t: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50), href: a.getAttribute('href') }))
        .filter(x => /edinburgh|leeds|birmingham|manchester|donation|blood|centre|venue|available|book/i.test(x.t + x.href) || /location|availability|session/.test(x.href)),
    }));
    process.stdout.write(JSON.stringify(r, null, 2));
  }

  if (cmd === 'cscreen') {
    // explore: search -> nearest venue -> earliest date -> choose-appointment, dump controls
    const town = process.env.GB_TOWN || HOME_TOWN;
    await utils.gotoAuthed(APPTS_URL);
    await utils.gotoAuthed(BASE + '/your-account/appointments/book/search/');
    await page.locator('input[name="searchCriteria"], input[type="text"]').first().fill(town);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    if (page.url().includes('location-results')) {
      const m = page.locator('a[href*="donation-venues"]').last();
      if (await m.count()) { await m.click(); await page.waitForTimeout(700); }
    }
    await page.waitForTimeout(1200);
    const vCard = page.locator('a[href*="choose-date"]').first();
    if (await vCard.count()) { await vCard.click(); await page.waitForTimeout(2600); }
    const dt = page.locator('a[href*="choose-appointment"]').first();
    if (await dt.count()) { await dt.click(); await page.waitForTimeout(2800); }
    const r = await page.evaluate(() => ({
      url: location.href,
      body: (document.body ? document.body.innerText : '').slice(0, 2200),
      radios: Array.from(document.querySelectorAll('input[type=radio]')).map(x => ({ v: x.value, label: (x.closest('label')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60), checked: x.checked })),
      checks: Array.from(document.querySelectorAll('input[type=checkbox]')).map(x => ({ label: (x.closest('label')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60), checked: x.checked })),
      buttons: Array.from(document.querySelectorAll('button,a[href]')).map(x => ({ t: (x.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), href: x.getAttribute('href') || '', tag: x.tagName })).filter(x => /continue|confirm|next|book|save|submit|back/i.test(x.t) || /confirm|summary/i.test(x.href)),
    }));
    process.stdout.write(JSON.stringify(r, null, 2));
  }

  if (cmd === 'review') {
    // go to the review/confirm screen for a selected time slot
    const town = process.env.GB_TOWN || HOME_TOWN;
    const wantTime = (process.env.GB_TIME || '').toLowerCase();
    await utils.gotoAuthed(APPTS_URL);
    await utils.gotoAuthed(BASE + '/your-account/appointments/book/search/');
    await page.locator('input[name="searchCriteria"], input[type="text"]').first().fill(town);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    if (page.url().includes('location-results')) {
      const m = page.locator('a[href*="donation-venues"]').last();
      if (await m.count()) { await m.click(); await page.waitForTimeout(700); }
    }
    await page.waitForTimeout(1200);
    const vCard = page.locator('a[href*="choose-date"]').first();
    if (await vCard.count()) { await vCard.click(); await page.waitForTimeout(2400); }
    const dt = page.locator('a[href*="choose-appointment"]').first();
    if (await dt.count()) { await dt.click(); await page.waitForTimeout(2400); }
    // pick a slot link
    let slot = null;
    if (wantTime) slot = page.locator(`a[href*="check-appointment-details"]`).filter({ hasText: wantTime }).first();
    else slot = page.locator('a[href*="check-appointment-details"]').first();
    let clickedSlot = false;
    if (slot) {
      const slots = page.locator('a[href*="check-appointment-details"]');
      // the times list is an accordion; expand if no slot is visible yet
      for (let attempt = 0; attempt < 3 && !clickedSlot; attempt++) {
        const total = await slots.count();
        for (let i = 0; i < total; i++) {
          const el = slots.nth(i);
          if (await el.isVisible().catch(() => false)) {
            await el.scrollIntoViewIfNeeded().catch(() => {});
            await el.click({ timeout: 9000, noWaitAfter: true }).catch(async () => { await el.evaluate(o => o.click()); });
            clickedSlot = true;
            break;
          }
        }
        if (!clickedSlot) {
          const expander = page.locator('button:has-text("Afternoon"), button:has-text("Evening"), [role=button]:has-text("Afternoon"), [role=button]:has-text("Evening"), button:has-text("Show all"), button:has-text("Show more")').first();
          if (await expander.count()) { await expander.click({ noWaitAfter: true }).catch(() => {}); await page.waitForTimeout(1200); }
        }
      }
      if (!clickedSlot && await slot.count()) { await slot.click({ force: true, timeout: 9000, noWaitAfter: true }).catch(() => {}); clickedSlot = true; }
      await page.waitForTimeout(3000);
    }
    const r = await page.evaluate(() => ({
      url: location.href,
      body: (document.body ? document.body.innerText : '').slice(0, 2000),
      buttons: Array.from(document.querySelectorAll('button')).map(b => ({ t: (b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), type: b.type || '' })).filter(b => b.t),
    }));
    r.clickedSlot = clickedSlot;
    process.stdout.write(JSON.stringify(r, null, 2));
  }

  if (cmd === 'probe') {
    await page.waitForTimeout(1800);
    const info0 = await page.evaluate(() => {
      const t = (e) => (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50);
      const links = [...new Set(Array.from(document.querySelectorAll('a[href]'))
        .filter(a => !/(cookie|^#|facebook|youtube|instagram|privacy|accessibility|terms|0300|sitemap)/i.test(a.textContent) && !a.href.includes('blog.'))
        .map(a => ({ tag: 'a', t: t(a), href: a.getAttribute('href') })))];
      const buttons = [...new Set(Array.from(document.querySelectorAll('button'))
        .map(b => ({ tag: 'button', t: t(b), type: b.type || '' })))].filter(b => b.t);
      const fields = Array.from(document.querySelectorAll('input, select, textarea')).map(f => ({
        tag: f.tagName.toLowerCase(), name: f.name || f.id || '', type: f.type || '',
        aria: f.getAttribute('aria-label') || '', placeholder: f.placeholder || '',
        label: (f.closest('label')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50),
        opts: f.tagName === 'SELECT' ? Array.from(f.options).map(o => o.text.trim()).slice(0, 12) : [],
      }));
      const radios = Array.from(document.querySelectorAll('input[type=radio]')).map(r => (r.closest('label')?.textContent || r.value || '').trim().replace(/\s+/g, ' ').slice(0, 50));
      return { url: location.href, body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200), links, buttons, fields, radios };
    });
    const { writeFileSync } = await import('node:fs');
    writeFileSync('/tmp/giveblood-probe.txt', JSON.stringify(info0, null, 2));
    info(info0);
  }

  if (cmd === 'walk-book') {
    const { writeFileSync } = await import('node:fs');
    await page.getByRole('link', { name: /book an appointment/i }).first().click();
    const actions = (process.env.GB_WALK || '').split('|').filter(Boolean);
    let dumpIdx = 1;
    let active = page;
    const dump = async () => {
      await Promise.race([
        active.waitForLoadState('networkidle').catch(() => {}),
        new Promise(r => setTimeout(r, 4000)),
      ]);
      await active.waitForFunction((min) => document.body && document.body.innerText.trim().length > min, 40, { timeout: 6000 }).catch(() => {});
      const url = active.url();
      const text = await active.locator('body').innerText();
      writeFileSync(`/tmp/gb-${String(dumpIdx).padStart(2, '0')}-${url.split('/').pop() || 'x'}.txt`, `URL: ${url}\n${'='.repeat(60)}\n${text}\n`);
      const targets = await active.locator('button, a[href], select, [role=button], input[type=radio]').evaluateAll(
        es => [...new Set(es.map(e => {
          const t = (e.textContent || '').trim().replace(/\s+/g, ' ');
          const rel = e.getAttribute('aria-label');
          const nm = e.getAttribute('name');
          return [t || nm || rel, e.tagName.toLowerCase()].filter(Boolean).join(' <').slice(0, 70);
        }))]);
      console.error(`[scr ${dumpIdx}] url=${url}\n  ${targets.map(t => '• ' + t).join('\n  ')}`);
      dumpIdx++;
    };
    await dump();
    for (const a of actions) {
      const pagesBefore = browser.pages().length;
      const m = /^(click):\s*(.+)$/.exec(a);
      if (m) {
        const loc = active.locator(`button:has-text("${m[2]}"), a:has-text("${m[2]}"), [role=button]:has-text("${m[2]}")`).first();
        if (await loc.count()) {
          await Promise.all([loc.click().catch(() => {}), active.waitForTimeout(1400)]);
        } else console.error(`[miss] no target for "${m[2]}"`);
      }
      if (browser.pages().length > pagesBefore) {
        active = browser.pages()[pagesBefore];
        await active.waitForLoadState('domcontentloaded').catch(() => {});
        await active.bringToFront().catch(() => {});
      }
      await dump();
    }
    console.error('WALK_DONE');
  }

  if (cmd === 'debug-dump') {
    const { writeFileSync } = await import('node:fs');
    await page.waitForLoadState('networkidle').catch(() => {});
    await utils.waitContent();
    const text = await page.locator('body').innerText();
    const { protocol, host } = new URL(page.url());
    writeFileSync('/tmp/giveblood-dump.txt',
      `URL: ${page.url()}\n${'='.repeat(60)}\n${text}`);
    // surface clickable controls for selector mapping
    const ctl = await page.locator('button, a, input, select, [role=button]').evaluateAll(els =>
      els.slice(0, 200).map(e =>
        `<${e.tagName.toLowerCase()}${e.id ? ' id=' + e.id : ''}${e.getAttribute('name') ? ' name=' + e.getAttribute('name') : ''}> ${(e.textContent||'').trim().replace(/\s+/g,' ').slice(0,80)}`
      ));
    info({ url: page.url(), controls: ctl, textlen: text.length }, 'dumped to /tmp/giveblood-dump.txt');
  }

  await browser.close();
}
main().catch((e) => { console.error('giveblood: ' + (e && e.message ? e.message : e)); process.exit(1); });