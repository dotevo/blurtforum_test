<script setup lang="ts">
const props = defineProps<{
  voted: boolean;
  count: number;
  pending?: boolean;
  t?: (k: string) => string;
}>();

const emit = defineEmits<{
  vote: [];
}>();
</script>

<template>
  <span
    class="vote-btn"
    :class="{ active: voted, pending: pending }"
    role="button"
    tabindex="0"
    :title="pending ? (props.t ? props.t('syncing') : 'blockchain…') : undefined"
    @click.stop="emit('vote')"
    @keydown.enter.space.stop.prevent="emit('vote')"
  >
    <i v-if="pending" class="fa-solid fa-circle-notch fa-spin vote-pending-icon"></i>
    <i v-else class="fa-solid fa-caret-up"></i>
    <span class="vote-count">{{ count }}</span>
  </span>
</template>

<style scoped>
.vote-btn { 
  cursor: pointer; 
  color: var(--text-soft); 
  font-size: 14px; 
  user-select: none; 
  transition: all 0.2s ease; 
  display: inline-flex; 
  align-items: center; 
  justify-content: center; 
  gap: 4px;
  line-height: 1; 
  padding: 2px 6px;
  border-radius: 4px;
}
.vote-btn:hover { color: var(--brand); transform: scale(1.1); background: var(--surface-4); }
.vote-btn.active { color: var(--state-active); filter: drop-shadow(0 0 3px var(--state-active)); transform: scale(1.1); font-weight: bold; }
.vote-btn.pending { opacity: 0.75; }
.vote-btn i { filter: drop-shadow(0 1px 2px rgba(0,0,0,0.2)); }
.vote-pending-icon { color: var(--state-active); }

.vote-count {
  font-size: 10px;
  font-weight: bold;
}
</style>
