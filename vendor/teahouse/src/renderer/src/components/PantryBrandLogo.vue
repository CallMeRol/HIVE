<script setup lang="ts">
import { tr } from '../utils/i18n'
import { computed } from 'vue'
import appIconUrl from '../assets/brand/hive-app-icon.png?url'

// Hive 品牌 logo（原决议 #107/#226 的位图复用机制不变）：
// 三个变体（icon / color / mono）统一复用美术交付的红色蜂巢方标位图。
// 单色场景（macOS 菜单栏 template）不走本组件，用 build/icons/hive-tray-mono.png 派生。
const props = withDefaults(
  defineProps<{
    variant?: 'icon' | 'color' | 'mono'
    size?: number
  }>(),
  {
    variant: 'color',
    size: 64
  }
)

const logoSrc = computed(() => appIconUrl)
</script>

<template>
  <img
    class="pantry-brand-logo"
    :class="`is-${props.variant}`"
    :src="logoSrc"
    :width="props.size"
    :height="props.size"
    :alt="tr('Hive logo')"
    draggable="false"
  />
</template>

<style scoped>
.pantry-brand-logo {
  display: block;
  flex-shrink: 0;
  object-fit: contain;
  user-select: none;
}
</style>
