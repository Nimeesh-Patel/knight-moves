# Knight Move Visualizer — Chrome Extension (Manifest V3)

A content script extension for chess.com. Click any knight on the board to highlight all reachable squares. Depth (1–4) and mode ("within N moves" / "exactly N moves") are configurable via a toolbar popup.

---

## Files

| File | Role |
|---|---|
| `manifest.json` | Extension metadata, permissions, content script declaration |
| `content.js` | Board detection, click handling, BFS computation, overlay rendering |
| `popup.html` | Popup UI — depth slider + mode radio buttons |
| `popup.js` | Reads UI, persists settings to `chrome.storage.local`, messages content script |
| `styles.css` | Injected into chess.com pages — styles overlay container and circle dots only |

---

## Architecture and Data Flow

```
popup.html / popup.js
      │  chrome.tabs.sendMessage({type: 'SETTINGS_UPDATE', depth, mode})
      ▼
content.js  ←── chrome.runtime.onMessage
      │
      ├── reads chess.com DOM  (<chess-board>, .square-XY, .wN / .bN)
      └── writes .km-overlay-container to document.body

chrome.storage.local  →  persists { depth, mode } across popup opens
```

**Settings lifecycle:** popup.js writes to `chrome.storage.local` on every change and simultaneously sends a message to the active tab. content.js reads storage on load so the first click always uses the last-saved values, regardless of whether the popup is open.

**Message flow:** popup → `chrome.tabs.sendMessage` → content.js `onMessage` → re-renders overlays if a knight is currently selected. Errors (non-chess.com tab, content script not ready) are swallowed silently.

---

## Board Coordinate System

Chess.com marks each square with a CSS class `square-XY`:
- `X` = column (file): `1` = a-file … `8` = h-file
- `Y` = row (rank): `1` = rank 1 … `8` = rank 8

Examples: `square-11` = a1, `square-44` = d4, `square-88` = h8.

Knight pieces carry the class `wN` (white) or `bN` (black). `squareHasKnight()` tries three strategies in order:
1. `squareEl.querySelector('.wN, .bN')` — piece is a child of the square div
2. `squareEl.classList.contains('wN' / 'bN')` — piece and square are the same element
3. `squareEl.shadowRoot.querySelector(...)` — open shadow DOM fallback

Closed shadow DOM blocks all three; content.js logs a `console.warn` and does nothing.

The click handler uses **event delegation** on `<chess-board>` (one listener, not 64). `getSquareFromEl()` walks up from `event.target` until it finds an element whose class matches `/^square-\d\d$/`.

---

## BFS — Mode Semantics

`bfs(col, row, maxDepth, mode)` in `content.js`:

- Tracks `firstReached: Map<"col,row" → depth>` — the **shortest** path from the start to each square.
- Queue entries: `{ col, row, d }`. Stops expanding when `d >= maxDepth`.

Mode filter applied after the BFS completes:

| Mode | Collected squares |
|---|---|
| `within` | `firstReached >= 1` AND `<= maxDepth` |
| `exact` | `firstReached === maxDepth` |

**Implication of `exact`:** a square reachable in 2 moves will NOT appear in "exactly 3" results, even if a longer 3-move path exists. BFS records the first (shortest) reach. This implements "minimum moves to reach = N", which is the most useful chess interpretation.

---

## Overlay Rendering

Overlays never modify chess.com's DOM — a single `.km-overlay-container` div is appended to `document.body` instead.

**Positioning:**
1. `position: fixed`, sized to match `boardEl.getBoundingClientRect()`.
2. Each reachable square gets a `.km-circle` div inside the container, positioned as a percentage (12.5% × 12.5% per square — 1/8 of the board).
3. `pointer-events: none` on the container — chess.com's click handling is unaffected.
4. `scroll` and `resize` event listeners call `positionContainer()` to re-anchor when the viewport shifts.

**Board flip detection** — empirical, no class-name assumption: `isBoardFlipped()` checks whether `square-11`'s visual centre is in the right half of the board. If so, the coordinate formula inverts:

```
Normal  (White at bottom): left = (col - 1) / 8 * 100%,  top = (8 - row) / 8 * 100%
Flipped (Black at bottom): left = (8 - col) / 8 * 100%,  top = (row - 1) / 8 * 100%
```

**Visual differentiation:** `within` mode → green dots (`.km-circle::after`), `exact` mode → blue dots (`.km-circle.km-exact::after`).

---

## Board Detection

chess.com is a SPA; `<chess-board>` may not exist at script-load time. Two-phase approach:

1. **Immediate:** `document.querySelector('chess-board')` at load.
2. **Permanent MutationObserver** on `document.body` — catches the board being added after client-side navigation. The observer is **never disconnected**, so it also handles the board being removed and re-added between games (new game → new `<chess-board>` → `attachListeners()` called again).

---

## Known Limitations

| Issue | Detail |
|---|---|
| Closed shadow DOM | If chess.com uses a closed shadow root, piece detection fails. No workaround exists in a content script. |
| `exact` N semantics | BFS gives shortest-path = N. "Does any N-length cycle path exist" would require DFS — a different algorithm with different semantics. |
| z-index 9999 | Overlays may appear behind chess.com's promotion or game-over modals. |

---

## Loading the Extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked** → select this directory
4. Go to `https://www.chess.com/play/online`, start a game, click a knight
