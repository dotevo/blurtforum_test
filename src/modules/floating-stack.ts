import { computed, reactive, ref, onMounted, onBeforeUnmount, type Ref, type ComputedRef } from 'vue';
import { state as playerState } from './player/player';

/**
 * modules/floating-stack.ts
 *
 * Why this exists: three different bottom-anchored floating UI pieces
 * (ShoutboxWidget's chat dock, App.vue's blockchain wait-queue bar, and
 * CookieConsentBanner) all need to sit ABOVE the docked media player
 * instead of underneath it -- and, when more than one of them is visible
 * at once, stack on top of EACH OTHER too rather than overlapping. Before
 * this module, each one computed that independently: ShoutboxWidget had
 * its own `dockBottomPx` reading `player.ts`'s `state` directly, while
 * App.vue had its own separate `playerClearance` computed doing the same
 * arithmetic a second time -- which is exactly how they drifted apart
 * (chat correctly tracked the player; the cookie banner, going through
 * App.vue's separate copy, didn't, and needed two follow-up fixes for
 * unrelated CSS bugs on top of that). One formula, one shared stack,
 * used by all three (and anything added later).
 */

/** Canonical "how much room does the docked player currently occupy at the
 *  bottom of the viewport" -- the single formula every layer below builds
 *  on. Matches MediaPlayer.vue's own docked-panel height binding
 *  (`:style="{ height: player.state.expandedHeight + 'px' }"`) for the
 *  expanded case, and the medium docked bar's real height (~76px,
 *  previously duplicated as a CSS class rule -- see App.vue's own history
 *  on this) for the un-expanded case. Cinema mode is always 0: every
 *  current consumer already gates itself on `!cinemaMode` (the player
 *  fills the whole screen then, there's nowhere for a corner dock or
 *  bottom banner to go), so this doesn't need its own cinema branch --
 *  see App.vue's earlier history of a *different* cinema-mode bug for why
 *  that distinction matters. */
export const dockedPlayerFootprintPx = computed<number>(() => {
  if (playerState.hidden || playerState.minimized || playerState.cinema) return 0;
  return playerState.expanded ? playerState.expandedHeight : 76;
});

export interface FloatingLayer {
  id: string;
  /** Stacking order, low to high. A layer's own offset is the player's
   *  footprint plus the height of every OTHER currently-visible layer with
   *  a strictly LOWER order -- so lower orders sit closer to the player,
   *  higher orders stack further up. Two layers sharing the same order
   *  don't stack against each other (assumed to occupy different
   *  horizontal space, e.g. a left-corner dock next to a right-corner
   *  one) -- pick a distinct order for anything that's full-width, since a
   *  full-width layer needs to clear literally everything below it. */
  order: number;
  /** Real rendered height in px. Backed by an actual ResizeObserver
   *  measurement via useFloatingLayer() below wherever practical, rather
   *  than a guessed constant -- CookieConsentBanner.vue's own history is
   *  two separate bugs from guessed constants (an unbounded one that
   *  chased the player's expanded height, then a capped-but-still-guessed
   *  160px), neither of which a real measurement would have needed. */
  heightPx: () => number;
  visible: () => boolean;
}

const layers = reactive<FloatingLayer[]>([]);

export function registerFloatingLayer(layer: FloatingLayer): void {
  const existing = layers.findIndex(l => l.id === layer.id);
  if (existing !== -1) layers.splice(existing, 1, layer);
  else layers.push(layer);
}

export function unregisterFloatingLayer(id: string): void {
  const i = layers.findIndex(l => l.id === id);
  if (i !== -1) layers.splice(i, 1);
}

/** Bottom offset (px) a given layer should render at. Falls back to just
 *  the player footprint if the id isn't registered (yet, or at all) --
 *  callers get a sane value even for the one render tick before their own
 *  onMounted registers them. */
export function stackOffsetFor(id: string): number {
  const target = layers.find(l => l.id === id);
  let total = dockedPlayerFootprintPx.value;
  for (const l of layers) {
    if (l.id === id) continue;
    if (target && l.order >= target.order) continue;
    if (l.visible()) total += l.heightPx();
  }
  return total;
}

/**
 * Ergonomic wrapper: pass a `ref<HTMLElement|null>` you've bound to the
 * layer's root element via `ref="..."` in your template, and this handles
 * measuring it (ResizeObserver -- tracks real height live, so a layer that
 * changes size, e.g. the wait-queue bar gaining a row, doesn't need to be
 * re-measured manually), registering/unregistering on mount/unmount, and
 * returns a ready-to-bind `bottom` (px number).
 *
 * Takes the element ref as a parameter rather than creating and returning
 * one itself (the more obvious-looking API) so it's a plain, directly-
 * declared `const el = ref(...)` at the call site -- template-ref
 * auto-binding through a *destructured composable return* isn't reliably
 * recognized as "used" by this project's `noUnusedLocals: true` (see
 * tsconfig.json), even though it works correctly at runtime either way.
 *
 * `visible` should be the same condition already gating the layer's own
 * `v-if`/`v-show` in its template -- a layer that's currently hidden
 * shouldn't hold its last-measured height against everything stacked above
 * it (ResizeObserver naturally reports 0 for a `display:none` element
 * anyway, but an explicit `visible` avoids relying on that).
 */
export function useFloatingLayer(
  el: Ref<HTMLElement | null>,
  opts: { id: string; order: number; visible: () => boolean }
): ComputedRef<number> {
  const measuredHeight = ref(0);
  let ro: ResizeObserver | null = null;

  onMounted(() => {
    if (el.value && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver((entries) => {
        for (const entry of entries) measuredHeight.value = entry.contentRect.height;
      });
      ro.observe(el.value);
    }
    registerFloatingLayer({ id: opts.id, order: opts.order, heightPx: () => measuredHeight.value, visible: opts.visible });
  });

  onBeforeUnmount(() => {
    ro?.disconnect();
    unregisterFloatingLayer(opts.id);
  });

  return computed(() => stackOffsetFor(opts.id));
}
