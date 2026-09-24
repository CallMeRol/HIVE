<script setup lang="ts">
import { computed } from 'vue'
import fileTypeAtlasUrl from '../assets/file-types/file-type-atlas.png?url'

// 彩色文件类型图标（决议 #75/#228）：按扩展名映射到本地 4×4 PNG atlas。
// 属“内容标识”，是单色系统控件图标基线（ui-design §10）的明示例外。

const props = withDefaults(defineProps<{ name: string; dir?: boolean; size?: number }>(), {
  dir: false,
  size: 32
})

type FileType =
  | 'word'
  | 'excel'
  | 'ppt'
  | 'pdf'
  | 'archive'
  | 'image'
  | 'audio'
  | 'video'
  | 'text'
  | 'code'
  | 'app'
  | 'generic'
  | 'folder'

const EXT_TYPE: Record<string, FileType> = {
  doc: 'word', docx: 'word', rtf: 'word', odt: 'word', wps: 'word',
  xls: 'excel', xlsx: 'excel', csv: 'excel', ods: 'excel', et: 'excel',
  ppt: 'ppt', pptx: 'ppt', odp: 'ppt', dps: 'ppt',
  pdf: 'pdf',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', bz2: 'archive', xz: 'archive',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', bmp: 'image', webp: 'image', svg: 'image', heic: 'image', tiff: 'image', ico: 'image',
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', m4a: 'audio', wma: 'audio',
  mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video', flv: 'video', wmv: 'video', m4v: 'video',
  txt: 'text', md: 'text', log: 'text', ini: 'text', conf: 'text',
  js: 'code', mjs: 'code', ts: 'code', jsx: 'code', tsx: 'code', vue: 'code', py: 'code', java: 'code', c: 'code', cpp: 'code', h: 'code', cs: 'code', go: 'code', rs: 'code', rb: 'code', php: 'code', html: 'code', css: 'code', json: 'code', xml: 'code', yml: 'code', yaml: 'code', sh: 'code', sql: 'code',
  exe: 'app', msi: 'app', dmg: 'app', deb: 'app', rpm: 'app', apk: 'app', pkg: 'app', appimage: 'app'
}

const ATLAS_POS: Record<FileType, readonly [column: number, row: number]> = {
  word: [0, 0],
  excel: [1, 0],
  ppt: [2, 0],
  pdf: [3, 0],
  archive: [0, 1],
  image: [1, 1],
  audio: [2, 1],
  video: [3, 1],
  text: [0, 2],
  code: [1, 2],
  app: [2, 2],
  generic: [3, 2],
  folder: [0, 3]
}

const ext = computed(() => {
  const m = /\.([a-z0-9]+)$/i.exec(props.name.trim())
  return m ? m[1].toLowerCase() : ''
})
const type = computed<FileType>(() => {
  if (props.dir) return 'folder'
  return EXT_TYPE[ext.value] ?? 'generic'
})
const spriteStyle = computed(() => {
  const [column, row] = ATLAS_POS[type.value]
  const size = props.size
  return {
    width: `${size}px`,
    height: `${size}px`,
    backgroundImage: `url("${fileTypeAtlasUrl}")`,
    backgroundSize: `${size * 4}px ${size * 4}px`,
    backgroundPosition: `${-column * size}px ${-row * size}px`
  }
})
</script>

<template>
  <span class="file-type-icon" :style="spriteStyle" aria-hidden="true"></span>
</template>

<style scoped>
.file-type-icon {
  display: block;
  flex-shrink: 0;
  background-repeat: no-repeat;
  image-rendering: auto;
}
</style>
