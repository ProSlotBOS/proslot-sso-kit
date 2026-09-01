# Agent Rules — ProSlot

## Sync With Origin Before Working (Standing Order)

**Before starting any work in this repo — answering a question about the code,
planning a change, or editing a file — run `git fetch origin` and check whether
the local checkout is behind.** Pull when it is.

Joe runs multiple Claude Code sessions against these repositories at the same
time, including cloud sessions from his phone. Commits land on `origin/main`
from outside whatever checkout you are looking at, at any moment. Acting on a
stale copy means reasoning about code that has already changed, re-fixing
something that was just fixed elsewhere, or editing a file that moved underneath
you.

Check the repos a change depends on, not just the one being edited — the
`proslot-api` backend and shared packages like `@proslotbosllc/league-kit`
change what the satellite frontends should be doing.

### Two hazards from the same setup

**Concurrent `git add -A`.** Another session can sweep your uncommitted working
tree into its own commit. This has already happened: frontend changes were
absorbed into an unrelated commit and shipped under its message. Commit promptly
rather than leaving work uncommitted across a long turn, and afterwards confirm
the commit contains what you intended.

**Silent unpushed work.** Keep the branch tracking its upstream
(`git branch --set-upstream-to=origin/main main`) so `git status` self-reports
ahead/behind. Two finished commits sat unnoticed in `HomeTeamSports` for half a
day because it did not.

---

The full ecosystem rules — architecture, deploy policy, Firestore scoping,
secrets — live in `CLAUDE.md` at the root of Joe's local `ProSlotEnvironment`
workspace, which is not itself a git repository. This file carries only the
standing order that must reach every session regardless of machine.
