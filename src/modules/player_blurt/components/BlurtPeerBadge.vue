<script setup lang="ts">
/**
 * modules/player_blurt/components/BlurtPeerBadge.vue
 *
 * Registered by blurt-player-plugin.ts via player.webtorrent.registerPeerAction()
 * — mounted once per row in the existing webtorrent peer list
 * (WebtorrentInfoModal.vue). Renders nothing at all unless this exact
 * peer (infoHash + peerId) has announced itself via blurt-peer-handshake.ts
 * — the player core has no idea this component exists, let alone what
 * "verified" means.
 *
 * Two visual states, deliberately different (see blurt-peer-handshake.ts's
 * big comment on IDENTITY VS VERIFICATION for why both exist): a green
 * checkmark for a cryptographically verified signature, a greyed-out
 * question mark for a self-claimed-only identity (signing wasn't
 * possible/available for that peer right now — not necessarily anything
 * suspicious, just unproven).
 *
 * Profile link: this component lives inside the (protocol-agnostic) player
 * module, which has no access to the app's router/composables — same
 * situation as DOMPurify-sanitized HTML content elsewhere in the app,
 * which is exactly why `window.app.openProfile(username)` exists (see
 * useApp.ts, where it's set up expressly "for DOMPurify-sanitized content
 * and E2E testing"). Using that instead of a plain <a href target="_blank">
 * matches how PostBeneficiaries.vue and friends already link to profiles —
 * a real `?view=profile&user=...` href (so right-click / middle-click /
 * "open in new tab" keep working via normal browser behavior), with a
 * left-click intercepted to navigate in-place through the SPA router
 * instead of a full reload or a forced new tab.
 */
import { computed } from 'vue';
import { peerIdentities } from '../blurt-peer-handshake';

const props = defineProps<{
  peerId: string | null;
  infoHash: string | null;
  addr?: string;
  t?: (k: string) => string;
}>();

const identity = computed(() => {
  if (!props.peerId || !props.infoHash) return null;
  return peerIdentities.get(`${props.infoHash}:${props.peerId}`) || null;
});

function openProfile(): void {
  const account = identity.value?.account;
  if (!account) return;
  const app = (window as any).app;
  if (app?.openProfile) {
    app.openProfile(account);
  } else {
    // Fallback if window.app isn't ready yet for some reason — still
    // better than a dead link.
    window.location.href = `?view=profile&user=${account}`;
  }
}
</script>

<template>
  <a
    v-if="identity"
    class="blurt-peer-badge"
    :class="{ 'blurt-peer-badge--unverified': !identity.verified }"
    :href="`?view=profile&user=${identity.account}`"
    :title="identity.verified
      ? (t ? t('blurtVerifiedPeer') : `Verified Blurt account: @${identity.account}`)
      : (t ? t('blurtUnverifiedPeer') : `Claims to be @${identity.account} — not cryptographically verified`)"
    @click.prevent="openProfile"
  >
    <i class="fa-solid" :class="identity.verified ? 'fa-circle-check' : 'fa-circle-question'"></i>@{{ identity.account }}
  </a>
</template>

<style scoped>
.blurt-peer-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  /* Verified = the app's existing "success" palette — already tuned per
     theme (light/dark/sepia/etc, see style.css) rather than a hardcoded
     color that only happened to work on a dark background. */
  background: var(--alert-success-bg);
  color: var(--alert-success-text);
  border: 1px solid var(--alert-success-border);
  border-radius: 5px;
  padding: 2px 6px;
  font-size: 10px;
  font-family: inherit;
  text-decoration: none;
  flex-shrink: 0;
  white-space: nowrap;
}
.blurt-peer-badge:hover {
  filter: brightness(1.1);
}
.blurt-peer-badge--unverified {
  /* Unverified = neutral/muted, same idea: theme-aware surface + muted
     text instead of a fixed rgba(255,255,255,...) that vanished on light
     backgrounds. */
  background: var(--surface-3);
  color: var(--text-soft);
  border-color: var(--surface-border);
}
</style>