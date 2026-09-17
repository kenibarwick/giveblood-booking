---
name: giveblood-booking
description: NHS Give Blood — check appointment availability near the user, nearest venue first + dates/times, via a harness-neutral Playwright CLI. Token-lean (zero LLM tokens on the happy path), transferable to any model/harness. Use when Keni asks to check/book/reschedule a blood donation or run the giveblood tool.
---

# Give Blood — auto check/booking

A standalone, harness-neutral driver for the NHS Give Blood portal
(`my.blood.co.uk`). Any agent (Hermes, opencode, Claude Code, plain terminal)
can run it and read plain-text stdout — **zero LLM tokens on the happy path**,
everything is deterministic Playwright automation.

## Status (2026-09-17)

- ✅ **`login` works** — `POST /api/auth/v2/login` → 200, sets `accessToken`/`refreshToken`.
- ✅ **Session persists across process runns** — profile cookie reused, no credential on repeat runs.
- ✅ **`check` works** — nearest-first venues for the home location, earliest date, and the nearest
  venue's full dates + opening hours + available times (verified stable for Bedford).
- ✅ **`book` works (dry-run + `--confirm`)** — walks the wizard in-flow to the review screen
  (New vs Existing appointment, incl. the "too close → will replace your existing" case) and
  `--confirm` actually clicks "Confirm and book appointment". **Safe by default: does NOT book
  unless `--confirm` is given.** Booking against a live NHS account is a real side effect —
  confirm only on explicit user go. NB the portal replaces an existing appointment when dates
  are too close.
- ⚠️ SPA is bot-guarded + nondeterministic (Queue-it/hydration): the wizard sometimes renders an
  empty/collapsed shell. `searchVenues` retries the bootstrap; the slot picker expands accordions.
  If a run fails, re-run `giveblood login` then retry.

## Commands

```
giveblood check [town]             # venues near town (or GIVEBLOOD_HOME_TOWN, default Bedford),
                                   # nearest first + nearest venue's dates & times
giveblood book [town]              # dry-run: reach the review screen, show New vs Existing appt, NO booking
giveblood book [town] --confirm    # book the shown time (REAL appointment change — use explicitly)
giveblood login                    # authenticate + persist session cookie
```

Extra: `GB_TIME="5:30pm"` picks a specific time slot for `book`. Home location variable:
`GIVEBLOOD_HOME_TOWN` in `~/.config/giveblood/.env` (default `Bedford`). `--json` for structured output.

## Credentials — password never stored

- Sources (in priority): one-shot process env `GIVEBLOOD_EMAIL`/`GIVEBLOOD_PASSWORD`, or
  Keni-created `~/.config/giveblood/.env` (chmod 600) read at runtime. Never written by the script,
  never echoed, never in chat/repo/vault.
- Only the **revocable session cookie** persists (`~/.config/giveblood/profile`, chmod 600);
  re-login only when it expires (~30 days).

## Security rules (hard)

- **Never print the access/refresh token** — the auth capture records status only. Do not dump
  `authResp.body` (it contains the JWT).
- Do not commit the `.env` or profile dir to any repo/skill.
- One-time security code = `GIVEBLOOD_OTP` env/`.env` for the run; single-use.

## Token-lean / transferable

- Resolves Playwright from the system-global `npm root -g` install; no local deps, no Hermes coupling.
  Runtime calls are deterministic scripts → the happy path uses no model tokens.
- Site quirk: the booking SPA **blanks itself after ~5s** on sub-routes — the driver reads in the
  3-4s window after each navigation and bootstraps via the appointments page first.

## Environment (Pi)

- `node` v22, global `@playwright/test@1.61.1`, cached chromium in `~/.cache/ms-playwright`.
- Requires the credentials `.env` (Keni-created) + the Give Blood donor login email.