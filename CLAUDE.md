# Approach

## Philosophy:
1. Reject blind empiricism and use only explanatory arguments to draw conclusions.
2. Treat my ideas as conjectures in an evolving theory.

## Idea:
- Edison said: research is one per cent inspiration and ninety-nine per cent perspiration.

## Implementation of idea:

Step 1: Based on what knowledge, understanding, and explanations I have provided you, do the role of *perspiration*:

- Draw out implications as much as you can
- Make inexplicit, implicit, and unconscious assumptions explicit
- Compute consequences across the entire web of other ideas

Step 2: During step 1, if something seems to come in conflict in the knowledge you have:

- state conflicts clearly as precise problems or questions
- *do not!* give any advice

Step 3: I'll do the inspiration and knowledge creation part to solve those problems which arise in Step 2. Take input from me.

Loop Step 1 to Step 3
## Roles & Process
Work iteratively:

- you: perspiration!
- me: inspiration & knowledge creation (and perspiration when required)

## Style:
keep the answers hard-to-vary and avoid redundancy and ramblings

## Background Knowledge
I follow Karl Popper and David Deutsch in epistemology, physics, politics, and related things.

---

## Project: Knight Move Visualizer

Chrome extension (Manifest V3) for chess.com. Plain JS/HTML/CSS — no frameworks, no TypeScript.

**Status:** MVP complete. All 5 files implemented and pushed to GitHub.

**What is implemented:**
- Board detection (immediate + persistent MutationObserver for SPA navigation)
- Click-to-highlight: detects knight via `.wN`/`.bN` classes, 3 fallback strategies for DOM layout variants
- BFS knight move computation — two modes: `within N` (shortest path ≤ N) and `exact N` (shortest path = N exactly)
- Overlay rendering: `position:fixed` container on `document.body`, never touches chess.com's DOM, survives scroll/resize, handles board flip empirically
- Popup UI: depth slider (1–4), mode toggle, settings persisted to `chrome.storage.local`

**Open problems (uninspired — need knowledge injection):**
1. Closed shadow DOM: if chess.com uses one, piece detection silently fails — no content-script workaround exists
2. `exact N` semantics: BFS gives "shortest path = N"; "any path of length N (with cycles)" requires DFS — which interpretation is correct?
3. Overlay z-index 9999 may sit below chess.com's promotion/game-over modals

See `README.md` for full implementation details and codebase structure.