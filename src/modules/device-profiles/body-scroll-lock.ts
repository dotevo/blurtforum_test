import { onMounted, onUnmounted } from 'vue';

/**
 * modules/device-profiles/body-scroll-lock.ts
 *
 * Nothing else in this app locks body scroll for its modals/overlays (they
 * apparently never needed to), but these TV-only full-viewport screens hit
 * a real issue: a `position: fixed; inset: 0` overlay stays visually put
 * regardless of page scroll, but if ITS OWN content is taller than the
 * viewport (e.g. the create-profile form + PIN pad together, on a short
 * window), that overflow can still register as scrollable page content in
 * some engines -- producing a visible page-level scrollbar even though
 * everything meaningful is confined to the fixed overlay. Each component
 * also constrains its own overflow (see their `overflow-y: auto` +
 * max-height), but this is the belt-and-braces guarantee: no page-level
 * scrollbar can appear while one of these is open, full stop.
 */
export function useBodyScrollLock(): void {
  onMounted(() => {
    document.body.classList.add('bf-scroll-locked');
  });
  onUnmounted(() => {
    document.body.classList.remove('bf-scroll-locked');
  });
}
