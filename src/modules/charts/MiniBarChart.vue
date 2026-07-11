<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { renderBars, type ChartHandle, type BarOptions, type BarSeriesInput } from './mini-charts';

const props = defineProps<{
  categories: string[];
  series: BarSeriesInput[];
  stacked?: boolean;
  height?: number;
  zoomable?: boolean;
}>();

const el = ref<HTMLDivElement | null>(null);
let handle: ChartHandle<BarOptions, BarOptions> | null = null;

const currentOpts = (): BarOptions => ({
  categories: props.categories,
  series: props.series,
  stacked: props.stacked,
  height: props.height,
  zoomable: props.zoomable,
});

onMounted(() => {
  if (!el.value) return;
  handle = renderBars(el.value, currentOpts());
});

watch(
  () => [props.categories, props.series, props.stacked, props.height, props.zoomable] as const,
  () => handle?.update(currentOpts()),
  { deep: true }
);

onBeforeUnmount(() => handle?.destroy());
</script>

<template>
  <div ref="el" class="mini-chart-host"></div>
</template>
