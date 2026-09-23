#!/usr/bin/env node
/**
 * giveblood-nudge — the "did you give blood?" watchdog for the NHS Give Blood skill.
 *
 * Zero LLM tokens: plain Node + the giveblood CLI. Harness-neutral (any agent or
 * plain cron can run it). SILENT-WATCHDOG CONTRACT: prints nothing unless there is
 * something to say, so an empty stdout means the scheduler delivers nothing:
 *
 *   1. the nudge question — once — about NUDGE_AFTER_MIN (default 30) after a known
 *      appointment has passed: "did you give blood? (y/n)"
 *   2. a one-off alert if the portal read keeps failing (session likely expired)
 *
 * The appointment is read from the portal via `giveblood.mjs status --json` and
 * cached in ~/.config/giveblood/nudge-state.json, so frequent ticks do NOT hammer
 * the bot-guarded portal. A live read only happens when it matters: no cached
 * appointment, cache older than REFRESH_MAX_AGE (7 days), or we have just entered
 * the nudge window (so the ask reflects reality if the appointment moved).
 *
 * After the nudge, the rest of the flow is human-in-the-loop in chat: reply yes ->
 * show the top-3 earliest slots after the deferral window -> pick 1/2/3 -> book that
 * exact one. Nothing books unattended.
 *
 * Usage:
 *   giveblood-nudge            one tick (what the cron runs)
 *   giveblood-nudge status     print the cached state
 *   giveblood-nudge reset      forget that we asked (so the next tick asks again)
 *   giveblood-nudge check      force a live portal read, print what it parsed
 *
 * Config (env or ~/.config/giveblood/.env):
 *   GIVEBLOOD_NUDGE_AFTER_MIN   minutes after the appointment time to ask (default 30)
 *   GIVEBLOOD_NUDGE_NO_READ=1   trust the cached state, skip the portal read (offline/test)
 *   GIVEBLOOD_DEBUG=1           trace to stderr
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HOME = process.env.HOME || '/home/keni';
const CFG = `${HOME}/.config/giveblood`;
const STATE_PATH = `${CFG}/nudge-state.json`;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'giveblood.mjs');

const AFTER_MIN = parseInt(process.env.GIVEBLOOD_NUDGE_AFTER_MIN || '30', 10);
const REFRESH_MAX_AGE_MS = 7 * 86400000;      // re-read the portal at least weekly
const READ_TIMEOUT_MS = 240000;               // portal read can be slow on a bad day
const FAIL_ALERT_AFTER = 6;                   // consecutive failures before we shout
const FAIL_ALERT_COOLDOWN_MS = 7 * 86400000;  // ...and at most once a week

const DEBUG = !!process.env.GIVEBLOOD_DEBUG;
const NO_READ = !!process.env.GIVEBLOOD_NUDGE_NO_READ;   // test/offline: trust the cached state, skip the portal read
const log = (m) => { if (DEBUG) console.error('[nudge] ' + m); };
const now = Date.now();

/* ---------- state ---------- */

function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try {
    mkdirSync(CFG, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  } catch (e) { log('state write failed: ' + e.message); }
}

/* ---------- appointment -> Date ---------- */

// portal gives ISO date (YYYY-MM-DD) + a display time ("12:55pm"); build a LOCAL Date
function apptDate(st) {
  if (!st.appointmentISO) return null;
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(st.appointmentTime || '');
  let hh = 9, mm = 0;                       // no time known -> assume mid-morning
  if (m) { hh = parseInt(m[1], 10) % 12; mm = parseInt(m[2], 10); if (/pm/i.test(m[3])) hh += 12; }
  const [y, mo, d] = st.appointmentISO.split('-').map(Number);
  if (!y || !mo || !d) return null;
  return new Date(y, mo - 1, d, hh, mm);
}

/* ---------- portal read ---------- */

function readPortal() {
  const out = execFileSync('node', [CLI, 'status', '--json'], {
    timeout: READ_TIMEOUT_MS, encoding: 'utf8', env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = String(out).trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
}

/* ---------- output ---------- */

function nudgeText(st) {
  const dt = apptDate(st);
  const when = (st.appointment || 'your appointment') + (st.appointmentTime ? ' at ' + st.appointmentTime : '');
  const dur = st.deferralDays || 84;
  return [
    '🩸 Blood donation nudge',
    '',
    `Your donation was ${when}.`,
    '',
    'Did you give blood? Reply y or n.',
    `If yes, I'll show the earliest slots after your ${dur}-day deferral and book the one you pick.`,
  ].join('\n');
}

function alertText(st) {
  return [
    '🩸 Blood donation nudge is blind',
    '',
    `I've failed to read your appointment from the NHS portal ${st.failures} times in a row.`,
    'The saved session has most likely expired.',
    '',
    'Fix: run `giveblood login` (needs your one-time security code if the portal asks).',
    `Last appointment I knew about: ${st.appointment || 'unknown'}.`,
  ].join('\n');
}

/* ---------- tick ---------- */

function tick() {
  const s = loadState();
  const apptMs = apptDate(s);
  const inWindow = apptMs && now >= apptMs.getTime() + AFTER_MIN * 60000;
  const stale = !s.readAt || (now - s.readAt) > REFRESH_MAX_AGE_MS;
  const needRefresh = !s.appointmentISO || stale || (inWindow && s.askedFor !== s.appointmentISO);

  if (needRefresh && !NO_READ) {
    try {
      const r = readPortal();
      if (r && r.ok && r.appointmentISO) {
        s.appointment = r.appointment;
        s.appointmentTime = r.time || '';
        s.appointmentISO = r.appointmentISO;
        s.deferralDays = r.deferralDays || 84;
        s.readAt = now;
        s.failures = 0;
        log('read ok: ' + s.appointmentISO + ' ' + s.appointmentTime);
      } else {
        s.failures = (s.failures || 0) + 1;
        log('read returned no appointment (failure ' + s.failures + ')');
      }
    } catch (e) {
      s.failures = (s.failures || 0) + 1;
      log('read failed (failure ' + s.failures + '): ' + (e.message || e));
    }
  }

  let out = '';

  const ms2 = apptDate(s);
  if (ms2 && now >= ms2.getTime() + AFTER_MIN * 60000 && s.askedFor !== s.appointmentISO) {
    out = nudgeText(s);
    s.askedFor = s.appointmentISO;          // ask exactly once per appointment
    s.askedAt = now;
  } else if ((s.failures || 0) >= FAIL_ALERT_AFTER && (now - (s.alertedAt || 0)) > FAIL_ALERT_COOLDOWN_MS) {
    out = alertText(s);
    s.alertedAt = now;
  }

  saveState(s);
  if (out) process.stdout.write(out + '\n');
}

/* ---------- entry ---------- */

const sub = (process.argv[2] || '').toLowerCase();

if (sub === 'status') {
  process.stdout.write(JSON.stringify(loadState(), null, 2) + '\n');
} else if (sub === 'reset') {
  const s = loadState();
  delete s.askedFor; delete s.askedAt;
  saveState(s);
  process.stdout.write('nudge state reset (will ask again on the next due tick)\n');
} else if (sub === 'check') {
  try {
    const r = readPortal();
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  } catch (e) {
    process.stderr.write('portal read failed: ' + (e.message || e) + '\n');
    process.exit(1);
  }
} else if (existsSync(CLI)) {
  tick();
} else {
  process.stderr.write('giveblood.mjs not found next to this script\n');
  process.exit(1);
}
