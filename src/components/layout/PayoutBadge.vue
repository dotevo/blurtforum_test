<script setup lang="ts">
import type { Post } from '../../types';

defineProps<{
  post: Post | Partial<Post>;
  precision?: number;
  showCurrency?: boolean;
}>();

const emit = defineEmits<{
  click: [post: Post | Partial<Post>];
}>();
</script>

<template>
  <span class="badge payout-link" 
        :class="post.isPaid ? 'badge-green' : 'badge-blue'" 
        @click.stop="emit('click', post)">
    {{ (post.payout || 0).toFixed(precision !== undefined ? precision : 2) }} {{ showCurrency ? 'BLURT' : 'B' }}
  </span>
</template>

<style scoped>
/* Colors come from the global .badge/.badge-blue/.badge-green theme styles.
   Only the pointer cursor is specific to this clickable instance. */
.badge {
  cursor: pointer;
}
.payout-link:hover {
  opacity: 0.8;
}
</style>
