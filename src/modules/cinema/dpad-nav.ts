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
import { state as playerState } from '../player/player';

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
  return Array.from(container.querySelectorAll<HTMLElement>(NAV_SELECTOR)).filter(isVisible);
}

function isTypingTarget(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return (el as HTMLInputElement).type !== 'range';
  return false;
}

/** Elements that already do something sensible with Left/Right themselves:
 *  native range inputs, and custom sliders (role="slider", e.g. the cinema
 *  seek bar) with their own local Left/Right handler. */
function ownsHorizontalArrows(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'range') return true;
  return el.getAttribute('role') === 'slider';
}

/** Forwards Enter/Space to whatever's focused, IF it wouldn't already
 *  activate on its own (native button/link/range do; a div or span made
 *  focusable via tabindex for something like a card or list row doesn't). */
function activateFocused(el: HTMLElement): void {
  if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT') return;
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
  const items = navigableWithin(modal);
  if (!items.length) return;
  const ae = document.activeElement as HTMLElement | null;
  const idx = ae ? items.indexOf(ae) : -1;

  if (key === 'Escape') {
    e.preventDefault();
    modal.querySelector<HTMLElement>('.modal-close')?.click();
    return;
  }
  if (key === 'Enter' || key === ' ') {
    if (ae && idx !== -1) { e.preventDefault(); activateFocused(ae); }
    return;
  }
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return;
  if ((key === 'ArrowLeft' || key === 'ArrowRight') && ownsHorizontalArrows(ae)) return;
  e.preventDefault();
  if (idx === -1) { focusFirst(items); return; }
  const dir = (key === 'ArrowDown' || key === 'ArrowRight') ? 1 : -1;
  const next = items[(idx + dir + items.length) % items.length];
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
  if (key === 'Escape' || key === 'ArrowLeft' || key === 'ArrowRight') {
    e.preventDefault();
    closePanel(panel);
    return;
  }
  if (key === 'Enter' || key === ' ') {
    const ae = document.activeElement as HTMLElement | null;
    if (ae && panel.contains(ae)) { e.preventDefault(); activateFocused(ae); }
    return;
  }
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return;
  e.preventDefault();
  const items = navigableWithin(panel);
  if (!items.length) return;
  const ae = document.activeElement as HTMLElement | null;
  const idx = ae ? items.indexOf(ae) : -1;
  if (idx === -1) { focusFirst(items); return; }
  const next = items[Math.max(0, Math.min(items.length - 1, idx + (key === 'ArrowDown' ? 1 : -1)))];
  next.focus({ preventScroll: true });
  next.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── RAIL zone ────────────────────────────────────────────────────────────
function focusRailFirstItem(): void {
  const rail = document.querySelector<HTMLElement>('.cinema-rail');
  if (rail) focusFirst(navigableWithin(rail));
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
    playerState.cinema = false;
    return;
  }

  const ae = document.activeElement as HTMLElement | null;
  if ((key === 'ArrowLeft' || key === 'ArrowRight') && ownsHorizontalArrows(ae)) return;
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return;
  e.preventDefault();

  const sideActions = panelEl.querySelector<HTMLElement>('.bfp-cinema-side-actions');
  const controlsRow = panelEl.querySelector<HTMLElement>('.bfp-cinema-controls-row');
  const zones = [sideActions, controlsRow].filter((z): z is HTMLElement => !!z);
  if (!zones.length) return;

  const currentZone = ae ? zones.find(z => z.contains(ae)) : null;
  if (!currentZone) { focusFirst(navigableWithin(zones[0])); return; }
  const items = navigableWithin(currentZone);
  const idx = ae ? items.indexOf(ae) : -1;

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    if (idx === -1) { focusFirst(items); return; }
    const next = items[Math.max(0, Math.min(items.length - 1, idx + (key === 'ArrowRight' ? 1 : -1)))];
    next.focus({ preventScroll: true });
    return;
  }

  // Up/Down: switch to the other zone, landing on whichever of its items
  // sits closest horizontally to the one being left.
  const otherZone = zones.find(z => z !== currentZone);
  if (!otherZone) return;
  const otherItems = navigableWithin(otherZone);
  if (!otherItems.length) return;
  if (idx === -1) { focusFirst(otherItems); return; }
  const currentX = items[idx].getBoundingClientRect().left;
  const closest = otherItems.reduce((best, el) =>
    Math.abs(el.getBoundingClientRect().left - currentX) < Math.abs(best.getBoundingClientRect().left - currentX) ? el : best
  );
  closest.focus({ preventScroll: true });
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
  if (key !== 'Escape' && isTypingTarget(ae)) return;

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
