<script setup lang="ts">
import type { Post, Beneficiary } from '../../types';
import PayoutDetails from '../PayoutDetails.vue';

defineProps<{
  payoutModal: {
    show: boolean;
    post: Partial<Post & { payoutDate?: string }>;
    beneficiaries: Beneficiary[];
  };
  t: (k: string) => string;
  fmtDate: (s: string) => string;
}>();

const emit = defineEmits<{
  close: [];
  openProfile: [username: string];
}>();
</script>

<template>
<!-- PAYOUT MODAL -->
<div v-if="payoutModal.show" class="modal-overlay" @click.self="emit('close')">
  <div class="modal-box">
    <div class="modal-header">
      {{ t('payoutDetails') }}
      <button class="modal-close" @click="emit('close')">✕</button>
    </div>
    <div class="modal-body">
      <PayoutDetails
        :payout-modal="payoutModal"
        :t="t"
        :fmt-date="fmtDate"
        @open-profile="(u: string) => { emit('openProfile', u); emit('close'); }"
      />
    </div>
  </div>
</div>
</template>
