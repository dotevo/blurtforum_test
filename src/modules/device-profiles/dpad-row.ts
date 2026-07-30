import { onMounted, onUnmounted, nextTick, type Ref } from 'vue';

/**
 * modules/device-profiles/dpad-row.ts
 *
 * A real Android TV remote's arrow keys arrive as plain ArrowUp/Down/Left/
 * Right keydown events in the WebView -- nothing moves focus automatically
 * on its own (that's exactly why modules/cinema/dpad-nav.ts exists for the
 * rest of the app). This is the same idea, radically simplified for these
 * screens specifically: one flat, DOM-order list of focusable elements
 * inside a container, any arrow key steps to the next/previous one.
 *
 * Deliberately NOT spatial (a real 2D grid would need up/down to differ
 * from left/right) -- these screens are short, mostly-single-column forms
 * and a single row of profile tiles, where a flat list already reads
 * naturally in every direction. dpad-nav.ts's own zones do the more
 * involved spatial handling where that actually matters (the card grid).
 *
 * Text entry is deliberately left alone: while an <input type="text">,
 * <textarea>, or <select> is focused, arrow keys are NOT intercepted here
 * at all -- native caret movement / number spinners / select value changes
 * all keep working exactly as they would anywhere else. Reaching a text
 * field from a button, or leaving it, still works as long as it isn't
 * itself the currently-focused element (Tab still works too, natively,
 * regardless of this).
 */
const NAV_SELECTOR = [
  'a[href]', 'button:not(:disabled)', '[tabindex]:not([tabindex="-1"])',
].join(', ');

function isNativeTextEntry(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return type !== 'checkbox' && type !== 'radio' && type !== 'button';
  }
  return false;
}

export function useDpadRow(containerRef: Ref<HTMLElement | null | undefined>): { refocusFirst: () => void } {
  function items(): HTMLElement[] {
    if (!containerRef.value) return [];
    return Array.from(containerRef.value.querySelectorAll<HTMLElement>(NAV_SELECTOR))
      .filter(el => el.offsetParent !== null); // visible only
  }

  function move(delta: number): void {
    const list = items();
    if (!list.length) return;
    const idx = list.indexOf(document.activeElement as HTMLElement);
    const next = idx === -1 ? 0 : Math.min(Math.max(idx + delta, 0), list.length - 1);
    list[next]?.focus();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (isNativeTextEntry(document.activeElement)) return; // let native behavior win entirely
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowLeft':
        e.preventDefault();
        move(-1);
        break;
      case 'ArrowDown':
      case 'ArrowRight':
        e.preventDefault();
        move(1);
        break;
      default:
        break;
    }
  }

  function refocusFirst(): void {
    items()[0]?.focus();
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeydown);
    void nextTick(refocusFirst);
  });
  onUnmounted(() => window.removeEventListener('keydown', handleKeydown));

  return { refocusFirst };
}
