/**
 * modules/shoutbox/emoji.ts
 *
 * A small, hardcoded emoji set — no external picker library, no CDN, no
 * network call (fits the "no backend" philosophy of the rest of this
 * module: nothing here can fail because some third-party asset didn't
 * load). Native OS emoji keyboards already work fine in the plain text
 * input with zero code from us; this is specifically for (a) a
 * point-and-click picker for people who don't have one handy, and (b) a
 * few familiar `:shortcode:` conventions people already know from other
 * chat apps.
 */

export interface EmojiEntry {
  emoji: string;
  shortcode: string;
}

export const EMOJI_LIST: EmojiEntry[] = [
  { emoji: '😀', shortcode: 'grinning' },
  { emoji: '😂', shortcode: 'joy' },
  { emoji: '🙂', shortcode: 'slight_smile' },
  { emoji: '😉', shortcode: 'wink' },
  { emoji: '😍', shortcode: 'heart_eyes' },
  { emoji: '🤔', shortcode: 'thinking' },
  { emoji: '😎', shortcode: 'sunglasses' },
  { emoji: '😢', shortcode: 'cry' },
  { emoji: '😭', shortcode: 'sob' },
  { emoji: '😡', shortcode: 'rage' },
  { emoji: '😱', shortcode: 'scream' },
  { emoji: '🙄', shortcode: 'eye_roll' },
  { emoji: '😴', shortcode: 'sleeping' },
  { emoji: '🤯', shortcode: 'mind_blown' },
  { emoji: '🥳', shortcode: 'party' },
  { emoji: '😅', shortcode: 'sweat_smile' },
  { emoji: '👍', shortcode: '+1' },
  { emoji: '👎', shortcode: '-1' },
  { emoji: '👏', shortcode: 'clap' },
  { emoji: '🙏', shortcode: 'pray' },
  { emoji: '🤝', shortcode: 'handshake' },
  { emoji: '💪', shortcode: 'muscle' },
  { emoji: '🤷', shortcode: 'shrug' },
  { emoji: '👀', shortcode: 'eyes' },
  { emoji: '❤️', shortcode: 'heart' },
  { emoji: '🔥', shortcode: 'fire' },
  { emoji: '💯', shortcode: '100' },
  { emoji: '⭐', shortcode: 'star' },
  { emoji: '✅', shortcode: 'check' },
  { emoji: '❌', shortcode: 'x' },
  { emoji: '🎉', shortcode: 'tada' },
  { emoji: '🚀', shortcode: 'rocket' },
  { emoji: '💰', shortcode: 'moneybag' },
  { emoji: '📈', shortcode: 'chart_up' },
  { emoji: '📉', shortcode: 'chart_down' },
  { emoji: '☕', shortcode: 'coffee' },
  { emoji: '🍺', shortcode: 'beer' },
  { emoji: '🎮', shortcode: 'video_game' },
  { emoji: '🎵', shortcode: 'musical_note' },
  { emoji: '📄', shortcode: 'page' },
  { emoji: '🔗', shortcode: 'link' },
  { emoji: '💬', shortcode: 'speech_balloon' },
  { emoji: '⚡', shortcode: 'zap' },
];

const SHORTCODE_MAP = new Map(EMOJI_LIST.map((e) => [e.shortcode.toLowerCase(), e.emoji]));
const SHORTCODE_RE = /:([a-z0-9_+-]+):/gi;

/** Replaces every recognized `:shortcode:` with its emoji. Unknown
 * shortcodes are left untouched (someone typing ":shrug:" gets 🤷, someone
 * typing ":not_a_real_one:" just sees their own text back, no error). */
export function expandEmojiShortcodes(text: string): string {
  return text.replace(SHORTCODE_RE, (whole, code: string) => SHORTCODE_MAP.get(code.toLowerCase()) ?? whole);
}
