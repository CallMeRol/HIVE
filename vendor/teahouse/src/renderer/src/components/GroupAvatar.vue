<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { avatarImageUrl } from '../../../shared/avatar-url'
import { useAvatarsStore } from '../stores/avatars'
import PantryIcon from './PantryIcon.vue'

const props = withDefaults(defineProps<{ avatarHash?: string; iconSize?: number }>(), {
  iconSize: 18
})
const avatarsStore = useAvatarsStore()
avatarsStore.init()
const failedKey = ref('')
const version = computed(() => avatarsStore.versionOf(props.avatarHash ?? ''))
const imageKey = computed(() => `${props.avatarHash ?? ''}:${version.value}`)
const src = computed(() => avatarImageUrl(props.avatarHash ?? '', version.value))
const showImage = computed(() => Boolean(src.value) && failedKey.value !== imageKey.value)

watch(imageKey, () => {
  failedKey.value = ''
})
</script>

<template>
  <span class="group-avatar">
    <img
      v-if="showImage"
      :key="imageKey"
      :src="src"
      alt=""
      draggable="false"
      decoding="async"
      @error="failedKey = imageKey"
    />
    <PantryIcon v-else name="users" :size="iconSize" />
  </span>
</template>

<style scoped>
.group-avatar {
  display: inline-grid;
  place-items: center;
  overflow: hidden;
  border-radius: 50%;
  background: var(--primary-weak);
  color: var(--primary);
}

.group-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
