<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { renderDonut, type ChartHandle, type DonutOptions } from './mini-charts';

const props = defineProps<{
  series: number[];
  labels: string[];
  colors: string[];
  totalLabel?: string;
}>();

const el = ref<HTMLDivElement | null>(null);
let handle: ChartHandle<number[], DonutOptions> | null = null;

onMounted(() => {
  if (!el.value) return;
  handle = renderDonut(el.value, props.series, {
    labels: props.labels,
    colors: props.colors,
    totalLabel: props.totalLabel,
  });
});

watch(
  () => [props.series, props.labels, props.colors, props.totalLabel] as const,
  () => handle?.update(props.series, { labels: props.labels, colors: props.colors, totalLabel: props.totalLabel }),
  { deep: true }
);

onBeforeUnmount(() => handle?.destroy());
</script>

<template>
  <div ref="el" class="mini-chart-host"></div>
</template>
