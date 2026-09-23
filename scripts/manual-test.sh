#!/bin/bash
# ---------------------------------------------------------------------------
# giveblood — MANUAL ACCEPTANCE TEST (run by a human; agent must not self-pass)
# Card: t_60477374   Skill: ~/.hermes/skills/personal/giveblood-booking
#
# Delete nothing, book nothing. Steps 1-4 are read-only / dry-run.
# Step 5 is opt-in and CHANGES a real NHS appointment: do NOT run it by default.
# ---------------------------------------------------------------------------
SD=$(cd "$(dirname "$0")" && pwd)
cd "$SD" || { echo "FAIL: script dir missing"; exit 1; }
TOWN="${GIVEBLOOD_HOME_TOWN:-Bedford}"
PASS=0; FAIL=0
chk() {  # chk "<step>" <exit_code>
  if [ "$2" -eq 0 ]; then echo "  PASS  $1"; PASS=$((PASS+1)); else echo "  FAIL  $1"; FAIL=$((FAIL+1)); fi
}

echo "=============================================================="
echo " giveblood manual test — $(date)"
echo "=============================================================="
echo
echo "STEP 1 — session alive?  (expect: your appointment + 'you can next give blood from <date>')"
timeout 240 node giveblood.mjs status 2>&1
chk "status reads the current appointment" $?
echo

echo "STEP 2 — availability near your home town (nearest first, then that venue's dates/times)"
timeout 240 node giveblood.mjs check "$TOWN" 2>&1
chk "check lists venues + dates + times" $?
echo

echo "STEP 3 — eligible window + top-3 slots after your deferral"
timeout 240 node giveblood.mjs next 2>&1
chk "next computes the eligible date and shows slots" $?
echo

echo "STEP 4 — book DRY RUN (must NOT book; must show New vs Existing appointment)"
timeout 240 node giveblood.mjs book "$TOWN" 2>&1
chk "book dry-run reaches the review screen without booking" $?
echo

echo "--------------------------------------------------------------"
echo "MANUAL CHECKS (eyeball these against the real portal):"
echo "  [ ] Step 1 appointment matches what my.blood.co.uk shows"
echo "  [ ] Step 1 date + time are right"
echo "  [ ] Step 2 nearest venue is the one you'd actually use"
echo "  [ ] Step 3 eligible date looks right for your deferral (84 men / 112 women)"
echo "  [ ] Step 4 did NOT book anything"
echo "--------------------------------------------------------------"
echo "STEP 5 (OPT-IN, REAL SIDE EFFECT — skip unless you mean it):"
echo "  node giveblood.mjs book \"$TOWN\" --confirm"
echo "  ^ this REPLACES a live appointment when dates are too close. Not run here."
echo "--------------------------------------------------------------"
echo
echo "RESULT: $PASS passed, $FAIL failed"
echo "Nudge watchdog (silent — prints nothing unless an appointment has passed):"
node giveblood-nudge.mjs status 2>&1
[ $FAIL -eq 0 ] && echo "AUTOMATED STEPS: ALL PASS — now confirm the eyeball checks above." || echo "AUTOMATED STEPS: FAILURES — do not accept."
