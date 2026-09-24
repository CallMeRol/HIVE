// 图片消息相关常量：main / renderer 共用，避免各层各自维护白名单。

export const IMAGE_FILE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'] as const

export const DEFAULT_IMAGE_EXTENSION = '.png'

/** 内联预览像素门禁（决议 #234）：兼顾 4K/多屏截图与 Win7/UOS 解码内存。 */
export const IMAGE_INLINE_MAX_EDGE = 8192
export const IMAGE_INLINE_MAX_PIXELS = 32_000_000

/** 聊天流与记录搜索共用的派生缩略图规格。 */
export const IMAGE_THUMBNAIL_MAX_EDGE = 320
export const IMAGE_THUMBNAIL_MAX_BYTES = 1024 * 1024
export const IMAGE_THUMBNAIL_CACHE_MAX_BYTES = 128 * 1024 * 1024
