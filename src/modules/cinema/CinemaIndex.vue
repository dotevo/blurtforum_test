<script setup lang="ts">
/**
 * Cinema mode's "browse" screen — a VOD-style grid, either:
 *  - category rows (posts containing embedded media, grouped by tag), or
 *  - the user's playlists (rows = playlists, cards = playlist tracks)
 * toggled via player.state.cinemaBrowseView.
 *
 * Enhanced with multi-tag fetching, multi-sort fallback (trending -> created),
 * and automatic deduplication per category.
 */
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { Blockchain } from '../blockchain';
import { PostProcessor } from '../post-processor';
import { state as playerState, playlistState, playTrack, togglePlay } from '../player/player';
import ForumMedia from '../player_blurt/components/ForumMedia.ce.vue';
import type { MediaTrack } from '../player/types';

const props = defineProps<{
  client: any;
  t: (k: string) => string;
}>();

interface CinemaCard {
  post: { author: string; permlink: string; title: string };
  track: MediaTrack;
}

type SortMethod = 'trending' | 'created' | 'hot';

interface CinemaRow {
  id: string;
  label: string;
  icon: string;
  /** Primary and fallback tags to fetch videos from */
  tags: string[];
  /** Order of sort methods to attempt for each tag (e.g. trending first, fallback to newest/created) */
  sorts: SortMethod[];
  cards: CinemaCard[];
  loading: boolean;
  rawCount: number;
  error: string | null;
  /** Index of current active tag from tags[] */
  currentTagIndex: number;
  /** Index of current active sort method from sorts[] */
  currentSortIndex: number;
  /** Pagination cursor for current tag/sort stream */
  cursor?: { author: string; permlink: string } | null;
  /** Set when all tags and sort methods for this row are fully exhausted */
  exhausted?: boolean;
  loadingMore?: boolean;
  /** Set of unique author/permlink identifiers to prevent duplicate cards */
  seenKeys: Set<string>;
}

// Small badge so a thumbnail's source is identifiable at a glance
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

// Expanded & optimized categories with primary + fallback tags, ranked by video density
const categories = ref<CinemaRow[]>([
  {
    id: 'video',
    label: 'Featured Videos',
    icon: 'fa-solid fa-film',
    tags: ['video', 'blurt-video', 'blurtmedia', 'vlog'],
    sorts: ['trending', 'created'],
    cards: [], loading: true, rawCount: 0, error: null,
    currentTagIndex: 0, currentSortIndex: 0, cursor: null,
    exhausted: false, loadingMore: false, seenKeys: new Set()
  },
  {
    id: 'vlogs',
    label: 'Vlogs & Stories',
    icon: 'fa-solid fa-video',
    tags: ['vlog', 'life', 'blog'],
    sorts: ['trending', 'created'],
    cards: [], loading: true, rawCount: 0, error: null,
    currentTagIndex: 0, currentSortIndex: 0, cursor: null,
    exhausted: false, loadingMore: false, seenKeys: new Set()
  },
  {
    id: 'blurtmedia',
    label: 'Blurt Originals',
    icon: 'fa-solid fa-fire',
    tags: ['blurtmedia', 'blurt-video', 'blurt'],
    sorts: ['trending', 'created'],
    cards: [], loading: true, rawCount: 0, error: null,
    currentTagIndex: 0, currentSortIndex: 0, cursor: null,
    exhausted: false, loadingMore: false, seenKeys: new Set()
  },
  {
    id: 'music',
    label: 'Music & Performance',
    icon: 'fa-solid fa-music',
    tags: ['music', 'song', 'livemusic', 'audio'],
    sorts: ['trending', 'created'],
    cards: [], loading: true, rawCount: 0, error: null,
    currentTagIndex: 0, currentSortIndex: 0, cursor: null,
    exhausted: false, loadingMore: false, seenKeys: new Set()
  },
  {
    id: 'gaming',
    label: 'Gaming & Esports',
    icon: 'fa-solid fa-gamepad',
    tags: ['gaming', 'game', 'play2earn', 'gameplay'],
    sorts: ['trending', 'created'],
    cards: [], loading: true, rawCount: 0, error: null,
    currentTagIndex: 0, currentSortIndex: 0, cursor: null,
    exhausted: false, loadingMore: false, seenKeys: new Set()
  },
  {
    id: 'crypto',
    label: 'Crypto & Finance',
    icon: 'fa-solid fa-coins',
    tags: ['crypto', 'bitcoin', 'blockchain', 'finances'],
    sorts: ['trending', 'created'],
    cards: [], loading: true, rawCount: 0, error: null,
    currentTagIndex: 0, currentSortIndex: 0, cursor: null,
    exhausted: false, loadingMore: false, seenKeys: new Set()
  },
  {
    id: 'movies',
    label: 'Cinema & Reviews',
    icon: 'fa-solid fa-clapperboard',
    tags: ['movies', 'cinema', 'film', 'movie'],
    sorts: ['trending', 'created'],
    cards: [], loading: true, rawCount: 0, error: null,
    currentTagIndex: 0, currentSortIndex: 0, cursor: null,
    exhausted: false, loadingMore: false, seenKeys: new Set()
  },
  {
    id: 'comedy',
    label: 'Comedy & Entertainment',
    icon: 'fa-solid fa-masks-theater',
    tags: ['comedy', 'fun', 'funny', 'humor'],
    sorts: ['trending', 'created'],
    cards: [], loading: true, rawCount: 0, error: null,
    currentTagIndex: 0, currentSortIndex: 0, cursor: null,
    exhausted: false, loadingMore: false, seenKeys: new Set()
  },
  {
    id: 'tech',
    label: 'Tech & Science',
    icon: 'fa-solid fa-microchip',
    tags: ['tech', 'technology', 'gadgets', 'tutorials'],
    sorts: ['trending', 'created'],
    cards: [], loading: true, rawCount: 0, error: null,
    currentTagIndex: 0, currentSortIndex: 0, cursor: null,
    exhausted: false, loadingMore: false, seenKeys: new Set()
  },
  {
    id: 'sport',
    label: 'Sports & Fitness',
    icon: 'fa-solid fa-futbol',
    tags: ['sport', 'sports', 'fitness', 'workout'],
    sorts: ['trending', 'created'],
    cards: [], loading: true, rawCount: 0, error: null,
    currentTagIndex: 0, currentSortIndex: 0, cursor: null,
    exhausted: false, loadingMore: false, seenKeys: new Set()
  },
  {
    id: 'food',
    label: 'Cooking & Food',
    icon: 'fa-solid fa-utensils',
    tags: ['food', 'cooking', 'recipe', 'foodie'],
    sorts: ['trending', 'created'],
    cards: [], loading: true, rawCount: 0, error: null,
    currentTagIndex: 0, currentSortIndex: 0, cursor: null,
    exhausted: false, loadingMore: false, seenKeys: new Set()
  },
  {
    id: 'podcasts',
    label: 'Podcasts & Shows',
    icon: 'fa-solid fa-podcast',
    tags: ['podcast', 'podcasts', 'interview', 'show'],
    sorts: ['trending', 'created'],
    cards: [], loading: true, rawCount: 0, error: null,
    currentTagIndex: 0, currentSortIndex: 0, cursor: null,
    exhausted: false, loadingMore: false, seenKeys: new Set()
  },
]);

const PAGE_SIZE = 10;
const AUTO_FETCH_TARGET = 10;

/**
 * Advances category pointer to the next sort mode or tag when current stream is exhausted.
 */
function advanceCursorToNextMode(cat: CinemaRow): void {
  cat.cursor = null;
  cat.currentSortIndex++;

  // If we ran through all sorts for this tag, move to the next tag
  if (cat.currentSortIndex >= cat.sorts.length) {
    cat.currentSortIndex = 0;
    cat.currentTagIndex++;
  }

  // If we ran through all tags, mark row as fully exhausted
  if (cat.currentTagIndex >= cat.tags.length) {
    cat.exhausted = true;
  }
}

/**
 * Multi-tag & Multi-sort fetching loop with built-in deduplication.
 */
async function fetchMoreForCategory(cat: CinemaRow, target: number): Promise<void> {
  let emptyAttemptsInARow = 0;
  const MAX_EMPTY_ATTEMPTS = 5;

  while (cat.cards.length < target && !cat.exhausted) {
    if (cat.currentTagIndex >= cat.tags.length) {
      cat.exhausted = true;
      break;
    }

    const currentTag = cat.tags[cat.currentTagIndex];
    const currentSort = cat.sorts[cat.currentSortIndex];

    let raw: any[] = [];
    try {
      raw = await Blockchain.getRankedPosts(
        props.client,
        currentSort,
        currentTag,
        PAGE_SIZE,
        cat.cursor?.author,
        cat.cursor?.permlink
      );
    } catch (e) {
      cat.error = e instanceof Error ? e.message : String(e);
      advanceCursorToNextMode(cat);
      continue;
    }

    // Drop cursor post returned by bridge API convention
    if (cat.cursor && raw.length && raw[0].author === cat.cursor.author && raw[0].permlink === cat.cursor.permlink) {
      raw = raw.slice(1);
    }

    if (!raw.length) {
      advanceCursorToNextMode(cat);
      emptyAttemptsInARow++;
      if (emptyAttemptsInARow >= MAX_EMPTY_ATTEMPTS) {
        cat.exhausted = true;
        break;
      }
      continue;
    }

    cat.rawCount += raw.length;
    const lastRaw = raw[raw.length - 1];
    cat.cursor = { author: lastRaw.author, permlink: lastRaw.permlink };

    let addedThisPage = 0;
    for (const r of raw) {
      const post = PostProcessor.normalizePost(r);
      const postKey = `${post.author}/${post.permlink}`;

      // Deduplication check: skip if post is already present in this row
      if (cat.seenKeys.has(postKey)) {
        continue;
      }

      if (post.tracks && post.tracks.length) {
        const track = post.tracks[0] as unknown as MediaTrack;
        cat.seenKeys.add(postKey);
        cat.cards.push({
          post: { author: post.author, permlink: post.permlink, title: post.title },
          track,
        });
        addedThisPage++;
      }
    }

    if (cat.cards.length && !currentCard.value) {
      updateHero(cat.cards[0]);
    }

    // End of stream for current tag + sort method
    if (raw.length < PAGE_SIZE) {
      advanceCursorToNextMode(cat);
    }

    if (addedThisPage === 0) {
      emptyAttemptsInARow++;
      if (emptyAttemptsInARow >= MAX_EMPTY_ATTEMPTS) {
        advanceCursorToNextMode(cat);
      }
    } else {
      emptyAttemptsInARow = 0;
    }
  }
}

const loadCategory = async (cat: CinemaRow): Promise<void> => {
  cat.loading = true;
  cat.error = null;
  cat.cards = [];
  cat.rawCount = 0;
  cat.cursor = null;
  cat.currentTagIndex = 0;
  cat.currentSortIndex = 0;
  cat.exhausted = false;
  cat.seenKeys = new Set<string>();
  await fetchMoreForCategory(cat, AUTO_FETCH_TARGET);
  cat.loading = false;
};

async function loadMoreForCategory(cat: CinemaRow): Promise<void> {
  if (cat.loadingMore || cat.exhausted) return;
  cat.loadingMore = true;
  try {
    await fetchMoreForCategory(cat, cat.cards.length + AUTO_FETCH_TARGET);
  } finally {
    cat.loadingMore = false;
  }
}

// Playlists view mapping
const playlistRows = computed<CinemaRow[]>(() =>
  playlistState.playlists.map((pl) => ({
    id: pl.id,
    label: pl.name,
    icon: 'fa-solid fa-list',
    tags: [],
    sorts: [],
    loading: false,
    rawCount: pl.tracks.length,
    error: null,
    currentTagIndex: 0,
    currentSortIndex: 0,
    seenKeys: new Set(),
    cards: pl.tracks.map((track) => ({
      post: { author: track.author, permlink: track.permlink, title: track.title },
      track,
    })),
  }))
);

const rows = computed<CinemaRow[]>(() =>
  playerState.cinemaBrowseView === 'playlists' ? playlistRows.value : categories.value
);

// Hero state & controls
const currentCard = ref<CinemaCard | null>(null);
const updateHero = (card: CinemaCard) => { currentCard.value = card; };

const isCardActive = (card: CinemaCard): boolean => {
  const current = playerState.currentTrack;
  if (!current) return false;
  return current.author === card.track.author && current.permlink === card.track.permlink && current.subId === card.track.subId;
};

const playCard = async (card: CinemaCard): Promise<void> => {
  updateHero(card);
  if (isCardActive(card)) {
    togglePlay();
  } else {
    await playTrack(card.track, true);
  }
  playerState.cinema = true;
  playerState.expanded = true;
  playerState.minimized = false;
};

watch(() => playerState.currentTrack, (track) => {
  if (!track) return;
  playerState.cinema = true;
  playerState.expanded = true;
  playerState.minimized = false;
});

onMounted(() => {
  categories.value.forEach(loadCategory);
  playerState.hidden = true;
});

onUnmounted(() => {
  playerState.hidden = false;
  playerState.cinemaBrowseView = 'categories';
});

// Keyboard & D-pad focus management
const gridEl = ref<HTMLElement | null>(null);
let hasAutoFocused = false;

watch(rows, () => {
  if (hasAutoFocused) return;
  nextTick(() => {
    if (hasAutoFocused) return;
    const first = gridEl.value?.querySelector<HTMLElement>('.cinema-card');
    if (first) {
      hasAutoFocused = true;
      first.focus({ preventScroll: true });
    }
  });
}, { deep: true, immediate: true });

watch(() => playerState.cinemaBrowseView, () => { hasAutoFocused = false; });
</script>

<template>
  <div ref="gridEl" class="cinema-index">

    <section class="cinema-hero" v-if="currentCard">
      <ForumMedia
        :key="currentCard.post.author + '/' + currentCard.post.permlink"
        class="cinema-hero-backdrop"
        :media="currentCard.track"
        mode="card"
        hide-buttons
        :author="currentCard.post.author"
        :permlink="currentCard.post.permlink"
        :title="currentCard.post.title"
        :t="t"
      />
      <div class="cinema-hero-content">
        <h1 class="cinema-hero-title">{{ currentCard.post.title }}</h1>
        <div class="cinema-hero-meta">
          <span><i class="fa-solid fa-user-astronaut"></i> @{{ currentCard.post.author }}</span>
        </div>
        <button class="cinema-hero-play" @click="playCard(currentCard)">
          <i class="fa-solid fa-play"></i> {{ t('play') || 'Play' }}
        </button>
      </div>
    </section>

    <div v-if="playerState.cinemaBrowseView === 'playlists'" class="cinema-view-header">
      <button class="cinema-back-link" @click="playerState.cinemaBrowseView = 'categories'">
        <i class="fa-solid fa-arrow-left"></i> {{ t('categories') || 'Categories' }}
      </button>
      <h1 class="cinema-view-title">{{ t('playlists') || 'Playlists' }}</h1>
    </div>

    <div v-if="playerState.cinemaBrowseView === 'playlists' && !rows.length" class="cinema-empty">
      {{ t('noPlaylists') || 'You do not have any playlists yet.' }}
    </div>

    <template v-for="row in rows" :key="row.id">
      <section class="cinema-row">
        <h2 class="cinema-row-title"><i :class="row.icon"></i> {{ row.label }}</h2>

        <div v-if="row.loading" class="loader"><span class="spin"></span></div>

        <div v-else-if="row.error" class="cinema-empty">
          {{ t('error') || 'Error' }}: {{ row.error }}
        </div>

        <div v-else-if="!row.cards.length" class="cinema-empty">
          {{ playerState.cinemaBrowseView === 'playlists'
              ? (t('emptyPlaylist') || 'This playlist is empty.')
              : `${row.rawCount} ${t('postsFetched') || 'posts fetched'}, 0 ${t('withDetectedMedia') || 'with detected media'}` }}
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

          <button
            v-if="playerState.cinemaBrowseView === 'categories' && !row.exhausted"
            class="cinema-card cinema-load-more-btn"
            :disabled="row.loadingMore"
            @click="loadMoreForCategory(row)"
          >
            <span v-if="row.loadingMore" class="spin"></span>
            <template v-else>
              <i class="fa-solid fa-plus"></i>
              <span>{{ t('loadMore') || 'Load More' }}</span>
            </template>
          </button>
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
  .cinema-card { scroll-margin-top: calc(var(--cinema-hero-h-mobile, 32vh) + 20px + 50px); }
}
.cinema-hero-backdrop {
  position: absolute; inset: 0;
  display: block;
  filter: brightness(0.6);
  -webkit-mask-image: linear-gradient(to top, transparent 0, black 100px, black 100%);
  mask-image: linear-gradient(to top, transparent 0, black 100px, black 100%);
}
.cinema-hero-backdrop :deep(.media-placeholder) {
  width: 100%;
  height: 100%;
  aspect-ratio: unset;
  border-radius: 0;
  border: none;
}
.cinema-hero::after {
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
  padding: 24px 20px;
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
  scroll-margin-top: calc(var(--cinema-hero-h, 40vh) + 24px + 50px);
}
.cinema-card:hover { transform: scale(1.04); outline: none; }
.cinema-card:focus-visible {
  transform: scale(1.1);
  outline: none;
  z-index: 5;
  position: relative;
  box-shadow: 0 0 0 4px var(--brand), 0 8px 30px rgba(0,0,0,0.6);
}

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

.cinema-load-more-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  aspect-ratio: 240 / 175;
  background: var(--surface-2);
  border: 1px dashed var(--card-border);
  color: var(--text-soft);
  font-size: 12px;
  font-weight: 600;
}
.cinema-load-more-btn:hover:not(:disabled) { background: var(--surface-3); color: var(--text-strong); border-color: var(--brand); }
.cinema-load-more-btn i { font-size: 18px; }
.cinema-load-more-btn:disabled { cursor: default; opacity: 0.7; }
</style>
