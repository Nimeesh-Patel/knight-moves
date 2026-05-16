/*
  content.js
  ----------
  This script is injected into every chess.com page by the browser
  (declared in manifest.json → content_scripts).

  It runs in an isolated JavaScript environment — it can read and
  modify the page's DOM, but it cannot access chess.com's own JS
  variables, and chess.com's JS cannot access ours.

  Responsibilities:
  1. Wait for the <chess-board> element to appear (handles both
     immediate load and SPA navigation).
  2. On click: detect which square was clicked and whether it holds
     a knight.
  3. Compute reachable squares via BFS.
  4. Render transparent overlay circles on those squares.
  5. Listen for settings changes from the popup.

  ┌─────────────────────────────────────────────────────────────────┐
  │  Extension Architecture (big picture)                           │
  │                                                                 │
  │  popup.html / popup.js                                          │
  │      │  chrome.tabs.sendMessage()                               │
  │      ▼                                                          │
  │  content.js  ◄──── chrome.runtime.onMessage                    │
  │      │                                                          │
  │      ├── reads chess.com DOM (<chess-board>, .square-XY, .wN)  │
  │      └── writes overlay divs to document.body                  │
  │                                                                 │
  │  chrome.storage.local: persists { depth, mode } across opens   │
  └─────────────────────────────────────────────────────────────────┘
*/

// ── Global state ────────────────────────────────────────────────────
/*
  We keep a small state object rather than scattered globals so that
  all mutable data is in one place and easy to reason about.
*/
const STATE = {
  depth: 2,         // how many knight moves to compute (1–4)
  mode: 'within',   // 'within' = up to depth, 'exact' = shortest-path = depth

  boardEl: null,            // reference to the <chess-board> DOM element
  overlayContainer: null,   // the single div we append to document.body for overlays
  clickedSquare: null,      // { col, row } of the last clicked knight, or null

  // We store references to the scroll/resize listeners so we can
  // remove them when we clear overlays (avoid listener leaks)
  _scrollListener: null,
  _resizeListener: null,
};

// ── Initialisation ──────────────────────────────────────────────────

/*
  Load saved settings from storage, then start watching for the board.
  We load settings first so that the first click uses the right values.
*/
chrome.storage.local.get({ depth: 2, mode: 'within' }, (saved) => {
  STATE.depth = saved.depth;
  STATE.mode  = saved.mode;
  initBoardDetection();
});

/*
  initBoardDetection — two-phase board detection
  ───────────────────────────────────────────────
  Phase 1: The board may already be in the DOM when this script runs
           (e.g., hard-loading a game URL). Try to find it immediately.

  Phase 2: Chess.com is a Single-Page Application (SPA). Navigating
           between pages happens without a full page reload, so the
           <chess-board> element is added to the DOM after our script
           has already run. A MutationObserver fires whenever DOM nodes
           are added/removed, so we use one to catch this.

           We keep the observer PERMANENTLY ALIVE (never disconnect it)
           so that if the user starts a new game — which removes and
           re-adds <chess-board> — we re-attach our click listener to
           the fresh element.
*/
function initBoardDetection() {
  // Phase 1: immediate check
  const existing = document.querySelector('chess-board');
  if (existing) {
    attachListeners(existing);
  }

  // Phase 2: watch for future additions / replacements
  const observer = new MutationObserver(() => {
    const board = document.querySelector('chess-board');
    if (board && board !== STATE.boardEl) {
      // A new (or replaced) <chess-board> appeared
      attachListeners(board);
    }
  });

  observer.observe(document.body, {
    childList: true,   // watch for direct children being added/removed
    subtree: true,     // … at any depth in the tree
  });
}

/*
  attachListeners — called once per <chess-board> element
  ────────────────────────────────────────────────────────
  We use EVENT DELEGATION: instead of attaching a listener to each
  individual square, we attach one listener to the board element.
  When any descendant is clicked, the event bubbles up to the board
  and we inspect event.target to figure out which square was clicked.

  This is more efficient (one listener instead of 64) and automatically
  covers dynamically added squares.
*/
function attachListeners(boardEl) {
  STATE.boardEl = boardEl;
  boardEl.addEventListener('click', onBoardClick);
}

// ── Click handling ───────────────────────────────────────────────────

/*
  onBoardClick — entry point for all clicks on the board
  ──────────────────────────────────────────────────────
  Determines what was clicked and acts accordingly.
*/
function onBoardClick(event) {
  // Find the square element (div with a class like "square-34")
  const squareInfo = getSquareFromEl(event.target);

  if (!squareInfo) {
    // Clicked somewhere on the board that isn't a square (e.g., the border)
    clearOverlays();
    STATE.clickedSquare = null;
    return;
  }

  const { col, row, el: squareEl } = squareInfo;

  // Check whether this square has a knight on it
  if (!squareHasKnight(squareEl)) {
    clearOverlays();
    STATE.clickedSquare = null;
    return;
  }

  // We have a knight — compute and render
  STATE.clickedSquare = { col, row };
  const reachable = bfs(col, row, STATE.depth, STATE.mode);
  clearOverlays();
  renderOverlays(reachable);
}

/*
  getSquareFromEl — walk up the DOM from the clicked element to find
                    the enclosing square div.

  Chess.com squares have a class like "square-34" where:
    first digit  = column (file): 1=a … 8=h
    second digit = row (rank):    1=rank 1 … 8=rank 8

  We also handle the case where the piece element itself carries the
  square class (chess.com sometimes puts it on both the square div
  and the piece div).

  Returns { col, row, el } or null if no square was found.
*/
function getSquareFromEl(el) {
  let node = el;

  // Walk up from the clicked element to (but not past) <chess-board>
  while (node && node.tagName !== 'CHESS-BOARD') {
    // Check every class on this element for the pattern "square-XY"
    const squareClass = [...node.classList].find(c => /^square-\d\d$/.test(c));
    if (squareClass) {
      // squareClass is e.g. "square-34"
      // Index 7 = first digit after "square-", index 8 = second digit
      const col = parseInt(squareClass[7], 10);
      const row = parseInt(squareClass[8], 10);
      return { col, row, el: node };
    }
    node = node.parentElement;
  }

  return null;  // clicked outside any square
}

/*
  squareHasKnight — returns true if the given square element contains
                    a knight piece.

  Chess.com piece elements have class names like:
    "piece wN"  → white knight
    "piece bN"  → black knight

  We try two strategies to find the piece:

  Strategy A: The piece is a CHILD of the square div.
    squareEl.querySelector('.wN, .bN')

  Strategy B: Chess.com sometimes puts the square class on the piece
    element itself. In that case the piece and square are the SAME element.
    We check squareEl itself for the knight class.

  Shadow DOM note:
    If chess.com uses an open shadow root, we also try shadowRoot.
    A closed shadow root cannot be accessed from a content script at all —
    if that's the case, we log a clear error rather than failing silently.
*/
function squareHasKnight(squareEl) {
  // Strategy A: piece is a child element
  const childKnight = squareEl.querySelector('.wN, .bN');
  if (childKnight) return true;

  // Strategy B: the square element itself is the piece element
  if (squareEl.classList.contains('wN') || squareEl.classList.contains('bN')) {
    return true;
  }

  // Strategy C: open shadow DOM fallback
  if (squareEl.shadowRoot) {
    const shadowKnight = squareEl.shadowRoot.querySelector('.wN, .bN');
    if (shadowKnight) return true;
  }

  return false;
}

// ── BFS knight move computation ───────────────────────────────────────

/*
  All 8 possible knight moves as [deltaCol, deltaRow] pairs.
  A knight moves in an "L" shape: 2 squares in one direction,
  1 square perpendicular (or vice versa).
*/
const KNIGHT_MOVES = [
  [-2, -1], [-2, +1],
  [-1, -2], [-1, +2],
  [+1, -2], [+1, +2],
  [+2, -1], [+2, +1],
];

/*
  bfs — Breadth-First Search for knight reachability

  Parameters:
    startCol, startRow  — starting position (1–8)
    maxDepth            — maximum number of knight moves
    mode                — 'within' or 'exact'

  Returns an array of objects { col, row, depth } for each reachable
  square, filtered by mode.

  How BFS works here:
  ───────────────────
  We maintain a queue of positions to explore. Each entry records
  the position (col, row) and the number of moves taken to reach it (d).

  We also maintain a Map from "col,row" → first depth at which we
  reached that square. This prevents us from visiting the same square
  twice (which would cause infinite loops) and tells us the SHORTEST
  path length to each square.

  Mode semantics:
  ───────────────
  'within N':  collect all squares whose shortest path ≤ N moves.
  'exact N':   collect only squares whose shortest path = exactly N moves.
               Note: a square reachable in 2 moves is NOT in "exactly 3"
               results, even if there's a longer 3-move path. This is
               the BFS shortest-path interpretation, which is most
               useful for "how many moves minimum does the knight need."
*/
function bfs(startCol, startRow, maxDepth, mode) {
  // Map from "col,row" string key → depth at first visit
  const firstReached = new Map();

  // Queue: each entry is { col, row, d } where d = depth (moves so far)
  const queue = [{ col: startCol, row: startRow, d: 0 }];
  firstReached.set(`${startCol},${startRow}`, 0);

  while (queue.length > 0) {
    const { col, row, d } = queue.shift();  // dequeue from front (BFS)

    // Don't expand beyond the maximum depth
    if (d >= maxDepth) continue;

    for (const [dc, dr] of KNIGHT_MOVES) {
      const nc = col + dc;  // new column
      const nr = row + dr;  // new row

      // Bounds check: board is 1–8 in both dimensions
      if (nc < 1 || nc > 8 || nr < 1 || nr > 8) continue;

      const key = `${nc},${nr}`;
      if (firstReached.has(key)) continue;  // already visited — skip

      firstReached.set(key, d + 1);
      queue.push({ col: nc, row: nr, d: d + 1 });
    }
  }

  // Build the result array, excluding the start square and filtering by mode
  const result = [];
  for (const [key, depth] of firstReached) {
    if (depth === 0) continue;  // skip the start square itself

    const [c, r] = key.split(',').map(Number);

    if (mode === 'within' && depth <= maxDepth) {
      result.push({ col: c, row: r, depth });
    } else if (mode === 'exact' && depth === maxDepth) {
      result.push({ col: c, row: r, depth });
    }
  }

  return result;
}

// ── Overlay rendering ─────────────────────────────────────────────────

/*
  renderOverlays — draw circle dots on all reachable squares.

  Approach:
    We create a single "container" div and append it to document.body.
    The container is sized and positioned to exactly cover the board
    using position:fixed + the board's getBoundingClientRect().

    Inside the container, each reachable square gets a .km-circle div
    positioned as a percentage (so it scales with the board size).

    Why position:fixed anchored to board rect instead of appending
    inside <chess-board>?
    ──────────────────────────────────────────────────────────────────
    Appending inside <chess-board> risks breaking chess.com's internal
    event handling or layout. Using a fixed-position overlay on
    document.body is non-invasive: we never modify chess.com's DOM.

    Why scroll/resize listeners?
    ──────────────────────────────────────────────────────────────────
    position:fixed is relative to the VIEWPORT, not the document.
    If the page scrolls or the window resizes, the board moves but
    our fixed container doesn't — we must recompute its position.
*/
function renderOverlays(squares) {
  if (!STATE.boardEl || squares.length === 0) return;

  // Create the container div
  const container = document.createElement('div');
  container.className = 'km-overlay-container';
  document.body.appendChild(container);
  STATE.overlayContainer = container;

  // Position container to cover the board
  positionContainer(container);

  // Determine board orientation (flipped = playing as Black)
  const flipped = isBoardFlipped();

  // Create one circle div per reachable square
  for (const { col, row, depth } of squares) {
    const circle = document.createElement('div');
    circle.className = 'km-circle';

    // Add mode-specific class for colour differentiation (see styles.css)
    if (STATE.mode === 'exact') {
      circle.classList.add('km-exact');
    }

    /*
      Calculate percentage-based position within the container.

      The board is 8×8. Each square occupies 12.5% of width/height.

      Normal orientation (White at bottom):
        col 1 (a-file) is at the LEFT   → left = (col - 1) / 8 * 100%
        row 1 (rank 1) is at the BOTTOM → top  = (8 - row) / 8 * 100%

      Flipped orientation (Black at bottom):
        col 1 (a-file) is at the RIGHT  → left = (8 - col) / 8 * 100%
        row 1 (rank 1) is at the TOP    → top  = (row - 1) / 8 * 100%
    */
    let leftPct, topPct;
    if (flipped) {
      leftPct = (8 - col) / 8 * 100;
      topPct  = (row - 1) / 8 * 100;
    } else {
      leftPct = (col - 1) / 8 * 100;
      topPct  = (8 - row) / 8 * 100;
    }

    circle.style.left = leftPct + '%';
    circle.style.top  = topPct  + '%';

    container.appendChild(circle);
  }

  // Re-anchor the container when the page scrolls or the window resizes
  STATE._scrollListener = () => positionContainer(container);
  STATE._resizeListener  = () => positionContainer(container);
  window.addEventListener('scroll', STATE._scrollListener, { passive: true });
  window.addEventListener('resize', STATE._resizeListener, { passive: true });
}

/*
  positionContainer — sync the overlay container's position with the
                       board's current viewport position.
*/
function positionContainer(container) {
  if (!STATE.boardEl) return;
  const rect = STATE.boardEl.getBoundingClientRect();
  container.style.left   = rect.left   + 'px';
  container.style.top    = rect.top    + 'px';
  container.style.width  = rect.width  + 'px';
  container.style.height = rect.height + 'px';
}

/*
  isBoardFlipped — detect whether we're viewing the board from Black's side.

  We don't rely on any specific chess.com CSS class (which could change).
  Instead we measure: if the square-11 element (a1, bottom-left for White)
  is visually in the RIGHT half of the board, the board is flipped.

  Returns true if the board is flipped (Black's perspective).
*/
function isBoardFlipped() {
  const sq11 = findSquareEl(1, 1);
  if (!sq11) return false;  // can't determine — assume not flipped

  const boardRect = STATE.boardEl.getBoundingClientRect();
  const sqRect    = sq11.getBoundingClientRect();

  const sqCenterX    = sqRect.left + sqRect.width / 2;
  const boardCenterX = boardRect.left + boardRect.width / 2;

  // If a1's visual centre is to the RIGHT of the board centre, it's flipped
  return sqCenterX > boardCenterX;
}

/*
  findSquareEl — find the DOM element for a given board coordinate.

  Tries light DOM (normal), then the board element's open shadow root.
  Logs a descriptive error if neither works (closed shadow DOM, etc.).
*/
function findSquareEl(col, row) {
  const selector = `.square-${col}${row}`;

  // Attempt 1: normal DOM search from the board element
  let el = STATE.boardEl.querySelector(selector);
  if (el) return el;

  // Attempt 2: open shadow root
  if (STATE.boardEl.shadowRoot) {
    el = STATE.boardEl.shadowRoot.querySelector(selector);
    if (el) return el;
  }

  // Attempt 3: search the full document (some chess.com layouts)
  el = document.querySelector(selector);
  if (el) return el;

  console.warn(
    `[Knight Moves] Could not find square element for col=${col} row=${row}.` +
    ` Chess.com may be using a closed shadow DOM, which cannot be accessed` +
    ` from a content script.`
  );
  return null;
}

/*
  clearOverlays — remove all overlay circles and clean up listeners.
*/
function clearOverlays() {
  if (STATE.overlayContainer) {
    STATE.overlayContainer.remove();
    STATE.overlayContainer = null;
  }
  if (STATE._scrollListener) {
    window.removeEventListener('scroll', STATE._scrollListener);
    STATE._scrollListener = null;
  }
  if (STATE._resizeListener) {
    window.removeEventListener('resize', STATE._resizeListener);
    STATE._resizeListener = null;
  }
}

// ── Message listener (popup → content script) ─────────────────────────

/*
  The popup sends a 'SETTINGS_UPDATE' message whenever the user changes
  the depth slider or mode radio. We update STATE and immediately
  re-render if a knight is currently selected.

  chrome.runtime.onMessage.addListener(callback)
  ────────────────────────────────────────────────
  This is how content scripts receive messages sent via
  chrome.tabs.sendMessage() from popup.js or the background.
  The callback receives:
    msg        — the message object
    sender     — info about who sent it (tab, extension, etc.)
    sendResponse — function to send a reply (optional)
*/
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'SETTINGS_UPDATE') return;

  STATE.depth = msg.depth;
  STATE.mode  = msg.mode;

  // If the user has already clicked a knight, re-draw with the new settings
  if (STATE.clickedSquare) {
    const { col, row } = STATE.clickedSquare;
    const reachable = bfs(col, row, STATE.depth, STATE.mode);
    clearOverlays();
    renderOverlays(reachable);
  }

  // Acknowledge the message (prevents "message port closed" warnings)
  sendResponse({ ok: true });
});
