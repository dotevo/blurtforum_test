<script setup lang="ts">
/**
 * components/modals/PrivacyPolicyModal.vue
 *
 * Uses the shared .modal-overlay/.modal-box convention (see StructureDocs.vue)
 * rather than a dedicated routed page -- this app has no router, "views"
 * are switched via a plain `view` ref (see App.vue), and every other piece
 * of standalone legal/help content (StructureDocs) already works this way.
 * Bonus: .modal-overlay is also what modules/cinema/dpad-nav.ts's MODAL
 * zone looks for, so this gets D-pad trapping/Escape-to-close for free,
 * same reasoning as WebtorrentAudioSubtitlePanel.vue's own comment.
 *
 * Content is intentionally specific to what THIS app actually does (not a
 * generic boilerplate policy): Google Analytics only after consent (see
 * modules/cookie-consent.ts), what's kept in localStorage and why, and --
 * important and easy to miss for a WebTorrent-based site -- that using the
 * built-in video player exposes the viewer's IP address to other peers in
 * the swarm the same way any BitTorrent/WebRTC client does, independent of
 * this site's own consent settings.
 */
defineProps<{ t: (k: string) => string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
<div class="modal-overlay" @click.self="emit('close')">
  <div class="modal-box" style="width: 640px; max-width: 92vw; max-height: 85vh; overflow-y: auto;">
    <div class="modal-header">
      {{ t('privacyPolicyTitle') || 'Privacy policy' }}
      <button class="modal-close" @click="emit('close')">✕</button>
    </div>
    <div class="modal-body" style="font-size: 13px; line-height: 1.6;">
      <p class="gs">{{ t('privacyPolicyUpdated') || 'Last updated: August 2026' }}</p>

      <h4>{{ t('privacyPolicyControllerTitle') || '1. Who runs this site' }}</h4>
      <p>{{ t('privacyPolicyControllerBody') || 'BlurtForum (forum.blurt.pl) is a community-run, open-source front-end for the Blurt blockchain. It is not a company and does not run its own backend database of user accounts -- your account is a Blurt blockchain account, controlled entirely by your own private keys / Blurt Keychain, not by this site.' }}</p>

      <h4>{{ t('privacyPolicyCookiesTitle') || '2. Cookies & Google Analytics' }}</h4>
      <p>{{ t('privacyPolicyCookiesBody') || 'This site itself sets no tracking cookies. If you accept the cookie banner, Google Analytics is loaded and may set its own cookies (typically _ga, _ga_*) to measure aggregate site usage (pages viewed, general region, device type). It is not loaded at all if you reject or ignore the banner. You can change your choice at any time via "Cookie settings" in the footer.' }}</p>

      <h4>{{ t('privacyPolicyLocalStorageTitle') || '3. Local storage (not cookies)' }}</h4>
      <p>{{ t('privacyPolicyLocalStorageBody') || 'The app stores some data only in your own browser\'s local storage -- it never leaves your device and this site cannot read it from any other browser or user: your UI language/theme, your cookie-consent choice, draft posts/comments, your default vote weight, and playback/seeding preferences for the video player. Clearing your browser\'s site data removes all of it.' }}</p>

      <h4>{{ t('privacyPolicyBlockchainTitle') || '4. Blockchain data is public and permanent' }}</h4>
      <p>{{ t('privacyPolicyBlockchainBody') || 'Anything you post, comment, or vote on through this site is broadcast to the public Blurt blockchain -- exactly like any other Blurt front-end. That data is public, replicated across many independent nodes worldwide, and cannot be edited or deleted by this site (posts can usually be edited/blanked by their author for a limited window; blockchain history itself cannot). Do not post anything on-chain you are not comfortable being permanent and public.' }}</p>

      <h4>{{ t('privacyPolicyWebtorrentTitle') || '5. Video playback (WebTorrent) exposes your IP to other peers' }}</h4>
      <p>{{ t('privacyPolicyWebtorrentBody') || 'Some video content on this site plays via WebTorrent, a peer-to-peer (WebRTC/BitTorrent) technology. While watching such content, your browser connects directly to other peers in that torrent\'s swarm to exchange video data -- this is how the technology works, on this site as on any other WebTorrent/BitTorrent client, and means your IP address is visible to those other peers (and, for public trackers, potentially anyone monitoring the swarm), independent of any cookie setting. This is unrelated to and unaffected by the cookie consent choice above.' }}</p>

      <h4>{{ t('privacyPolicyThirdPartyTitle') || '6. Other third parties' }}</h4>
      <p>{{ t('privacyPolicyThirdPartyBody') || 'Blockchain reads/writes go through public Blurt RPC nodes operated by third parties (not this site), who can see the IP address of requests same as any web server. Embedded content from other platforms (e.g. video embeds) is subject to that platform\'s own privacy policy.' }}</p>

      <h4>{{ t('privacyPolicyRightsTitle') || '7. Your choices' }}</h4>
      <p>{{ t('privacyPolicyRightsBody') || 'You can reject or withdraw analytics consent at any time (footer link), and clear all local storage via your browser. Because on-chain data is public and permanent by design, there is no "delete my account data" mechanism this site can offer beyond what the Blurt protocol itself allows (e.g. editing/blanking your own posts).' }}</p>

      <h4>{{ t('privacyPolicyContactTitle') || '8. Contact' }}</h4>
      <p>{{ t('privacyPolicyContactBody') || 'Questions about this policy can be raised with the site operators via the community\'s own channels (see the forum footer).' }}</p>
    </div>
  </div>
</div>
</template>
