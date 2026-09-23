---
name: giveblood-booking
description: NHS Give Blood — check appointment availability near the user, nearest venue first + dates/times, book/reschedule, and a "did you give blood?" nudge cron. Harness-neutral Playwright CLI, token-lean (zero LLM tokens on the happy path). Use when Keni asks to check/book/reschedule a blood donation, run the giveblood tool, or when the donation nudge fires.
---

# Give Blood — auto check/booking + donation nudge

A standalone, harness-neutral driver for the NHS Give Blood portal
(`my.blood.co.uk`). Any agent (Hermes, opencode, Claude Code, plain terminal)
can run it and read plain-text stdout — **zero LLM tokens on the happy path**,
everything is deterministic Playwright automation.

Two tools:

- `scripts/giveblood.mjs` — the driver (login / check / status / next / book)
- `scripts/giveblood-nudge.mjs` (+ `.sh` wrapper) — the silent cron watchdog that
  asks "did you give blood?" after an appointment has passed

## Status (2026-09-23)

- ✅ **`login` works** — `POST /api/auth/v2/login` → 200, sets `accessToken`/`refreshToken`.
  Session persists across process runs (profile cookie reused, no credential on repeat runs).
- ✅ **`check` works** — nearest-first venues for the home location, then the nearest
  venue's full dates + opening hours + available times.
- ✅ **`status` works** — current appointment (date + time) and the deferral expiry.
  `--json` is the machine-readable form the nudge reads.
- ✅ **`next` works** — current appointment → eligible date (`GIVEBLOOD_DEFERRAL_DAYS`,
  84 men / 112 women) → top-3 earliest eligible slots.
- ✅ **`book` works (dry-run + `--confirm`)** — walks the wizard in-flow to the review screen
  (New vs Existing appointment, incl. the "too close → will replace your existing" case) and
  `--confirm` actually clicks "Confirm and book appointment". **Safe by default: does NOT book
  unless `--confirm` is given.** NB the portal replaces an existing appointment when dates are
  too close.
- ✅ **Nudge watchdog works** — hourly cron, silent unless something needs saying.
- ✅ **Session expiry is the #1 failure mode** — the ~30-day cookie dies and every command
  lands on `/login`. Fix is always `giveblood login` (auth 200, usually no OTP needed).
- ⚠️ **SPA quirk (important, cost real debugging time):** the *appointments list* page
  (`/your-account/appointments`) routinely renders an empty 776-char shell in headless and
  **never hydrates** — it will not produce the appointment no matter how long you wait. The
  **account home page (`/your-account/`) renders reliably in ~1-4s** and carries the next
  appointment, the venue, the portal's own "You can donate from <date>", and an
  `appointment-details` link whose query string has a machine-readable
  `sessionDate=YYYY-MM-DD&time=T1255`. `currentAppointment()` therefore reads **home first**
  and only falls back to the list page.

## Commands

```
giveblood login                     # authenticate + persist the session cookie
giveblood check [town]              # venues near town nearest-first + nearest venue's dates/times
giveblood status                    # current appointment + deferral expiry (--json for scripts)
giveblood next                      # current appointment -> eligible date -> top-3 eligible slots
giveblood book [town]               # dry-run: reach the review screen, New vs Existing appt, NO booking
giveblood book [town] --confirm     # book the shown time (REAL appointment change — use explicitly)
```

Extra: `GB_TIME="5:30pm"` picks a specific slot for `book`. `GIVEBLOOD_HOME_TOWN` in
`~/.config/giveblood/.env` (default `Bedford`). `--json` for structured output.

## The nudge watchdog

`scripts/giveblood-nudge.mjs` (run it via `giveblood-nudge.sh`, which the cron scheduler
can execute). **Silent-watchdog contract: it prints nothing unless there is something to
say**, so empty stdout means the scheduler delivers nothing.

- Fires the question **30 min after the appointment time has passed**
  (`GIVEBLOOD_NUDGE_AFTER_MIN`), exactly **once** per appointment:
  > Your donation was Monday 2 November 2026 at 12:55pm. Did you give blood? Reply y or n.
- After the nudge, the rest of the flow is **human-in-the-loop in chat**: reply yes → show
  the top-3 earliest slots after the deferral window → pick 1/2/3 → book that exact one.
  **Nothing books unattended.** (An unattended booker would also have to answer an OTP prompt,
  which a cron cannot.)
- If the portal read keeps failing (session dead), it shouts **once a week**, not every tick.
- Reads the appointment via `giveblood status --json`, cached in
  `~/.config/giveblood/nudge-state.json` (chmod 600), so **hourly ticks don't hammer the
  bot-guarded portal**. A live read happens only when it matters: no cached appointment,
  cache older than 7 days, or we have just entered the nudge window (so the ask reflects
  reality if the appointment moved).

Sub-commands: `giveblood-nudge.mjs status` (print cached state), `reset` (forget that we
asked), `check` (force a live portal read). `GIVEBLOOD_NUDGE_NO_READ=1` skips the portal
read and trusts the cache — used for testing the ask path offline.

### Cron wiring (Pi)

- Job **"Blood donation nudge"**, id `55cc5dc419fc`, hourly `20 * * * *`, `no_agent=true`
  (script stdout delivered verbatim), `attach_to_session=true` so the reply carries the brief.
- Entrypoint `~/.hermes/scripts/giveblood-nudge.sh` → execs the skill's
  `scripts/giveblood-nudge.sh` → `node giveblood-nudge.mjs`.
  (The cron `script` param must be relative to `~/.hermes/scripts/`, hence the thin wrapper.)

## Credentials — password never stored

- Sources (in priority): one-shot process env `GIVEBLOOD_EMAIL`/`GIVEBLOOD_PASSWORD`, or
  Keni-created `~/.config/giveblood/.env` (chmod 600) read at runtime. Never written by the
  script, never echoed, never in chat/repo/vault.
- Only the **revocable session cookie** persists (`~/.config/giveblood/profile`, chmod 600);
  re-login only when it expires (~30 days).

## Security rules (hard)

- **Never print the access/refresh token** — the auth capture records status only. Do not dump
  `authResp.body` (it contains the JWT).
- Do not commit the `.env` or profile dir to any repo/skill.
- One-time security code = `GIVEBLOOD_OTP` env/`.env` for the run; single-use.

## Token-lean / transferable

- Resolves Playwright from the system-global `npm root -g` install; no local deps, no Hermes
  coupling. Runtime calls are deterministic scripts → the happy path uses no model tokens.
- Site quirk: the booking SPA **blanks itself after ~5s** on sub-routes — the driver reads in
  the 3-4s window after each navigation and bootstraps via the appointments page first.

## Known terms-of-use caveat (documented 2026-09-17)

The site runs Queue-it + Imperva Incapsula bot mitigation, so driving it with headless
Playwright is outside the letter of its terms even on your own account. The design keeps a
human at every decision point (you answer, you pick the slot, you approve the confirm), which
covers the clinical-screening concern; the automated-access concern remains. Keep `check` /
`status` / `next` (read-only) as the safe surface, and treat `book --confirm` as opt-in.

## Environment (Pi)

- `node` v22, global `@playwright/test@1.61.1`, cached chromium in `~/.cache/ms-playwright`.
- Requires the credentials `.env` (Keni-created) + the Give Blood donor login email.
- Distribution repo: https://github.com/kenibarwick/giveblood-booking (public; no secrets).
