<script setup lang="ts">
/**
 * Cinema mode's "browse" screen — a VOD-style grid, either:
 *  - category rows (posts containing embedded media, grouped by tag), or
 *  - the user's playlists (rows = playlists, cards = playlist tracks)
 * toggled via player.state.cinemaBrowseView, which the left rail's
 * Playlists entry sets directly (see player.ts) so it doesn't need any
 * direct reference to this component.
 *
 * No new backend calls for categories: reuses the same bridge
 * get_ranked_posts the rest of the forum already uses (Blockchain.getRankedPosts)
 * and the same normalizePost() pipeline that already builds post.tracks
 * (grouped mirrors) for every other view.
 *
 * The card thumbnail is <ForumMedia mode="card" hide-buttons> — same
 * component ForumView/TopicView already use for covers (mirror resolution,
 * YouTube/Suno cover art, WebTorrent live status), just with its own
 * play/pause/queue overlay suppressed. This screen supplies its own single
 * play action (like ForumMediaContainer does for the micro/list view), which
 * plays the track and flips the player into fullscreen cinema display.
 */
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { Blockchain } from '../blockchain';
import { PostProcessor } from '../post-processor';
import { state as playerState, playlistState, playTrack } from '../player/player';
import ForumMedia from '../player_blurt/components/ForumMedia.ce.vue';
import type { MediaTrack } from '../player/types';

const props = defineProps<{
  client: any;
  t: (k: string) => string;
}>();

interface CinemaCard { post: { author: string; permlink: string; title: string }; track: MediaTrack; }
interface CinemaRow {
  id: string; label: string; icon: string; cards: CinemaCard[]; loading: boolean;
  /** Debug info so an empty category is diagnosable from the UI itself
   *  (useful on mobile where there's no easy console) instead of just
   *  silently vanishing. Not used for playlist rows (nothing to fetch). */
  rawCount: number; error: string | null;
}

// Small badge so a thumbnail's source is identifiable at a glance in a grid
// full of mixed YouTube/PeerTube/WebTorrent/audio cards.
const sourceBadge: Record<string, { label: string; icon: string }> = {
  youtube: { label: 'YT', icon: 'fa-brands fa-youtube' },
  peertube: { label: 'PT', icon: 'fa-solid fa-video' },
  audio: { label: 'MP3', icon: 'fa-solid fa-music' },
  webtorrent: { label: 'WT', icon: 'fa-solid fa-magnet' },
};
const cardSource = (card: CinemaCard) => {
  const src = card.track.sources?.[card.track.activeSourceIndex ?? 0] || card.track.sources?.[0];
  return src ? sourceBadge[src.type] : null;
};

// Starter categories — real tags on the Blurt chain, not invented buckets.
// Easy to extend/replace once real category conventions are decided.
const categories = ref<CinemaRow[]>([
  { id: 'blurtmedia', label: 'Blurt Media', icon: 'fa-solid fa-fire',           cards: [], loading: true, rawCount: 0, error: null },
  { id: 'sport',      label: 'Sport',       icon: 'fa-solid fa-futbol',        cards: [], loading: true, rawCount: 0, error: null },
  { id: 'comedy',     label: 'Comedy',      icon: 'fa-solid fa-masks-theater', cards: [], loading: true, rawCount: 0, error: null },
  { id: 'music',      label: 'Music',       icon: 'fa-solid fa-music',         cards: [], loading: true, rawCount: 0, error: null },
  { id: 'gaming',     label: 'Gaming',      icon: 'fa-solid fa-gamepad',       cards: [], loading: true, rawCount: 0, error: null },
  { id: 'crypto',     label: 'Crypto',      icon: 'fa-solid fa-coins',         cards: [], loading: true, rawCount: 0, error: null },
]);

const loadCategory = async (cat: CinemaRow): Promise<void> => {
  cat.loading = true;
  cat.error = null;
  try {
    const raw = await Blockchain.getRankedPosts(props.client, 'trending', cat.id, 50);
    cat.rawCount = raw.length;
    const cards: CinemaCard[] = [];
    for (const r of raw) {
      const post = PostProcessor.normalizePost(r);
      // normalizePost already extracted + grouped mirrors into post.tracks —
      // no need to re-run media detection here.
      if (post.tracks && post.tracks.length) {
        const track = post.tracks[0] as unknown as MediaTrack;
        cards.push({ post: { author: post.author, permlink: post.permlink, title: post.title }, track });
      }
    }
    cat.cards = cards;
    if (cards.length && !currentCard.value) updateHero(cards[0]);
  } catch (e) {
    cat.rawCount = 0;
    cat.error = e instanceof Error ? e.message : String(e);
    console.warn('[CinemaIndex] loadCategory failed for', cat.id, e);
  }
  cat.loading = false;
};

// Playlists view: rows = playlists, cards = each playlist's tracks. No
// fetching -- playlistState is already fully loaded/reactive.
const playlistRows = computed<CinemaRow[]>(() => playlistState.playlists.map(pl => ({
  id: pl.id,
  label: pl.name,
  icon: 'fa-solid fa-list',
  loading: false,
  rawCount: pl.tracks.length,
  error: null,
  cards: pl.tracks.map(track => ({ post: { author: track.author, permlink: track.permlink, title: track.title }, track })),
})));

const rows = computed<CinemaRow[]>(() =>
  playerState.cinemaBrowseView === 'playlists' ? playlistRows.value : categories.value
);

// ── Hero: highlights whichever card was last hovered/focused ──────────────
const currentCard = ref<CinemaCard | null>(null);
const updateHero = (card: CinemaCard) => { currentCard.value = card; };

const playCard = async (card: CinemaCard): Promise<void> => {
  updateHero(card);
  await playTrack(card.track, true);
  // Set explicitly rather than relying only on the watcher below: if this is
  // the same track that's already current (e.g. user went back to the
  // library and picked the same video again), state.currentTrack doesn't
  // change reference, so a watcher on it wouldn't fire.
  playerState.cinema = true;
  playerState.expanded = true;
  playerState.minimized = false;
};

// Whenever a track actually starts playing while this screen is mounted,
// flip the player into fullscreen cinema display (covers cases other than
// playCard triggering playback, e.g. resuming from queue/history).
watch(() => playerState.currentTrack, (track) => {
  if (!track) return;
  playerState.cinema = true;
  playerState.expanded = true;
  playerState.minimized = false;
});

// The docked bar is never wanted in cinema context -- browsing or playing.
// Playback controls now live inside the fullscreen panel itself (see
// MediaPlayer.vue's .bfp-cinema-controls), so there's nothing for the bar
// to still be useful for here.
onMounted(() => {
  categories.value.forEach(loadCategory);
  playerState.hidden = true;
});

onUnmounted(() => {
  playerState.hidden = false;
  playerState.cinemaBrowseView = 'categories';
});

// ── Keyboard / remote (D-pad) navigation across the card grid ─────────────
const gridEl = ref<HTMLElement | null>(null);

const getRows = (): HTMLElement[][] => {
  if (!gridEl.value) return [];
  return Array.from(gridEl.value.querySelectorAll<HTMLElement>('.cinema-cards'))
    .map(row => Array.from(row.querySelectorAll<HTMLElement>('.cinema-card')))
    .filter(row => row.length);
};

const pos = ref({ row: 0, col: 0 });

const focusCard = (r: number, c: number) => {
  const rowEls = getRows();
  const row = rowEls[r];
  if (!row || !row.length) return;
  c = Math.max(0, Math.min(row.length - 1, c));
  pos.value = { row: r, col: c };
  row[c].focus({ preventScroll: true });
  row[c].scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
};

const onGridKeydown = (e: KeyboardEvent) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(e.key)) return;
  e.preventDefault();
  if (e.key === 'Escape') {
    focusRail();
    return;
  }
  const rowEls = getRows();
  if (!rowEls.length) return;
  if (e.key === 'Enter') {
    rowEls[pos.value.row]?.[pos.value.col]?.click();
    return;
  }
  if (e.key === 'ArrowRight') focusCard(pos.value.row, pos.value.col + 1);
  else if (e.key === 'ArrowLeft') {
    if (pos.value.col <= 0) { focusRail(); return; }
    focusCard(pos.value.row, pos.value.col - 1);
  }
  else if (e.key === 'ArrowDown') focusCard(Math.min(rowEls.length - 1, pos.value.row + 1), pos.value.col);
  else if (e.key === 'ArrowUp') focusCard(Math.max(0, pos.value.row - 1), pos.value.col);
};

// Hands focus off to the left rail (CinemaRail.vue) -- its own focusin
// handler expands it the moment focus actually lands inside it, so this
// is the one thing that has to reach across component boundaries, and a
// DOM query is simpler/more robust here than plumbing a ref/emit through
// whatever wraps both components.
function focusRail(): void {
  const target = document.querySelector<HTMLElement>('.cinema-rail .rail-item, .cinema-rail .rail-logo, .rail-toggle-btn');
  target?.focus();
}

function onRailEscape(): void {
  focusCard(pos.value.row, pos.value.col);
}
onMounted(() => document.addEventListener('cinema-rail-escape', onRailEscape));
onUnmounted(() => document.removeEventListener('cinema-rail-escape', onRailEscape));

// Nothing is focused by default, so arrow keys would never reach
// onGridKeydown at all (they'd just scroll the page). Auto-focus the first
// card the moment any row actually has cards, once per view, so
// remote/keyboard nav works immediately without stealing focus back later
// if the user has since focused/clicked elsewhere.
let hasAutoFocused = false;
watch(rows, () => {
  if (hasAutoFocused) return;
  nextTick(() => {
    if (hasAutoFocused) return;
    const rowEls = getRows();
    if (rowEls.length) {
      hasAutoFocused = true;
      focusCard(0, 0);
    }
  });
}, { deep: true, immediate: true });

// Switching between categories/playlists is a fresh browse -- allow
// auto-focus to run again for the new view.
watch(() => playerState.cinemaBrowseView, () => { hasAutoFocused = false; });
</script>

<template>
  <div ref="gridEl" class="cinema-index" @keydown="onGridKeydown">

    <section class="cinema-hero" v-if="currentCard">
      <div class="cinema-hero-backdrop"
           :style="currentCard.track.cover ? { backgroundImage: `url(${currentCard.track.cover})` } : {}"></div>
      <div class="cinema-hero-content">
        <h1 class="cinema-hero-title">{{ currentCard.post.title }}</h1>
        <div class="cinema-hero-meta">
          <span><i class="fa-solid fa-user-astronaut"></i> @{{ currentCard.post.author }}</span>
        </div>
        <button class="cinema-hero-play" @click="playCard(currentCard)">
          <i class="fa-solid fa-play"></i> {{ t('play') || 'Odtwórz' }}
        </button>
      </div>
    </section>

    <div v-if="playerState.cinemaBrowseView === 'playlists'" class="cinema-view-header">
      <button class="cinema-back-link" @click="playerState.cinemaBrowseView = 'categories'">
        <i class="fa-solid fa-arrow-left"></i> {{ t('categories') || 'Kategorie' }}
      </button>
      <h1 class="cinema-view-title">{{ t('playlists') || 'Playlisty' }}</h1>
    </div>

    <div v-if="playerState.cinemaBrowseView === 'playlists' && !rows.length" class="cinema-empty">
      {{ t('noPlaylists') || 'Nie masz jeszcze żadnej playlisty.' }}
    </div>

    <template v-for="row in rows" :key="row.id">
      <section class="cinema-row">
        <h2 class="cinema-row-title"><i :class="row.icon"></i> {{ row.label }}</h2>

        <div v-if="row.loading" class="loader"><span class="spin"></span></div>

        <div v-else-if="row.error" class="cinema-empty">
          {{ t('error') || 'Błąd' }}: {{ row.error }}
        </div>

        <div v-else-if="!row.cards.length" class="cinema-empty">
          {{ playerState.cinemaBrowseView === 'playlists'
              ? (t('emptyPlaylist') || 'Ta playlista jest pusta.')
              : `${row.rawCount} ${t('postsFetched') || 'postów pobranych'}, 0 ${t('withDetectedMedia') || 'z wykrytym medium'}` }}
        </div>

        <div v-else class="cinema-cards">
          <div v-for="card in row.cards" :key="card.post.author + '/' + card.post.permlink"
               class="cinema-card" tabindex="0" role="button"
               @click="playCard(card)"
               @mouseenter="updateHero(card)" @focus="updateHero(card)">
            <div class="cinema-card-thumb-wrap">
              <ForumMedia
                class="cinema-card-thumb"
                :media="card.track"
                mode="card"
                hide-buttons
                :author="card.post.author"
                :permlink="card.post.permlink"
                :title="card.post.title"
                :t="t"
              />
              <span v-if="cardSource(card)" class="cinema-card-badge" :title="cardSource(card)!.label">
                <i :class="cardSource(card)!.icon"></i> {{ cardSource(card)!.label }}
              </span>
            </div>
            <div class="cinema-card-info">
              <div class="cinema-card-title">{{ card.post.title }}</div>
              <div class="cinema-card-meta gs">@{{ card.post.author }}</div>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.cinema-index {
  width: 100%;
  min-height: 200px;
  padding: calc(var(--cinema-hero-h, 40vh) + 24px) 16px 40px;
  box-sizing: border-box;
}

.cinema-hero {
  position: fixed;
  top: 0;
  left: 72px;
  right: 0;
  height: var(--cinema-hero-h, 40vh);
  min-height: var(--cinema-hero-h-min, 260px);
  z-index: 10;
  border-radius: 0;
  overflow: hidden;
  margin-bottom: 0;
  display: flex;
  align-items: flex-end;
}
@media (max-width: 768px) {
  .cinema-hero { left: 0; height: var(--cinema-hero-h-mobile, 32vh); min-height: var(--cinema-hero-h-min-mobile, 220px); }
  .cinema-index { padding-top: calc(var(--cinema-hero-h-mobile, 32vh) + 20px); }
}
.cinema-hero-backdrop {
  position: absolute; inset: 0;
  background: var(--surface-2) center / cover no-repeat;
  filter: brightness(0.6);
  /* Real alpha transparency, not a solid-color fade -- this is what
     actually lets whatever's behind (the fixed hero sits on top of the
     page) show through near the bottom, instead of just blending to a
     flat color that only works if it happens to match exactly. */
  -webkit-mask-image: linear-gradient(to top, transparent 0, black 100px, black 100%);
  mask-image: linear-gradient(to top, transparent 0, black 100px, black 100%);
}
.cinema-hero::after {
  /* Separate dark tint (not a mask) purely for text legibility where the
     hero title/meta/button sit -- independent of the backdrop's real
     transparency above. */
  content: "";
  position: absolute; inset: 0;
  background: linear-gradient(0deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.15) 45%, transparent 75%);
}
.cinema-hero-content { position: relative; z-index: 1; padding: 28px; max-width: 640px; }
.cinema-hero-title { font-size: 1.6rem; font-weight: 700; color: #fff; line-height: 1.2; margin-bottom: 10px; text-shadow: 0 2px 12px rgba(0,0,0,0.5); }
.cinema-hero-meta { color: rgba(255,255,255,0.8); font-size: 0.85rem; margin-bottom: 16px; }
.cinema-hero-play {
  display: inline-flex; align-items: center; gap: 10px;
  background: var(--brand); color: #fff; border: none;
  padding: 10px 22px; border-radius: 6px; font-weight: 700; font-size: 0.9rem;
  cursor: pointer;
}
.cinema-hero-play:hover { filter: brightness(1.1); }

.cinema-view-header { display: flex; align-items: center; gap: 16px; margin-bottom: 18px; }
.cinema-back-link {
  display: inline-flex; align-items: center; gap: 8px;
  background: var(--surface-2); border: 1px solid var(--surface-border);
  color: var(--text-strong); padding: 7px 14px; border-radius: 6px;
  font-size: 13px; font-weight: 600; cursor: pointer;
}
.cinema-back-link:hover { background: var(--surface-border); }
.cinema-view-title { font-size: 1.2rem; font-weight: 700; color: var(--text-strong); }

.cinema-row { margin-bottom: 30px; }
.cinema-row-title {
  font-size: 15px;
  font-weight: bold;
  color: var(--text-strong);
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.cinema-row-title i { color: var(--brand); }

.cinema-empty {
  font-size: 13px;
  color: var(--text-soft);
  opacity: 0.8;
  padding: 6px 4px;
}

.cinema-cards {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  overflow-y: visible;
  padding: 10px 10px 10px 6px;
}
.cinema-cards::-webkit-scrollbar { height: 6px; }
.cinema-cards::-webkit-scrollbar-thumb { background: var(--surface-border); border-radius: 3px; }

.cinema-card {
  flex: 0 0 240px;
  cursor: pointer;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 6px;
  overflow: hidden;
  transition: transform 0.15s ease;
}
.cinema-card:hover, .cinema-card:focus { transform: scale(1.04); outline: none; }

/* ForumMedia's own card-mode styles already render a 16:9 thumbnail (cover
   art / mirror resolution / webtorrent live status) -- hideButtons strips
   its built-in play/pause/queue overlay since this screen supplies its own
   single click-to-play action instead. */
.cinema-card-thumb-wrap { position: relative; }
.cinema-card-thumb { display: block; border-radius: 0; border: none; pointer-events: none; }

.cinema-card-badge {
  position: absolute;
  top: 6px; left: 6px;
  display: inline-flex; align-items: center; gap: 4px;
  background: rgba(0,0,0,0.65);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 4px;
  letter-spacing: 0.3px;
  pointer-events: none;
}

.cinema-card-info { padding: 8px 10px; }
.cinema-card-title {
  font-size: 12px; font-weight: bold; color: var(--card-title-color);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; line-height: 1.35; margin-bottom: 4px;
}
.cinema-card-meta { color: var(--card-muted-text); }
</style>
