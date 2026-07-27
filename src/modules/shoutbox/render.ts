/**
 * modules/shoutbox/render.ts
 *
 * Turns a chat message body into a list of segments — plain text or
 * "this looks like a link to a specific post" — for the widget to render
 * with plain Vue template bindings (v-if/v-for + text interpolation).
 *
 * Deliberately NOT html-string-building + v-html: message bodies are
 * arbitrary user input from anyone on the network, verified for
 * *authorship* (see identity.ts/session.ts) but never for *safety of
 * content*. Producing a segment list and letting Vue's normal templating
 * render it keeps every character of untrusted text going through Vue's
 * own escaping — there is no HTML-construction step here for something
 * to sneak through.
 *
 * Recognizes two forms, matched by ONE combined regex so a pasted full
 * URL is never separately re-matched by the bare-shorthand alternative
 * (that would double-render the same reference):
 *   1. A full URL that happens to contain a `/@author/permlink` path
 *      segment — the convention essentially every Blurt/Steem/Hive
 *      frontend uses (blurt.blog, this app once it's on path-based URLs,
 *      etc). We only need that segment; the rest of the URL is discarded
 *      in favor of in-app navigation.
 *   2. The bare shorthand `@author/permlink` — quicker to type than a
 *      full URL, and what the "share current post" button in the
 *      composer inserts (see ShoutboxWidget.vue).
 */

export type MessageSegment =
  | { type: 'text'; value: string }
  | { type: 'postref'; author: string; permlink: string; label: string };

const USERNAME = '[a-z][a-z0-9._-]{1,15}';
const PERMLINK = '[a-z0-9][a-z0-9-]*';
const POST_REF_RE = new RegExp(
  `(https?://\\S*?/@(${USERNAME})/(${PERMLINK}))|(@(${USERNAME})/(${PERMLINK}))`,
  'gi'
);

const MAX_LABEL_LEN = 40;

function truncateLabel(label: string): string {
  return label.length > MAX_LABEL_LEN ? `${label.slice(0, MAX_LABEL_LEN - 1)}…` : label;
}

export function parseMessageSegments(body: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let lastIndex = 0;
  POST_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = POST_REF_RE.exec(body))) {
    if (match.index > lastIndex) segments.push({ type: 'text', value: body.slice(lastIndex, match.index) });

    const author = (match[2] ?? match[5])?.toLowerCase();
    const permlink = match[3] ?? match[6];
    if (author && permlink) {
      segments.push({ type: 'postref', author, permlink, label: truncateLabel(`@${author}/${permlink}`) });
    } else {
      segments.push({ type: 'text', value: match[0] }); // shouldn't happen given the regex, but never lose text
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < body.length) segments.push({ type: 'text', value: body.slice(lastIndex) });
  return segments;
}
