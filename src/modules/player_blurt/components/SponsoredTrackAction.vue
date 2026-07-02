<script setup lang="ts">
/**
 * modules/player_blurt/components/SponsoredTrackAction.vue
 *
 * Registered by sponsored-plugin.ts via player.registerTrackAction() with
 * zone: 'expanded' only — deliberately absent from the mini bar. Fully
 * self-contained: owns its own open/close state and renders its own modal,
 * so it doesn't need any event to bubble up to the app (unlike
 * BlurtTrackActions, which needs openPayoutModal/submitVote handled by the
 * app). `client` arrives as a static prop from the plugin's registration,
 * not from whatever host happens to render this.
 */
import { ref } from 'vue';
import SponsoredCampaignsModal from './SponsoredCampaignsModal.vue';

defineProps<{
  client: any;
  t?: (k: string) => string;
}>();

const showModal = ref(false);
const tOrFallback = (t: ((k: string) => string) | undefined, key: string, fallback: string): string =>
  (t ? t(key) : '') || fallback;
</script>

<template>
  <button
    type="button"
    class="sp-ads-toggle"
    :title="tOrFallback(t, 'sponsoredAds', 'Sponsored ads / current prices')"
    @click.stop="showModal = true"
  >
    <i class="fa-solid fa-bullhorn"></i>
  </button>

  <SponsoredCampaignsModal
    v-if="showModal"
    :client="client"
    :t="t || ((_k: string) => '')"
    @close="showModal = false"
  />
</template>

<style scoped>
.sp-ads-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--primary, #006699);
  opacity: 0.7;
  cursor: pointer;
  font-size: 13px;
  transition: opacity 0.2s;
}
.sp-ads-toggle:hover { opacity: 1; }
</style>
