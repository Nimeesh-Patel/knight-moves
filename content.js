/*
  content.js
  ----------
  Injected into every chess.com page. Detects the board, listens for
  knight clicks, computes reachable squares via BFS, and renders
  transparent overlay circles.

  ┌─────────────────────────────────────────────────────────────────┐
  │  Extension Architecture                                         │
  │                                                                 │
  │  popup.html / popup.js                                          │
  │      │  chrome.tabs.sendMessage()                               │
  │      ▼                                                          │
  │  content.js  ◄──── chrome.runtime.onMessage                    │
  │      │                                                          │
  │      ├── reads chess.com DOM (<chess-board>, piece elements)    │
  │      └── writes overlay divs to document.body                  │
  │                                                                 │
  │  chrome.storage.local: persists { depth, mode }                │
  └─────────────────────────────────────────────────────────────────┘

  WHY THE ORIGINAL DETECTION FAILED
  ──────────────────────────────────
  The original code assumed:
    1. Pieces are CHILDREN of square elements (.square-XY > .wN)
    2. Knight classes are uppercase: .wN, .bN

  Modern chess.com (React frontend, ~2023+) uses a FLAT DOM:
    - Square <div>s and piece <div>s are SIBLINGS inside the board
    - Knight classes are lowercase: .wn, .bn
    - Piece elements carry their own square class (e.g. class="piece wn square-26")

  So querySelector('.wN') inside a square element always returns null,
  and the handler silently bailed out on every click.

  FIX: detect the clicked PIECE element directly, then extract its
  square from the piece element itself rather than from the DOM hierarchy.
*/

// ── Debug flag ────────────────────────────────────────────────────────
// Set to false to silence all [KM] console logs and visual outlines.
const DEBUG = true;

// ── Global state ─────────────────────────────────────────────────────
const STATE = {
  depth: 2,
  mode: 'within',    // 'within' | 'exact'
  boardEl: null,
  overlayContainer: null,
  clickedSquare: null,
  _scrollListener: null,
  _resizeListener: null,
};

// ── Debug outline helpers ─────────────────────────────────────────────
/*
  We temporarily add a coloured CSS outline to elements so they are
  visually identifiable in the page without DevTools element inspector.
  References are stored so they can be restored before the next click.

  Colours:
    blue   → <chess-board> element (set once on detection)
    red    → event.target (the element the user actually clicked)
    orange → the piece element we detected
*/
const _debugOutlines = [];  // { el, originalOutline }

function setDebugOutline(el, color) {
  if (!DEBUG || !el) return;
  _debugOutlines.push({ el, originalOutline: el.style.outline });
  el.style.outline = `3px solid ${color}`;
}

function clearDebugOutlines() {
  if (!DEBUG) return;
  for (const { el, originalOutline } of _debugOutlines) {
    el.style.outline = originalOutline;
  }
  _debugOutlines.length = 0;
}

// ── DOM inspection helper ─────────────────────────────────────────────
/*
  inspectElement — logs a complete dump of one element and its ancestry.
  Use this to discover chess.com's real class names and data attributes
  when the extension isn't detecting correctly.

  Output format:
    [KM] <label>
      tag:     DIV
      class:   "piece wn square-26"
      attrs:   data-piece="wn"
      parents: DIV.board > chess-board
*/
function inspectElement(el, label) {
  if (!DEBUG || !el) return;

  const classes = el.className || '(none)';

  // Collect all non-class attributes
  const attrs = [...(el.attributes || [])]
    .filter(a => a.name !== 'class')
    .map(a => `${a.name}="${a.value}"`)
    .join('  ') || '(none)';

  // Build ancestor chain up to <chess-board>
  const parents = [];
  let node = el.parentElement;
  while (node && node.tagName !== 'CHESS-BOARD') {
    const cls = node.classList.length ? '.' + [...node.classList].join('.') : '';
    parents.push(node.tagName + cls);
    node = node.parentElement;
  }
  if (node) parents.push('chess-board');

  console.log(
    `[KM] ${label}\n` +
    `  tag:     ${el.tagName}\n` +
    `  class:   "${classes}"\n` +
    `  attrs:   ${attrs}\n` +
    `  parents: ${parents.join(' > ') || '(none)'}`
  );
}

// ── Initialisation ────────────────────────────────────────────────────

chrome.storage.local.get({ depth: 2, mode: 'within' }, (saved) => {
  STATE.depth = saved.depth;
  STATE.mode  = saved.mode;
  initBoardDetection();
});

function initBoardDetection() {
  // Phase 1: board may already exist (hard page load)
  const existing = document.querySelector('chess-board');
  if (existing) attachListeners(existing);

  // Phase 2: permanent observer — catches SPA navigation and board
  //          being removed/re-added between games
  const observer = new MutationObserver(() => {
    const board = document.querySelector('chess-board');
    if (board && board !== STATE.boardEl) {
      attachListeners(board);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function attachListeners(boardEl) {
  STATE.boardEl = boardEl;
  if (DEBUG) {
    console.log('[KM] chess-board detected:', boardEl);
    setDebugOutline(boardEl, 'blue');
  }
  boardEl.addEventListener('click', onBoardClick);
}

// ── Click handling ────────────────────────────────────────────────────

function onBoardClick(event) {
  // Clear previous debug outlines before processing this click
  clearDebugOutlines();
  if (DEBUG) setDebugOutline(STATE.boardEl, 'blue');  // keep board outline

  if (DEBUG) {
    console.log(`[KM] click on: ${event.target.tagName} class="${event.target.className}"`);
    inspectElement(event.target, 'click target');
    setDebugOutline(event.target, 'red');
  }

  // Step 1: find the piece element in the click path
  const pieceEl = detectClickedPiece(event.target);

  if (!pieceEl) {
    if (DEBUG) console.log('[KM] no piece element found in click path → clearing overlays');
    clearOverlays();
    STATE.clickedSquare = null;
    return;
  }

  if (DEBUG) {
    inspectElement(pieceEl, 'detected piece');
    setDebugOutline(pieceEl, 'orange');
  }

  // Step 2: confirm it's a knight
  const knight = isKnightPiece(pieceEl);
  if (DEBUG) console.log(`[KM] is knight: ${knight}  (classes: "${pieceEl.className}")`);

  if (!knight) {
    clearOverlays();
    STATE.clickedSquare = null;
    return;
  }

  // Step 3: extract board coordinates from the piece element
  const square = extractSquare(pieceEl);

  if (!square) {
    if (DEBUG) {
      console.log(
        `[KM] could not extract square — piece classes: "${pieceEl.className}"` +
        `  attrs: ${[...(pieceEl.attributes||[])].map(a=>`${a.name}="${a.value}"`).join(', ')}`
      );
    }
    // Don't clear overlays — keep showing whatever was there
    return;
  }

  if (DEBUG) console.log(`[KM] knight at col=${square.col} row=${square.row} — BFS depth=${STATE.depth} mode=${STATE.mode}`);

  STATE.clickedSquare = square;
  const reachable = bfs(square.col, square.row, STATE.depth, STATE.mode);
  clearOverlays();
  renderOverlays(reachable);
}

// ── Piece detection ───────────────────────────────────────────────────

/*
  detectClickedPiece — walk up from the clicked element to find the
  piece element. Returns the piece element or null.

  Modern chess.com: the user clicks ON a piece div which is a sibling
  of square divs, not a child. So we just need to find the first ancestor
  (including the target itself) that looks like a piece element.
*/
function detectClickedPiece(target) {
  let node = target;
  while (node && node.tagName !== 'CHESS-BOARD') {
    if (isPieceElement(node)) return node;
    node = node.parentElement;
  }
  return null;
}

/*
  isPieceElement — returns true if the element looks like a chess piece.

  Chess.com uses several layouts. We accept an element as a piece if ANY
  of these signals is present:

  1. Has class "piece" (base class present in most chess.com layouts)
  2. Has a class matching /^[wb][nbrqk]$/i — colour+type shorthand
     (e.g. "wn" = white knight, "bb" = black bishop)
  3. Has a data-piece attribute
  4. Has a background-image (piece sprite) set via inline style
*/
function isPieceElement(el) {
  if (!el.classList) return false;

  // Signal 1: explicit "piece" base class
  if (el.classList.contains('piece')) return true;

  // Signal 2: colour+type class like "wn", "bR", "wQ"
  const colorTypeClass = [...el.classList].some(c => /^[wb][nbrqkNBRQK]$/.test(c));
  if (colorTypeClass) return true;

  // Signal 3: data-piece attribute
  if (el.hasAttribute('data-piece')) return true;

  // Signal 4: inline background-image (sprite-based pieces)
  if (el.style && el.style.backgroundImage && el.style.backgroundImage !== 'none') return true;

  return false;
}

/*
  isKnightPiece — returns true if the piece element is a knight.

  Checks multiple class naming conventions and attributes to be robust
  across chess.com layout versions.
*/
function isKnightPiece(pieceEl) {
  if (!pieceEl.classList) return false;

  const classes = [...pieceEl.classList];

  // Modern lowercase: "wn", "bn"
  if (classes.some(c => /^[wb]n$/.test(c))) return true;

  // Legacy uppercase: "wN", "bN"
  if (classes.some(c => /^[wb]N$/.test(c))) return true;

  // Case-insensitive catch-all: /^[wb]n$/i
  if (classes.some(c => /^[wb]n$/i.test(c))) return true;

  // data-piece attribute: "wn", "bn", "knight", "white-knight", etc.
  const dataPiece = pieceEl.getAttribute('data-piece') || '';
  if (/[wb]n$/i.test(dataPiece) || dataPiece.toLowerCase().includes('knight')) return true;

  // aria-label: "White Knight", "Black Knight"
  const aria = pieceEl.getAttribute('aria-label') || '';
  if (aria.toLowerCase().includes('knight')) return true;

  return false;
}

/*
  extractSquare — get { col, row } (both 1–8) from a piece element.

  Tries 5 strategies in order, logging each attempt when DEBUG is true.
  Returns null only if all 5 fail, meaning we need to add another strategy.
*/
function extractSquare(pieceEl) {
  const classes = [...pieceEl.classList];

  // ── Strategy 1: class "square-XY" on the piece element itself ────
  // Modern chess.com puts the square class directly on the piece div.
  // e.g. class="piece wn square-26"  → col=2, row=6
  const squareCls = classes.find(c => /^square-\d\d$/.test(c));
  if (squareCls) {
    const col = parseInt(squareCls[7], 10);
    const row = parseInt(squareCls[8], 10);
    if (DEBUG) console.log(`[KM] extractSquare strategy 1 (class square-XY): col=${col} row=${row}`);
    return { col, row };
  }
  if (DEBUG) console.log('[KM] extractSquare strategy 1: no match');

  // ── Strategy 2: data-square attribute, numeric ("44") ─────────────
  // Some layouts use data-square="44" (col=4, row=4 = d4)
  const dsAttr = pieceEl.getAttribute('data-square');
  if (dsAttr && /^\d\d$/.test(dsAttr)) {
    const col = parseInt(dsAttr[0], 10);
    const row = parseInt(dsAttr[1], 10);
    if (DEBUG) console.log(`[KM] extractSquare strategy 2 (data-square numeric): col=${col} row=${row}`);
    return { col, row };
  }
  if (DEBUG && !dsAttr) console.log('[KM] extractSquare strategy 2: no data-square attr');

  // ── Strategy 3: data-square attribute, algebraic ("d4") ───────────
  // Some layouts use data-square="d4" (standard algebraic notation)
  if (dsAttr && /^[a-h][1-8]$/i.test(dsAttr)) {
    const col = 'abcdefgh'.indexOf(dsAttr[0].toLowerCase()) + 1;
    const row = parseInt(dsAttr[1], 10);
    if (DEBUG) console.log(`[KM] extractSquare strategy 3 (data-square algebraic): col=${col} row=${row}`);
    return { col, row };
  }
  if (DEBUG && dsAttr) console.log(`[KM] extractSquare strategy 2+3: data-square="${dsAttr}" did not match`);

  // ── Strategy 4: CSS transform — pixel position on the board ───────
  // Fallback for layouts that position pieces by CSS transform only.
  // Parses the transform matrix and divides by square size.
  if (STATE.boardEl) {
    const boardRect  = STATE.boardEl.getBoundingClientRect();
    const squareSize = boardRect.width / 8;
    const style      = window.getComputedStyle(pieceEl);
    const matrix     = style.transform || style.webkitTransform;

    if (matrix && matrix !== 'none') {
      // matrix(a, b, c, d, tx, ty)
      const match = matrix.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,([^,]+),([^)]+)\)/);
      if (match) {
        const tx = parseFloat(match[1]);
        const ty = parseFloat(match[2]);
        const col = Math.round(tx / squareSize) + 1;
        const row = 8 - Math.round(ty / squareSize);
        if (col >= 1 && col <= 8 && row >= 1 && row <= 8) {
          if (DEBUG) console.log(`[KM] extractSquare strategy 4 (transform pixel): col=${col} row=${row}`);
          return { col, row };
        }
      }
    }
  }
  if (DEBUG) console.log('[KM] extractSquare strategy 4: no usable transform');

  // ── Strategy 5: walk upward to find a square ancestor ─────────────
  // Defensive coverage for layouts where pieces ARE nested in squares.
  let node = pieceEl.parentElement;
  while (node && node.tagName !== 'CHESS-BOARD') {
    const cls = [...(node.classList || [])].find(c => /^square-\d\d$/.test(c));
    if (cls) {
      const col = parseInt(cls[7], 10);
      const row = parseInt(cls[8], 10);
      if (DEBUG) console.log(`[KM] extractSquare strategy 5 (ancestor square class): col=${col} row=${row}`);
      return { col, row };
    }
    node = node.parentElement;
  }
  if (DEBUG) console.log('[KM] extractSquare strategy 5: no square ancestor found');

  return null;  // all strategies exhausted
}

// ── BFS knight move computation ───────────────────────────────────────

const KNIGHT_MOVES = [
  [-2, -1], [-2, +1],
  [-1, -2], [-1, +2],
  [+1, -2], [+1, +2],
  [+2, -1], [+2, +1],
];

/*
  bfs — returns all squares reachable from (startCol, startRow) within
  maxDepth knight moves, filtered by mode.

  firstReached tracks the SHORTEST path depth to each square.

  'within':  collect squares where shortest path ≤ maxDepth
  'exact':   collect squares where shortest path = maxDepth exactly
             (a square reachable in 2 moves won't appear in "exactly 3")
*/
function bfs(startCol, startRow, maxDepth, mode) {
  const firstReached = new Map();
  const queue = [{ col: startCol, row: startRow, d: 0 }];
  firstReached.set(`${startCol},${startRow}`, 0);

  while (queue.length > 0) {
    const { col, row, d } = queue.shift();
    if (d >= maxDepth) continue;

    for (const [dc, dr] of KNIGHT_MOVES) {
      const nc = col + dc, nr = row + dr;
      if (nc < 1 || nc > 8 || nr < 1 || nr > 8) continue;
      const key = `${nc},${nr}`;
      if (firstReached.has(key)) continue;
      firstReached.set(key, d + 1);
      queue.push({ col: nc, row: nr, d: d + 1 });
    }
  }

  const result = [];
  for (const [key, depth] of firstReached) {
    if (depth === 0) continue;
    const [c, r] = key.split(',').map(Number);
    if (mode === 'within' && depth <= maxDepth) result.push({ col: c, row: r, depth });
    else if (mode === 'exact'  && depth === maxDepth) result.push({ col: c, row: r, depth });
  }
  return result;
}

// ── Overlay rendering ─────────────────────────────────────────────────

/*
  renderOverlays — appends a fixed-position container to document.body
  (never modifies chess.com's own DOM) and places circle dots on each
  reachable square.

  The container is anchored to the board via getBoundingClientRect()
  and reanchored on scroll/resize.

  Board flip is detected empirically: if square-11 (a1) is visually
  in the right half of the board, we're viewing it from Black's side.
*/
function renderOverlays(squares) {
  if (!STATE.boardEl || squares.length === 0) return;

  const container = document.createElement('div');
  container.className = 'km-overlay-container';
  document.body.appendChild(container);
  STATE.overlayContainer = container;

  positionContainer(container);

  const flipped = isBoardFlipped();

  for (const { col, row } of squares) {
    const circle = document.createElement('div');
    circle.className = 'km-circle';
    if (STATE.mode === 'exact') circle.classList.add('km-exact');

    // Normal  (White at bottom): left = (col-1)/8,  top = (8-row)/8
    // Flipped (Black at bottom): left = (8-col)/8,  top = (row-1)/8
    const leftPct = flipped ? (8 - col) / 8 * 100 : (col - 1) / 8 * 100;
    const topPct  = flipped ? (row - 1) / 8 * 100 : (8 - row) / 8 * 100;
    circle.style.left = leftPct + '%';
    circle.style.top  = topPct  + '%';

    container.appendChild(circle);
  }

  STATE._scrollListener = () => positionContainer(container);
  STATE._resizeListener  = () => positionContainer(container);
  window.addEventListener('scroll', STATE._scrollListener, { passive: true });
  window.addEventListener('resize', STATE._resizeListener, { passive: true });
}

function positionContainer(container) {
  if (!STATE.boardEl) return;
  const rect = STATE.boardEl.getBoundingClientRect();
  container.style.left   = rect.left   + 'px';
  container.style.top    = rect.top    + 'px';
  container.style.width  = rect.width  + 'px';
  container.style.height = rect.height + 'px';
}

/*
  isBoardFlipped — empirical detection: if a1 (square-11) is visually
  in the right half of the board, the board is showing Black's perspective.
*/
function isBoardFlipped() {
  const sq11 = findSquareEl(1, 1);
  if (!sq11) return false;

  const boardRect = STATE.boardEl.getBoundingClientRect();
  const sqRect    = sq11.getBoundingClientRect();
  return (sqRect.left + sqRect.width / 2) > (boardRect.left + boardRect.width / 2);
}

/*
  findSquareEl — locate the DOM element for a given square coordinate.
  Used by isBoardFlipped(). Tries light DOM, then open shadow root.
*/
function findSquareEl(col, row) {
  const selector = `.square-${col}${row}`;
  let el = STATE.boardEl.querySelector(selector);
  if (el) return el;
  if (STATE.boardEl.shadowRoot) {
    el = STATE.boardEl.shadowRoot.querySelector(selector);
    if (el) return el;
  }
  el = document.querySelector(selector);
  return el || null;
}

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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'SETTINGS_UPDATE') return;

  STATE.depth = msg.depth;
  STATE.mode  = msg.mode;

  if (STATE.clickedSquare) {
    const { col, row } = STATE.clickedSquare;
    const reachable = bfs(col, row, STATE.depth, STATE.mode);
    clearOverlays();
    renderOverlays(reachable);
  }

  sendResponse({ ok: true });
});
