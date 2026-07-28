/**
 * modules/seo.ts
 *
 * This app is a client-rendered SPA with no server-side routing: every
 * "page" (index, forum, topic, profile, ...) lives at the same document,
 * distinguished only by query params, and URL changes happen via
 * history.pushState (see useApp.ts's syncUrl()/handleUrlChange()).
 *
 * That means the browser never gets a fresh document per view — so a
 * static <link rel="canonical"> in index.html can only ever describe one
 * URL (the root). Every other query-param variation (a forum, a topic, a
 * profile) was left with no canonical hint at all, which is exactly what
 * Search Console flags as "Alternate page with proper canonical tag" /
 * "Page is not indexed: missing canonical tag".
 *
 * Fix: keep a single canonical <link> (and matching og:url <meta>) in
 * <head>, and repoint it at window.location.href every time the SPA's URL
 * changes. Self-referencing canonical is the right choice here because
 * each of these query-param URLs is genuinely distinct content (a
 * different topic/profile/forum), not a duplicate of the homepage —
 * pointing everything at "/" would just make Google drop real content
 * pages from the index instead.
 *
 * Language: rather than forcing one fixed interface language and hoping
 * Google picks it up correctly, we tell Google directly which language
 * variants of the current page exist via <link rel="alternate"
 * hreflang="xx">, each pointing at an explicit `?lang=xx` URL. Google
 * then crawls each variant independently and serves the right one to
 * each searcher itself — this is the standard mechanism for
 * multi-language sites (see https://developers.google.com/search/docs/specialty/international/localized-versions).
 * The bare URL (no `?lang=`, real visitors' browser-language auto-detect)
 * is declared as hreflang="x-default": the fallback for a
 * language/locale that isn't one of the explicit variants.
 */

function getOrCreateLink(rel: string): HTMLLinkElement {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', rel);
    document.head.appendChild(el);
  }
  return el;
}

function getOrCreateMeta(property: string): HTMLMetaElement {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute('property', property);
    document.head.appendChild(el);
  }
  return el;
}

/** Current URL with `lang` set to `code`, or removed entirely if `code`
 * is null (the x-default / auto-detect variant). */
function buildLangVariantUrl(code: string | null): string {
  const url = new URL(window.location.href);
  if (code) url.searchParams.set('lang', code);
  else url.searchParams.delete('lang');
  return url.toString();
}

function syncHreflangTags(supportedLangs: readonly string[]): void {
  // Marked with data-i18n so we can cleanly wipe + rebuild the exact set
  // every time, rather than trying to diff/reorder existing ones.
  document.head.querySelectorAll('link[rel="alternate"][hreflang]').forEach((el) => el.remove());
  const frag = document.createDocumentFragment();
  const make = (hreflang: string, href: string) => {
    const link = document.createElement('link');
    link.setAttribute('rel', 'alternate');
    link.setAttribute('hreflang', hreflang);
    link.setAttribute('href', href);
    link.setAttribute('data-i18n', '1');
    frag.appendChild(link);
  };
  supportedLangs.forEach((code) => make(code, buildLangVariantUrl(code)));
  make('x-default', buildLangVariantUrl(null));
  document.head.appendChild(frag);
}

/** Call whenever the SPA's URL changes (after pushState, and once on
 * initial load) to keep canonical/og:url/hreflang all pointed at the real
 * current URL and its language variants. */
export function syncSeoTags(supportedLangs: readonly string[]): void {
  const href = window.location.href;
  getOrCreateLink('canonical').setAttribute('href', href);
  getOrCreateMeta('og:url').setAttribute('content', href);
  syncHreflangTags(supportedLangs);
}
