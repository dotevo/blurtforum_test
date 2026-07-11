<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { renderCombo, type ChartHandle, type ComboOptions, type ComboSeriesInput } from './mini-charts';

const props = defineProps<{
  categories: string[];
  series: ComboSeriesInput[];
  height?: number;
  selectedIndex?: number | null;
  highlightIndex?: number | null;
  primaryAxisLabel?: string;
  secondaryAxisLabel?: string;
  tooltipHtml?: (index: number) => string;
}>();

const emit = defineEmits<{ select: [index: number] }>();

const el = ref<HTMLDivElement | null>(null);
let handle: ChartHandle<ComboOptions, ComboOptions> | null = null;

const currentOpts = (): ComboOptions => ({
  categories: props.categories,
  series: props.series,
  height: props.height,
  selectedIndex: props.selectedIndex,
  highlightIndex: props.highlightIndex,
  primaryAxisLabel: props.primaryAxisLabel,
  secondaryAxisLabel: props.secondaryAxisLabel,
  tooltipHtml: props.tooltipHtml,
  onSelect: (index: number) => emit('select', index),
});

onMounted(() => {
  if (!el.value) return;
  handle = renderCombo(el.value, currentOpts());
});

watch(
  () => [props.categories, props.series, props.selectedIndex, props.highlightIndex] as const,
  () => handle?.update(currentOpts()),
  { deep: true }
);

onBeforeUnmount(() => handle?.destroy());
</script>

<template>
  <div ref="el" class="mini-chart-host"></div>
</template>
