# giveblood-booking

Automated NHS Give Blood appointment **checking and booking** — a single dependency-free
Node script that drives `my.blood.co.uk` with headless Chromium. Token-lean (zero LLM tokens
on the happy path), harness-neutral (any coding agent — or plain terminal — can run it).

`giveblood check` lists venues near you nearest-first with their dates, then the nearest
venue's dates + opening hours + available times. `giveblood book` walks the real booking
wizard to the confirm screen; `--confirm` actually books.

## Why yours will look like this

NHS Give Blood has **no public availability API** and every check/booking is login-gated.
This tool authenticates once (persisting a revocable ~30-day session cookie), then checks
and books deterministically via Playwright — no API tokens, no botnet, just a browser
driving the same pages you'd click.

## Requirements

- **Node 20+**
- **Playwright + Chromium** (global install):
  ```bash
  npm i -g @playwright/test
  npx playwright install chromium
  ```
- **Your own NHS Give Blood account** (you must already be a registered donor at
  `my.blood.co.uk`).

## Install

```bash
# the whole tool is one file
curl -L -o giveblood.mjs https://raw.githubusercontent.com/kenibarwick/giveblood-booking/main/scripts/giveblood.mjs
chmod +x giveblood.mjs
```

Create your **own** secrets file (never share it, never commit it):
```bash
mkdir -p ~/.config/giveblood && touch ~/.config/giveblood/.env && chmod 600 ~/.config/giveblood/.env
```
Edit `~/.config/giveblood/.env` with your donor login:
```
GIVEBLOOD_EMAIL=you@example.com
GIVEBLOOD_PASSWORD=********
GIVEBLOOD_HOME_TOWN=Bedford
```
- `GIVEBLOOD_PASSWORD` is read at runtime and **never stored or echoed** by the script —
  only the revocable session cookie is persisted.
- `GIVEBLOOD_HOME_TOWN` is your nearest-location variable (used when you call `check`/`book`
  with no town argument).

## Usage

```bash
node giveblood.mjs login          # one-time; persists ~30-day session
node giveblood.mjs check          # venues near GIVEBLOOD_HOME_TOWN, nearest first + dates/times
node giveblood.mjs check "Leeds"  # or any town/postcode
node giveblood.mjs book           # dry-run to the confirm screen (SAFE, doesn't book)
node giveblood.mjs book --confirm # actually books the shown time (REAL change to a live account)
```

Extra:
- `GB_TIME="5:30pm"` — pick a specific time slot for `book`.
- `--json` — structured output for scripts.

### Bare-metal terminal example
```bash
node giveblood.mjs check
```
```
Blood donation venues near Bedford — nearest first, appointments from:
  • Kings House Kings Arm Church (0.3 mi) — Monday 26 October 2026
  • The Centenary Hall (0.6 mi) — Sunday 25 October 2026
  ...
Nearest (Kings House Kings Arm Church, 0.3 mi) — dates & times:
  Monday 26 October 2026  (Open 12:30pm–7pm)
  ...
Earliest date: Monday 26 October 2026
Available times (earliest date): 12:50pm, 6:45pm, 5pm
```

## Give this prompt to any coding agent

Copy the block below into your coding agent (Hermes, Claude Code, opencode, Codex, …).
It teaches the agent what the tool is and how to drive it — so it can check availability
and (with your explicit say-so) book appointments for you.

```
You have access to a local CLI tool for the UK's NHS Give Blood service.

RUN IT:   node /path/to/giveblood.mjs <cmd>

Commands:
  login              authenticate once (creates the session; run if logged out)
  check [town]       venues near GIVEBLOOD_HOME_TOWN (or the given town), nearest first,
                     then the nearest venue's dates + opening hours + available times
  book [town]        dry-run: walks the booking wizard to the confirm screen and reports the
                     New vs Existing appointment — DOES NOT book
  book --confirm     actually books the shown time — a REAL change to the user's live
                     NHS appointment; only run with the user's explicit approval

The user's own credentials live in ~/.config/giveblood/.env (chmod 600):
  GIVEBLOOD_EMAIL=...
  GIVEBLOOD_PASSWORD=...
  GIVEBLOOD_HOME_TOWN=...        (their nearest location)

RULES:
 - Never read, print, or echo the password or the access/refresh token.
 - `book` WITHOUT --confirm must never book. `book --confirm` changes a real appointment,
   and can REPLACE an existing NHS booking when dates are too close — show the user what
   would change and get explicit approval before running with --confirm.
 - If a run prints that the session expired (you land back on a login page) or the page
   rendered blank, run `node /path/to/giveblood.mjs login` then re-run the command.
 - Read the plain-text stdout and summarise for the user in normal prose.
```

## Security notes

- The **password/token never touch the skill, a repo, a chat, or the transcript** — only your
  own `~/.config/giveblood/.env`. Only the revocable session cookie persists.
- `book --confirm` is a genuine side effect on your live NHS account; the tool stays
  dry-run-by-default for that reason.
- If you ever think a credential leaked, change your Give Blood password — nothing here
  will break.

## How it works / limitations

- One file, no local npm deps — Playwright is resolved from the system-global install.
- The booking SPA is bot-guarded and sometimes renders an empty/collapsed shell
  (Queue-it/hydration). The tool retries the bootstrap and expands the accordions; a rare
  run needs a re-`login` then retry.
- Sessions last ~30 days; re-`login` when it drops you to the sign-in page.

## License

MIT