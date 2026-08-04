<script setup lang="ts">
/**
 * components/CookieConsentBanner.vue
 *
 * Shown whenever cookie-consent.ts's `consent` is null (no decision made
 * yet this browser) -- see App.vue's `v-if="!cinemaMode && !cookieConsent"`.
 * Purely a thin UI shell around modules/cookie-consent.ts, which owns all
 * the actual state/persistence/GA-loading logic -- see that file's own
 * top-of-file comment for the full story of what this is fixing.
 *
 * `bottom` (px) is App.vue's `playerClearance + bcQueuePanelClearance`
 * computed -- the exact same "how far above the docked player" mechanism
 * .bc-queue-panel itself uses (see App.vue's own comment on that computed),
 * plus enough extra to also clear .bc-queue-panel when it's visible at the
 * same time, so the two stack instead of overlapping. Cinema mode isn't
 * handled here at all because this component is never shown during it (see
 * the `!cinemaMode` in App.vue's v-if above) -- there's no cinema-specific
 * "corner chip" variant for this the way .bc-queue-panel has one, since a
 * cookie-consent decision isn't the kind of thing that needs to interrupt
 * someone mid-video the way a blockchain-sync status does.
 */
defineProps<{ t: (k: string) => string; bottom: number }>();
const emit = defineEmits<{ accept: []; reject: []; 'open-privacy': [] }>();
</script>

<template>
  <div class="ccb-banner" role="dialog" aria-live="polite" :style="{ bottom: bottom + 'px' }">
    <div class="ccb-inner">
      <p class="ccb-text">
        {{ t('cookieBannerText') || 'We use cookies for essential site functionality and, only with your consent, for analytics (Google Analytics). See our' }}
        <a href="#" @click.stop.prevent="emit('open-privacy')">{{ t('privacyPolicy') || 'privacy policy' }}</a>.
      </p>
      <div class="ccb-actions">
        <button class="btn btn-sm ccb-reject" @click="emit('reject')">{{ t('cookieBannerReject') || 'Reject non-essential' }}</button>
        <button class="btn btn-sm ccb-accept" @click="emit('accept')">{{ t('cookieBannerAccept') || 'Accept' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ccb-banner {
  position: fixed;
  left: 0;
  right: 0;
  z-index: 10000;
  background: var(--surface-1, #1c2129);
  color: var(--text-strong, #eee);
  border-top: 1px solid var(--surface-border, rgba(255,255,255,0.12));
  box-shadow: 0 -3px 12px rgba(0,0,0,0.3);
  padding: 12px 16px;
  transition: bottom 0.3s ease-in-out;
}
.ccb-inner {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ccb-text {
  flex: 1 1 320px;
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}
.ccb-text a { text-decoration: underline; }
.ccb-actions {
  display: flex;
  gap: 8px;
  flex: 0 0 auto;
}
.ccb-accept {
  background: var(--brand, #d3a341);
  color: #1a1206;
  border: none;
  font-weight: 600;
}
.ccb-reject {
  background: transparent;
  border: 1px solid var(--surface-border, rgba(255,255,255,0.3));
  color: inherit;
}
@media (max-width: 600px) {
  .ccb-inner { flex-direction: column; align-items: stretch; }
  .ccb-actions { justify-content: stretch; }
  .ccb-actions button { flex: 1; }
}
</style>
