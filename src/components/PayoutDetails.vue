<script setup lang="ts">
/**
 * components/PayoutDetails.vue
 *
 * Just the payout/voters breakdown -- no modal box, no overlay. Same
 * reasoning as modules/notifications/components/NotificationsList.vue:
 * this content doesn't know or care whether it's wrapped in a centered
 * modal (classic forum, see PayoutModal.vue) or docked in cinema mode's
 * side panel (see modules/cinema/CinemaRail.vue) -- exactly one place
 * owns the actual markup either way.
 */
import type { Post, Beneficiary } from '../types';

defineProps<{
  payoutModal: {
    post: Partial<Post & { payoutDate?: string }>;
    beneficiaries: Beneficiary[];
  };
  t: (k: string) => string;
  fmtDate: (s: string) => string;
}>();

const emit = defineEmits<{
  openProfile: [username: string];
}>();
</script>

<template>
<div style="margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #D1D7DC;">
  <div style="font-weight: bold; color: var(--brand);">{{ t('payoutStatus') }}</div>
  <div v-if="payoutModal.post.isPaid" class="alert alert-success" style="margin-top: 5px;">
    {{ t('paidOn') }}: {{ payoutModal.post.payoutDate }}
  </div>
  <div v-else class="alert alert-info" style="margin-top: 5px;">
    {{ t('pendingPayout') }}: {{ (payoutModal.post.pendingPayout || 0).toFixed(3) }} BLURT<br>
    <span class="gs">{{ t('expectedOn') }}: {{ payoutModal.post.payoutDate }}</span>
  </div>
</div>
<div v-if="payoutModal.beneficiaries && payoutModal.beneficiaries.length" style="margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid var(--surface-border);">
  <div style="font-weight: bold; color: var(--brand); margin-bottom: 8px;">{{ t('beneficiaries') }}</div>
  <div style="border: 1px solid var(--surface-border); background: var(--surface-2); border-radius: 4px; overflow: hidden;">
    <div v-for="b in payoutModal.beneficiaries" :key="b.account"
         style="padding: 6px 10px; border-bottom: 1px solid var(--surface-border); display: flex; justify-content: space-between; align-items: center;">
      <span style="font-weight: bold;"><a href="#" @click.prevent="emit('openProfile', b.account)">@{{ b.account }}</a></span>
      <span class="gs">{{ ((b.weight || 0) / 100).toFixed(0) }}%</span>
    </div>
  </div>
</div>
<div style="font-weight: bold; color: var(--brand); margin-bottom: 8px;">{{ t('voters') }} ({{ (payoutModal.post.active_votes || []).length }})</div>
<div style="max-height: 300px; overflow-y: auto; border: 1px solid var(--surface-border); background: var(--surface-2); border-radius: 4px;">
  <div v-for="v in payoutModal.post.active_votes" :key="v.voter"
       style="padding: 5px 10px; border-bottom: 1px solid var(--surface-border); display: flex; justify-content: space-between; align-items: center;">
    <span style="font-weight: bold;"><a href="#" @click.prevent="emit('openProfile', v.voter)">@{{ v.voter }}</a></span>
    <span class="gs">
      {{ (v.percent / 100).toFixed(0) }}%
      <template v-if="(payoutModal.post.net_rshares ?? 0) > 0">
        ({{ ((v.rshares ?? 0) / (payoutModal.post.net_rshares ?? 0) * (payoutModal.post.payout || 0)).toFixed(3) }} B)
      </template>
    </span>
  </div>
  <div v-if="!(payoutModal.post.active_votes || []).length" style="padding: 10px; text-align: center; color: var(--text-soft);">{{ t('noVotes') }}</div>
</div>
</template>
