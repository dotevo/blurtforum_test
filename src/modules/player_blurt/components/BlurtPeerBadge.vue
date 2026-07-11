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
</script>

<template>
  <a
    v-if="identity"
    class="blurt-peer-badge"
    :class="{ 'blurt-peer-badge--unverified': !identity.verified }"
    :href="`/@${identity.account}`"
    target="_blank"
    rel="noopener"
    :title="identity.verified
      ? (t ? t('blurtVerifiedPeer') : `Verified Blurt account: @${identity.account}`)
      : (t ? t('blurtUnverifiedPeer') : `Claims to be @${identity.account} — not cryptographically verified`)"
    @click.stop
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
  background: var(--success-bg);
  color: var(--success-text);
  border: 1px solid var(--success-border);
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
  background: var(--bg-r2);
  color: var(--text-muted);
  border-color: var(--border-main);
}
</style>