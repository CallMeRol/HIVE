import { ref } from 'vue'
import { getLanguage, isLanguage, setLanguage, tr as translate } from '../../../i18n'
import type { Language, TranslationParams } from '../../../shared/i18n'

export const language = ref<Language>('zh-CN')

export function tr(source: string, params?: TranslationParams): string {
  // 使模板、computed 与 Pinia getter 订阅语言变化。
  void language.value
  return translate(source, params)
}

export async function applyLanguage(next: unknown): Promise<void> {
  await setLanguage(isLanguage(next) ? next : 'zh-CN')
  language.value = getLanguage()
  document.documentElement.lang = language.value
}

export async function initLanguage(): Promise<void> {
  let updated = false
  let pending: Promise<void> | undefined
  const stop = window.pantry.onSettingsUpdated((settings) => {
    updated = true
    pending = applyLanguage(settings.language)
    void pending.catch(() => console.error('[i18n] 本地语言资源加载失败'))
  })
  window.addEventListener('unload', stop, { once: true })
  const settings = await window.pantry.getSettings()
  if (!updated) pending = applyLanguage(settings.language)
  await pending
}
