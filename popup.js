/*
  popup.js
  --------
  Runs inside the popup window (popup.html).

  Responsibilities:
  1. Read saved settings from chrome.storage.local and initialise the UI.
  2. When the user moves the slider or changes the radio:
       a. Save the new settings back to chrome.storage.local.
       b. Send a message to the active chess.com tab so content.js
          can immediately re-draw the overlays with the new depth/mode.

  Architecture note — why chrome.storage instead of just a message?
  ──────────────────────────────────────────────────────────────────
  The popup is destroyed every time the user closes it. If we only kept
  settings in memory inside popup.js, they'd be lost. chrome.storage.local
  persists across popup opens and even across browser restarts.
  content.js reads these settings on load so it always starts with the
  last values the user chose.
*/

document.addEventListener('DOMContentLoaded', () => {

  // ── Grab UI elements ──────────────────────────────────────────────
  const slider  = document.getElementById('depth-slider');
  const display = document.getElementById('depth-display');  // the number shown next to "Depth:"
  const radios  = document.querySelectorAll('input[name="mode"]');

  // ── 1. Load saved settings and sync UI ───────────────────────────
  /*
    chrome.storage.local.get(defaults, callback)
    The second argument provides default values for keys that haven't
    been saved yet (first run). The callback receives an object with
    the stored values (or the defaults).
  */
  chrome.storage.local.get({ depth: 2, mode: 'within' }, (saved) => {
    slider.value      = saved.depth;
    display.textContent = saved.depth;

    // Check the radio whose value matches the saved mode
    radios.forEach(r => {
      r.checked = (r.value === saved.mode);
    });
  });

  // ── 2. Helper: read current UI state, save it, and notify the tab ─
  function pushSettings() {
    const depth = parseInt(slider.value, 10);   // slider.value is a string
    const mode  = [...radios].find(r => r.checked).value;  // 'within' or 'exact'

    // Update the depth number displayed next to the slider
    display.textContent = depth;

    // Persist to storage so the next popup open reflects this choice
    chrome.storage.local.set({ depth, mode });

    /*
      Send the new settings to the content script running in the
      currently active chess.com tab.

      chrome.tabs.query({active:true, currentWindow:true}) returns the
      tab the user is looking at right now. We don't need the "tabs"
      permission for this specific query — it's allowlisted in MV3.
    */
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;  // no active tab (shouldn't happen but be safe)

      chrome.tabs.sendMessage(tabs[0].id, {
        type:  'SETTINGS_UPDATE',
        depth: depth,
        mode:  mode,
      })
      /*
        .catch() swallows errors that occur when:
        - The active tab is not chess.com (content.js not injected).
        - The content script hasn't loaded yet.
        In both cases there's nothing to update — silently do nothing.
      */
      .catch(() => {});
    });
  }

  // ── 3. Attach event listeners ─────────────────────────────────────
  /*
    'input' fires continuously while the slider is being dragged,
    giving live feedback as the user moves it.
  */
  slider.addEventListener('input', pushSettings);

  /*
    'change' fires when a different radio button is selected.
  */
  radios.forEach(r => r.addEventListener('change', pushSettings));

});
