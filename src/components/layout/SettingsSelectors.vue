<script setup lang="ts">
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
  <div class="settings-selectors" :class="{ 'is-mobile': mobile, 'is-rail': rail }">
    <div class="selector-item">
      <i class="fa-solid fa-palette"></i>
      <span class="gs hide-on-mobile" v-if="!mobile || rail">{{ t('theme') }}:</span>
      <select :value="theme" @change="emit('setTheme', ($event.target as HTMLSelectElement).value)" class="lang-btn">
        <option v-for="th in themes" :key="th.id" :value="th.id">{{ th.label }}</option>
      </select>
    </div>
    <div class="selector-item">
      <i class="fa-solid fa-language"></i>
      <span class="gs hide-on-mobile" v-if="!mobile || rail">{{ t('lang') }}:</span>
      <select :value="lang" @change="emit('setLang', ($event.target as HTMLSelectElement).value)" class="lang-btn">
        <option v-for="l in (langs as any)" :key="l.code || l" :value="l.code || l">{{ l.name || l.toUpperCase() }}</option>
      </select>
    </div>
    <button class="lang-btn rpc-btn" @click="emit('openRpc')" :title="t('rpcSettings')">
      <i class="fa-solid fa-gear"></i> <span v-if="!mobile || rail">{{ t('rpc') }}</span>
    </button>
    <button class="lang-btn rpc-btn cinema-btn" :class="{ active: cinemaMode }"
            @click="emit('setCinemaMode', !cinemaMode)" :title="t('cinemaMode') || 'Cinema mode'">
      <i class="fa-solid fa-film"></i> <span v-if="!mobile || rail">{{ t('cinemaMode') || 'Cinema' }}</span>
    </button>
  </div>
</template>

<style scoped>
.settings-selectors {
  display: flex;
  gap: 10px;
  align-items: center;
}

.selector-item {
  display: flex;
  gap: 5px;
  align-items: center;
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
  border-radius: 4px;
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
}

.cinema-btn.active {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
}

/* Mobile overrides */
.is-mobile {
  width: 100%;
  justify-content: space-between;
  gap: 5px;
}

.is-mobile .selector-item {
  flex: 1;
  background: var(--surface-nav);
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid var(--surface-border);
}

.is-mobile .selector-item select {
  flex: 1;
  border: none;
  background: transparent;
  padding: 0;
  width: 100%;
}

.is-mobile .rpc-btn {
  flex: 0 0 auto;
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
.is-rail .cinema-btn.active { background: var(--brand); color: #fff; border-radius: 4px; }
</style>
