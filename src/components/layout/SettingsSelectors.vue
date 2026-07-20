<script setup lang="ts">
import ScrollableTabs from './ScrollableTabs.vue';

defineProps<{
  theme: string;
  themes: { id: string; label: string }[];
  lang: string;
  langs: string[];
  t: (k: string) => string;
  mobile?: boolean;
  /** Vertical stacked layout (full-width rows, icon + label), for use inside
   *  a narrow side rail instead of a horizontal top bar. */
  rail?: boolean;
  cinemaMode: boolean;
}>();

const emit = defineEmits<{
  'setTheme': [value: string];
  'setLang': [value: string];
  'openRpc': [];
  'setCinemaMode': [value: boolean];
}>();
</script>

<template>
  <!-- Rail (vertical side-nav): plain stacked list, never needs horizontal scrolling. -->
  <div v-if="rail" class="settings-selectors is-rail">
    <div class="selector-item">
      <i class="fa-solid fa-palette"></i>
      <span class="gs">{{ t('theme') }}:</span>
      <select :value="theme" @change="emit('setTheme', ($event.target as HTMLSelectElement).value)" class="lang-btn">
        <option v-for="th in themes" :key="th.id" :value="th.id">{{ th.label }}</option>
      </select>
    </div>
    <div class="selector-item">
      <i class="fa-solid fa-language"></i>
      <span class="gs">{{ t('lang') }}:</span>
      <select :value="lang" @change="emit('setLang', ($event.target as HTMLSelectElement).value)" class="lang-btn">
        <option v-for="l in (langs as any)" :key="l.code || l" :value="l.code || l">{{ l.name || l.toUpperCase() }}</option>
      </select>
    </div>
    <button class="lang-btn rpc-btn" @click="emit('openRpc')" :title="t('rpcSettings')">
      <i class="fa-solid fa-gear"></i> <span>{{ t('rpc') }}</span>
    </button>
    <button class="lang-btn rpc-btn cinema-btn" :class="{ active: cinemaMode }"
            @click="emit('setCinemaMode', !cinemaMode)" :title="t('cinemaMode') || 'Cinema mode'">
      <i class="fa-solid fa-film"></i> <span>{{ t('cinemaMode') || 'Cinema' }}</span>
    </button>
  </div>

  <!-- Top-bar layout: items keep their natural width and, if they don't all
       fit (mainly on narrow phones), the row scrolls horizontally with a
       drag/fade affordance instead of squeezing or overflowing off-screen —
       the same pattern used for the player's tabs. -->
  <ScrollableTabs v-else class="settings-selectors-scroll">
    <div class="settings-selectors" :class="{ 'is-mobile': mobile }">
      <div class="selector-item">
        <i class="fa-solid fa-palette"></i>
        <span class="gs hide-on-mobile" v-if="!mobile">{{ t('theme') }}:</span>
        <select :value="theme" @change="emit('setTheme', ($event.target as HTMLSelectElement).value)" class="lang-btn">
          <option v-for="th in themes" :key="th.id" :value="th.id">{{ th.label }}</option>
        </select>
      </div>
      <div class="selector-item">
        <i class="fa-solid fa-language"></i>
        <span class="gs hide-on-mobile" v-if="!mobile">{{ t('lang') }}:</span>
        <select :value="lang" @change="emit('setLang', ($event.target as HTMLSelectElement).value)" class="lang-btn">
          <option v-for="l in (langs as any)" :key="l.code || l" :value="l.code || l">{{ l.name || l.toUpperCase() }}</option>
        </select>
      </div>
      <button class="lang-btn rpc-btn" @click="emit('openRpc')" :title="t('rpcSettings')">
        <i class="fa-solid fa-gear"></i> <span v-if="!mobile">{{ t('rpc') }}</span>
      </button>
      <button class="lang-btn rpc-btn cinema-btn" :class="{ active: cinemaMode }"
              @click="emit('setCinemaMode', !cinemaMode)" :title="t('cinemaMode') || 'Cinema mode'">
        <i class="fa-solid fa-film"></i> <span v-if="!mobile">{{ t('cinemaMode') || 'Cinema' }}</span>
      </button>
    </div>
  </ScrollableTabs>
</template>

<style scoped>
/* The ScrollableTabs wrapper sizes itself to the available space in its
   flex parent (LangBar / MobileTopBar drawer) and handles overflow. */
.settings-selectors-scroll {
  width: 100%;
}

.settings-selectors {
  display: flex;
  gap: 10px;
  align-items: center;
}

.selector-item {
  display: flex;
  gap: 5px;
  align-items: center;
  flex-shrink: 0;
}

.selector-item i {
  font-size: 12px;
  color: var(--brand);
}

.lang-btn {
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  color: var(--text-strong);
  padding: 2px 6px;
  font-size: 11px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  font-family: inherit;
  font-weight: bold;
  outline: none;
}

.lang-btn:hover {
  border-color: var(--brand);
  background: var(--surface-2);
}

.rpc-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.cinema-btn.active {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
}

/* Mobile: items keep a comfortable, tappable minimum size instead of being
   squeezed — if they don't all fit, the surrounding ScrollableTabs lets the
   row scroll horizontally (with drag + fade edges) instead. */
.is-mobile {
  gap: 8px;
}

.is-mobile .selector-item {
  background: var(--surface-nav);
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--surface-border);
}

.is-mobile .selector-item select {
  border: none;
  background: transparent;
  padding: 0;
  max-width: 84px;
}

.is-mobile .rpc-btn {
  padding: 6px 10px;
  background: var(--surface-nav);
  border: 1px solid var(--surface-border);
}

.is-mobile .cinema-btn.active {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
}

.hide-on-mobile {
  display: none;
}

@media (min-width: 901px) {
  .hide-on-mobile {
    display: inline;
  }
}

/* Rail (vertical side-nav) layout: stacked full-width rows instead of a
   horizontal bar -- this is what a 72px-wide rail actually needs, the
   horizontal .is-mobile layout above was designed for a top bar and simply
   doesn't fit sideways. */
.is-rail {
  flex-direction: column;
  align-items: stretch;
  width: 100%;
  gap: 2px;
}
.is-rail .selector-item,
.is-rail .rpc-btn {
  width: 100%;
  box-sizing: border-box;
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 10px 22px;
  gap: 16px;
  justify-content: flex-start;
}
.is-rail .selector-item i,
.is-rail .rpc-btn i { font-size: 16px; width: 20px; text-align: center; }
.is-rail .selector-item:hover,
.is-rail .rpc-btn:hover { background: var(--surface-2); }
.is-rail .selector-item select {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text-strong);
  font-size: 13px;
  padding: 0;
}
.is-rail .cinema-btn.active { background: var(--brand); color: #fff; border-radius: var(--radius-sm); }
</style>
