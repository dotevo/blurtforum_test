/**
 * modules/cinema/dpad-nav.ts
 *
 * D-pad/keyboard navigation for cinema mode, as an explicit state machine
 * over well-defined UI zones — NOT a generic "closest element on screen"
 * search. An earlier version of this file tried the generic approach and
 * it was wrong: picking whatever's nearest by raw pixel distance has no
 * concept of "these buttons belong together" or "this is a different UI
 * region entirely", so pressing Down from a grid card could land on a rail
 * item three rows away just because it happened to be the closest point,
 * pressing Up inside an open panel could escape it by accident, and modals
 * weren't trapped at all. Each zone below owns its own up/down/left/right
 * meaning, and the ONLY moves between zones are the explicit ones spelled
 * out here.
 *
 * Zones, in priority order (checked top to bottom on every keydown):
 *   0. PIN_PAD — a Chromecast-style zone PIN entry (see modules/
 *                device-profiles/PinPad.vue) is on screen. Owns every key
 *                except Escape completely; not a roving-focus zone at all,
 *                see pinpad-state.ts.
 *   1. MODAL   — any open .modal-overlay. Fully traps navigation until
 *                closed: arrows/Enter cycle only its own focusable
 *                elements, Escape closes it. Nothing outside is reachable.
 *   2. PANEL   — a rail side-panel (notifications/payout) or an open
 *                player tab (queue/playlists/settings/...). Up/Down move
 *                within it; Left/Right or Escape close it.
 *   3. RAIL    — focus is inside the cinema rail (no panel open). Up/Down
 *                move between rail items; Left/Right or Escape collapse it
 *                and hand focus back to wherever it was before.
 *   4. PLAYER  — cinema fullscreen video, no tab open. Left/Right move
 *                within the current control row; Up/Down switch between
 *                the icon column and the controls row; Escape exits
 *                fullscreen back to browsing.
 *   5. GRID    — the browse grid (CinemaIndex). Left/Right/Up/Down move
 *                across cards; Left at the first column opens the rail;
 *                Escape also opens the rail.
 */
import { state as playerState, stopAll, showCinemaControls } from '../player/player';
import {
  pinZone, pinMoveZone, pinCommit, pinDownInZoneC, getPinZoneDigits,
} from '../device-profiles/pinpad-state';

let installed = false;
let isActive: () => boolean = () => false;
let lastContentFocus: HTMLElement | null = null;

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  // Cinema's auto-hiding controls fade via opacity+pointer-events rather
  // than unmounting (see MediaPlayer.vue's .bfp-cinema-controls-hidden) —
  // those are momentarily unreachable too, same as the mouse can't click
  // them right now either.
  if (parseFloat(style.opacity) === 0 || style.pointerEvents === 'none') return false;
  return true;
}

const NAV_SELECTOR = [
  'a[href]', 'button:not(:disabled)', 'select', 'input:not([type="hidden"])', 'textarea',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function navigableWithin(container: ParentNode): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(NAV_SELECTOR))
    .filter(isVisible)
    // Escape already closes modals/panels -- the close button itself
    // doesn't need to also compete for arrow-key roving focus (and if it
    // did, it'd typically be the very first stop, right before the actual
    // content, which is exactly the wrong thing to land on by default).
    .filter(el => !el.classList.contains('modal-close') && !el.classList.contains('cinema-side-panel-close'));
}

/**
 * A `.dpad-row` groups a set of horizontally-adjacent controls (a row of
 * color swatches, a row of small icon-only toggle buttons, etc.) so
 * Left/Right move between them as one unit, while Up/Down still treats the
 * whole row as a single stop when moving between it and whatever comes
 * before/after it vertically. Without this, a MODAL/PANEL zone's plain
 * flat list of focusable elements has no way to know several buttons in a
 * row are "one field" for vertical purposes -- Up/Down would stop on every
 * individual swatch one at a time, and (in a PANEL, where Left/Right means
 * "close") there'd be no way to move between swatches with the keyboard at
 * all.
 *
 * Just a marker class -- wrap any row of buttons/links in an element with
 * this class and both zones pick it up automatically, no JS registration
 * needed. See moveWithinRow/verticalStops below for the mechanics, and
 * device-profiles' CinemaProfileGate.vue/ManageProfiles.vue for real usage
 * (the avatar-color swatch rows).
 */
function verticalStops(container: HTMLElement): HTMLElement[] {
  const all = navigableWithin(container);
  const stops: HTMLElement[] = [];
  const seenRows = new Set<HTMLElement>();
  for (const el of all) {
    const row = el.closest<HTMLElement>('.dpad-row');
    if (row && container.contains(row)) {
      if (seenRows.has(row)) continue; // later children of an already-collapsed row
      seenRows.add(row);
      stops.push(el); // first navigable child in DOM order represents the whole row
    } else {
      stops.push(el);
    }
  }
  return stops;
}

/** Finds which stop the currently-focused element belongs to -- not always
 *  an exact match, since a stop representing a `.dpad-row` is just that
 *  row's first child, but focus could legitimately be on its 2nd/3rd child
 *  (after moving with Left/Right via moveWithinRow). */
function currentStopIndex(stops: HTMLElement[], ae: HTMLElement | null): number {
  if (!ae) return -1;
  for (let i = 0; i < stops.length; i++) {
    const row = stops[i].closest<HTMLElement>('.dpad-row');
    if (row ? row.contains(ae) : stops[i] === ae) return i;
  }
  return -1;
}

/** Moves focus among a `.dpad-row`'s own children by `dir` (-1/+1), clamped
 *  at the row's own edges -- deliberately doesn't wrap or fall through to
 *  the zone's own Left/Right meaning at the edge (e.g. PANEL's "Left/Right
 *  closes the panel"); reaching the end of a row is a natural stopping
 *  point, not a cue to leave it. */
function moveWithinRow(row: HTMLElement, dir: number): void {
  const items = navigableWithin(row);
  if (!items.length) return;
  const ae = document.activeElement as HTMLElement | null;
  const idx = ae ? items.indexOf(ae) : -1;
  const next = idx === -1 ? 0 : Math.max(0, Math.min(items.length - 1, idx + dir));
  items[next]?.focus({ preventScroll: true });
}

function isTypingTarget(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return !['range', 'number', 'checkbox', 'radio', 'button'].includes((el as HTMLInputElement).type);
  return false;
}

/** Generalizes what used to be volume-slider-only "edit mode" to any input
 *  where an arrow axis has a native meaning that conflicts with using that
 *  same axis to move focus: a <input type="range"> owns Left/Right
 *  (adjusting its value) and a <input type="number"> owns Up/Down (its
 *  native increment/decrement spinner) -- but only once Enter/Space has
 *  explicitly "opened" it for editing. Before that, arrows move on to the
 *  next stop like any other control; there'd be no way to navigate PAST
 *  one otherwise, since a TV remote has no Tab key to fall back on. */
let editingControl: HTMLElement | null = null;

function isEditableControl(el: HTMLElement | null): boolean {
  if (!el || el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return type === 'range' || type === 'number';
}

/** Elements that already do something sensible with Left/Right themselves:
 *  - the seek bar (role="slider") always owns them -- it's a standalone
 *    full-width control with no sibling buttons to navigate past, so
 *    there's no ambiguity to resolve.
 *  - a range input only owns them once explicitly opened for editing (see
 *    editingControl above) -- it sits inline among sibling buttons in a
 *    controls row, where Left/Right is genuinely ambiguous between "adjust
 *    the value" and "move to the next button". */
function ownsHorizontalArrows(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.getAttribute('role') === 'slider') return true;
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'range') return editingControl === el;
  return false;
}

/** Same idea as ownsHorizontalArrows, but for a <input type="number">'s
 *  native Up/Down spinner -- only owns Up/Down once explicitly opened for
 *  editing (e.g. ManageProfiles.vue's daily watch-limit field, sitting
 *  among other fields where Up/Down normally means "move to the next
 *  one"). */
function ownsVerticalArrows(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'number') return editingControl === el;
  return false;
}

/** Activates whatever's focused on Enter/Space. Explicit and unconditional
 *  (always calls click()/showPicker()) rather than relying on the browser's
 *  own "Enter activates a focused button" behavior firing through on its
 *  own -- that depends on nothing upstream having called preventDefault(),
 *  which isn't a safe assumption with a capture-phase listener in the mix,
 *  and doesn't apply at all to <select> (Enter doesn't open a native
 *  dropdown in most browsers; showPicker() is the actual API for that). */
function activateFocused(el: HTMLElement): void {
  if (el.tagName === 'SELECT') {
    (el as HTMLSelectElement & { showPicker?: () => void }).showPicker?.();
    return;
  }
  if (isEditableControl(el)) return; // Enter/Space toggles edit-mode instead (see below), not a click
  el.click();
}

function focusFirst(els: HTMLElement[]): void {
  els[0]?.focus({ preventScroll: true });
  els[0]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── MODAL zone ───────────────────────────────────────────────────────────
function getOpenModal(): HTMLElement | null {
  const overlays = Array.from(document.querySelectorAll<HTMLElement>('.modal-overlay'));
  return overlays.length ? overlays[overlays.length - 1] : null;
}

function handleModalZone(e: KeyboardEvent, modal: HTMLElement): void {
  const key = e.key;
  const ae = document.activeElement as HTMLElement | null;

  if (key === 'Escape') {
    e.preventDefault();
    modal.querySelector<HTMLElement>('.modal-close')?.click();
    return;
  }
  if (key === 'Enter' || key === ' ') {
    if (ae && navigableWithin(modal).includes(ae)) { e.preventDefault(); activateFocused(ae); }
    return;
  }
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return;
  if ((key === 'ArrowLeft' || key === 'ArrowRight') && ownsHorizontalArrows(ae)) return;
  if ((key === 'ArrowUp' || key === 'ArrowDown') && ownsVerticalArrows(ae)) return;

  // Row grouping (see .dpad-row's own doc comment above navigableWithin):
  // Left/Right move between a row's own children instead of the modal's
  // next overall stop, whenever focus is already inside one.
  const row = ae?.closest<HTMLElement>('.dpad-row');
  if (row && modal.contains(row) && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    e.preventDefault();
    moveWithinRow(row, key === 'ArrowLeft' ? -1 : 1);
    return;
  }

  e.preventDefault();
  const stops = verticalStops(modal);
  if (!stops.length) return;
  const idx = currentStopIndex(stops, ae);
  if (idx === -1) { focusFirst(stops); return; }
  const dir = (key === 'ArrowDown' || key === 'ArrowRight') ? 1 : -1;
  const next = stops[(idx + dir + stops.length) % stops.length];
  next.focus({ preventScroll: true });
  next.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── PANEL zone (rail side-panel, or an open player tab) ───────────────────
function getOpenPanel(): HTMLElement | null {
  const sidePanel = document.querySelector<HTMLElement>('.cinema-side-panel');
  if (sidePanel) return sidePanel;
  if (playerState.cinema && playerState.expandedTab && playerState.expandedTab !== 'video') {
    const bodies = Array.from(document.querySelectorAll<HTMLElement>('.bfp-panel--cinema .bfp-panel-body'));
    return bodies.find(isVisible) ?? null;
  }
  return null;
}

function closePanel(panel: HTMLElement): void {
  const closeBtn = panel.querySelector<HTMLElement>('.cinema-side-panel-close');
  if (closeBtn) { closeBtn.click(); return; }
  // Player tab panel: no dedicated close button, just switch back to video.
  if (playerState.cinema) playerState.expandedTab = 'video';
}

function handlePanelZone(e: KeyboardEvent, panel: HTMLElement): void {
  const key = e.key;
  const ae = document.activeElement as HTMLElement | null;

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const row = ae?.closest<HTMLElement>('.dpad-row');
    if (row && panel.contains(row)) {
      e.preventDefault();
      moveWithinRow(row, key === 'ArrowLeft' ? -1 : 1);
      return;
    }
  }
  if (key === 'Escape' || key === 'ArrowLeft' || key === 'ArrowRight') {
    e.preventDefault();
    closePanel(panel);
    return;
  }
  if (key === 'Enter' || key === ' ') {
    if (ae && panel.contains(ae)) { e.preventDefault(); activateFocused(ae); }
    return;
  }
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return;
  if (ownsVerticalArrows(ae)) return;
  e.preventDefault();
  const stops = verticalStops(panel);
  if (!stops.length) return;
  const idx = currentStopIndex(stops, ae);
  if (idx === -1) { focusFirst(stops); return; }
  const next = stops[Math.max(0, Math.min(stops.length - 1, idx + (key === 'ArrowDown' ? 1 : -1)))];
  next.focus({ preventScroll: true });
  next.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── RAIL zone ────────────────────────────────────────────────────────────
function focusRailFirstItem(): void {
  const rail = document.querySelector<HTMLElement>('.cinema-rail');
  if (!rail) return;
  // The logo is the first item in DOM order but isn't a useful place to
  // land by default -- skip straight to whatever's next (the "Videos"
  // home link, in practice) and let logo remain reachable by navigating
  // there deliberately instead of being the default entry point.
  const items = navigableWithin(rail).filter(el => !el.classList.contains('rail-logo'));
  focusFirst(items.length ? items : navigableWithin(rail));
}

function handleRailZone(e: KeyboardEvent, rail: HTMLElement): void {
  const key = e.key;
  if (key === 'Escape' || key === 'ArrowLeft' || key === 'ArrowRight') {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    if (lastContentFocus && document.contains(lastContentFocus)) lastContentFocus.focus({ preventScroll: true });
    return;
  }
  if (key === 'Enter' || key === ' ') {
    const ae = document.activeElement as HTMLElement | null;
    if (ae) { e.preventDefault(); activateFocused(ae); }
    return;
  }
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return;
  e.preventDefault();
  const items = navigableWithin(rail);
  if (!items.length) return;
  const ae = document.activeElement as HTMLElement | null;
  const idx = ae ? items.indexOf(ae) : -1;
  if (idx === -1) { focusFirst(items); return; }
  const next = items[Math.max(0, Math.min(items.length - 1, idx + (key === 'ArrowDown' ? 1 : -1)))];
  next.focus({ preventScroll: true });
}

// ── PLAYER zone (cinema fullscreen, video tab) ────────────────────────────
function handlePlayerZone(e: KeyboardEvent): void {
  const key = e.key;
  const panelEl = document.querySelector<HTMLElement>('.bfp-panel--cinema');
  if (!panelEl) return;

  if (key === 'Escape') {
    e.preventDefault();
    // The browse grid has no playback controls of any kind -- leaving
    // fullscreen with something still playing (or, worse, an async init
    // still in flight that's about to force .play() once it resolves, see
    // mediaGeneration in player.ts) means there'd be nothing on screen to
    // stop it with until fullscreen is reopened. Hard-stopping on the way
    // out closes that gap entirely rather than trying to track every path
    // that could leave something running unattended.
    stopAll();
    playerState.expanded = false;
    playerState.cinema = false;
    return;
  }

  if (key === 'Enter' || key === ' ') {
    const ae = document.activeElement as HTMLElement | null;
    if (ae && panelEl.contains(ae)) { e.preventDefault(); activateFocused(ae); }
    return;
  }

  const ae = document.activeElement as HTMLElement | null;
  if ((key === 'ArrowLeft' || key === 'ArrowRight') && ownsHorizontalArrows(ae)) return;
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return;

  const sideActions = panelEl.querySelector<HTMLElement>('.bfp-cinema-side-actions');
  const controlsRow = panelEl.querySelector<HTMLElement>('.bfp-cinema-controls-row');
  // Sits between the two above in the Up/Down chain -- visually it's the
  // row directly above controls-row. A single focusable element (not a
  // "zone" with its own Left/Right list), so it's just one more stop.
  const progressBar = panelEl.querySelector<HTMLElement>('.bfp-cinema-progress');
  const progressVisible = !!(progressBar && isVisible(progressBar));

  const inSideActions = !!(ae && sideActions?.contains(ae));
  const inControlsRow = !!(ae && controlsRow?.contains(ae));
  const onProgressBar = ae === progressBar;

  // Each zone's own axis matches its actual visual layout: the icon column
  // is vertical (Up/Down), the bottom row is horizontal (Left/Right) --
  // unlike the previous version, which used Left/Right for both and only
  // Up/Down to switch zones, that didn't match how either zone actually
  // looks on screen.
  if (inSideActions) {
    if (key === 'ArrowLeft' || key === 'ArrowRight') return; // not this zone's axis
    e.preventDefault();
    const items = navigableWithin(sideActions!);
    const idx = items.indexOf(ae!);
    if (idx === -1) { focusFirst(items); return; }
    if (key === 'ArrowDown' && idx === items.length - 1) {
      if (progressVisible) { progressBar!.focus({ preventScroll: true }); return; }
      if (controlsRow) { focusFirst(navigableWithin(controlsRow)); return; }
    }
    const next = items[Math.max(0, Math.min(items.length - 1, idx + (key === 'ArrowDown' ? 1 : -1)))];
    next.focus({ preventScroll: true });
    return;
  }

  if (onProgressBar) {
    if (key === 'ArrowLeft' || key === 'ArrowRight') return; // owned by handleProgressKeydown (seeking)
    e.preventDefault();
    if (key === 'ArrowUp' && sideActions) { focusFirst(navigableWithin(sideActions)); return; }
    if (key === 'ArrowDown' && controlsRow) { focusFirst(navigableWithin(controlsRow)); return; }
    return;
  }

  if (inControlsRow) {
    if (key === 'ArrowUp') {
      e.preventDefault();
      if (progressVisible) { progressBar!.focus({ preventScroll: true }); return; }
      if (sideActions) { focusFirst(navigableWithin(sideActions)); return; }
      return;
    }
    if (key === 'ArrowDown') return; // nothing below the bottom row
    e.preventDefault();
    const items = navigableWithin(controlsRow!);
    const idx = items.indexOf(ae!);
    if (idx === -1) { focusFirst(items); return; }
    const next = items[Math.max(0, Math.min(items.length - 1, idx + (key === 'ArrowRight' ? 1 : -1)))];
    next.focus({ preventScroll: true });
    return;
  }

  // Focus isn't in any of the three yet (e.g. just entered the player) --
  // land somewhere sensible regardless of which key was pressed.
  e.preventDefault();
  if (progressVisible) { progressBar!.focus({ preventScroll: true }); return; }
  const firstZone = sideActions || controlsRow;
  if (firstZone) focusFirst(navigableWithin(firstZone));
}

// ── GRID zone (CinemaIndex browse grid) ───────────────────────────────────
function getGridRows(grid: HTMLElement): HTMLElement[][] {
  return Array.from(grid.querySelectorAll<HTMLElement>('.cinema-cards'))
    .map(row => navigableWithin(row))
    .filter(row => row.length > 0);
}

function handleGridZone(e: KeyboardEvent, grid: HTMLElement): void {
  const key = e.key;
  if (key === 'Escape') { e.preventDefault(); focusRailFirstItem(); return; }
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(key)) return;

  const rows = getGridRows(grid);
  if (!rows.length) return;
  const ae = document.activeElement as HTMLElement | null;
  let r = -1, c = -1;
  if (ae) {
    for (let i = 0; i < rows.length; i++) {
      const j = rows[i].indexOf(ae);
      if (j !== -1) { r = i; c = j; break; }
    }
  }
  if (r === -1) { e.preventDefault(); focusFirst(rows[0]); return; }

  if (key === 'Enter' || key === ' ') { e.preventDefault(); activateFocused(rows[r][c]); return; }

  e.preventDefault();
  if (key === 'ArrowLeft') {
    if (c === 0) { focusRailFirstItem(); return; }
    const el = rows[r][c - 1];
    el.focus({ preventScroll: true });
    el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  } else if (key === 'ArrowRight') {
    const el = rows[r][Math.min(rows[r].length - 1, c + 1)];
    el.focus({ preventScroll: true });
    el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  } else if (key === 'ArrowDown') {
    const nr = Math.min(rows.length - 1, r + 1);
    const el = rows[nr][Math.min(rows[nr].length - 1, c)];
    el.focus({ preventScroll: true });
    el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  } else if (key === 'ArrowUp') {
    const nr = Math.max(0, r - 1);
    const el = rows[nr][Math.min(rows[nr].length - 1, c)];
    el.focus({ preventScroll: true });
    el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }
}

// ── Dispatch ───────────────────────────────────────────────────────────────
function handleKeydown(e: KeyboardEvent): void {
  if (!isActive()) return;
  const key = e.key;
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Escape'].includes(key)) return;

  const ae = document.activeElement as HTMLElement | null;
  if (key !== 'Escape' && isTypingTarget(ae)) {
    const isMultiline = ae?.tagName === 'TEXTAREA';
    if (isMultiline || key === 'ArrowLeft' || key === 'ArrowRight') return;
    // else: ArrowUp/ArrowDown on a single-line text input -- nothing native
    // to protect, let it fall through to the zone's own vertical
    // navigation below.
  }

  // PIN_PAD zone: highest priority of all, checked before MODAL/PANEL/
  // anything else, since a PinPad (see modules/device-profiles/PinPad.vue)
  // can be shown inside either one and needs to fully own every key except
  // Escape while it's up -- its zone-highlight mechanic (which of A/B/C is
  // highlighted) is not a "move focus to the next button" concept at all,
  // so the generic MODAL/PANEL roving-focus handling below would actively
  // fight it rather than drive it correctly. Detected by DOM presence
  // (`.pinpad`), not focus -- the pin pad has no real focusable elements of
  // its own to move focus onto in the first place.
  const pinPad = document.querySelector<HTMLElement>('.pinpad');
  if (pinPad && key !== 'Escape' && isVisible(pinPad)) {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(key)) return;
    e.preventDefault();
    switch (key) {
      case 'ArrowUp': pinMoveZone(-1); break;
      case 'ArrowDown': pinDownInZoneC(); break;
      case 'ArrowLeft': pinCommit(getPinZoneDigits(pinZone.value)[0]); break;
      case 'Enter': case ' ': pinCommit(getPinZoneDigits(pinZone.value)[1]); break;
      case 'ArrowRight': pinCommit(getPinZoneDigits(pinZone.value)[2]); break;
    }
    return;
  }

  // Auto-hidden cinema controls only ever came back via mousemove -- D-pad/
  // keyboard activity is just as much "the user is doing something" and
  // needs to reset the same timer, or arrows/Enter/Escape on a
  // faded-out-but-still-technically-focused button (opacity:0 doesn't blur
  // it) look like they do nothing at all with no way to bring anything back
  // on-screen short of grabbing a mouse.
  if (playerState.cinema) showCinemaControls();

  // Editable-control edit-mode toggle takes priority over everything else:
  // while editing, Escape closes edit-mode (not whatever the current zone
  // would otherwise do with Escape), and Enter/Space always toggles rather
  // than being treated as "activate this button". Only range/number inputs
  // sitting inline among sibling controls need this -- the seek bar
  // (role="slider") already owns Left/Right unconditionally (see
  // ownsHorizontalArrows), nothing to toggle there.
  if (isEditableControl(ae)) {
    if (key === 'Enter' || key === ' ') {
      e.preventDefault();
      editingControl = editingControl === ae ? null : ae;
      ae!.classList.toggle('dpad-editing', editingControl === ae);
      return;
    }
    if (key === 'Escape' && editingControl === ae) {
      e.preventDefault();
      editingControl = null;
      ae!.classList.remove('dpad-editing');
      return;
    }
  }

  const modal = getOpenModal();
  if (modal) { handleModalZone(e, modal); return; }

  const panel = getOpenPanel();
  if (panel) { handlePanelZone(e, panel); return; }

  const rail = document.querySelector<HTMLElement>('.cinema-rail');
  if (rail && ae && rail.contains(ae)) { handleRailZone(e, rail); return; }

  if (playerState.cinema) { handlePlayerZone(e); return; }

  const grid = document.querySelector<HTMLElement>('.cinema-index');
  if (grid) { handleGridZone(e, grid); return; }
}

function handleFocusIn(e: FocusEvent): void {
  if (!isActive()) return;
  const t = e.target as HTMLElement;
  // Leaving the slider (by any means -- not just the explicit toggle-off)
  // always drops edit-mode; it should never survive onto whatever's
  // focused next.
  if (editingControl && t !== editingControl) {
    editingControl.classList.remove('dpad-editing');
    editingControl = null;
  }
  if (!t.closest('.cinema-rail') && !t.closest('.cinema-side-panel')) {
    lastContentFocus = t;
  }
}

/** Call once (e.g. from App.vue's setup). `active` is checked on every
 *  keydown, so passing a reactive getter (`() => cinemaMode.value`) is
 *  enough to turn this on/off — no need to add/remove listeners as cinema
 *  mode toggles. */
export function installCinemaDpadNav(active: () => boolean): void {
  isActive = active;
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', handleKeydown, true);
  window.addEventListener('focusin', handleFocusIn, true);
}
