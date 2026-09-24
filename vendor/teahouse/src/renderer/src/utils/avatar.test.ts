import { describe, expect, it } from 'vitest'
import {
  AVATAR_COLORS,
  avatarColorIndex,
  avatarEmojiIndex,
  avatarStyle,
  avatarValue,
  initialAvatarValue,
  isInitialAvatar
} from './avatar'

describe('头像模板编号', () => {
  it('动物表情继续组合表情与背景颜色', () => {
    const value = avatarValue(19, 9)
    expect(value).toBe(199)
    expect(avatarEmojiIndex(value)).toBe(19)
    expect(avatarColorIndex(value)).toBe(9)
    expect(isInitialAvatar(value)).toBe(false)
  })

  it('昵称首字使用 200..209 保存显式背景颜色', () => {
    for (let index = 0; index < AVATAR_COLORS.length; index++) {
      const value = initialAvatarValue(index)
      expect(value).toBe(200 + index)
      expect(isInitialAvatar(value)).toBe(true)
      expect(avatarEmojiIndex(value)).toBe(-1)
      expect(avatarColorIndex(value, '张三')).toBe(index)
      expect(avatarStyle(value, '张三').backgroundColor).toBe(AVATAR_COLORS[index].bg)
    }
  })

  it('旧昵称首字编号继续按昵称计算背景颜色', () => {
    expect(isInitialAvatar(-1)).toBe(true)
    expect(avatarEmojiIndex(-1)).toBe(-1)
    expect(avatarColorIndex(-1, '张三')).toBe(9)
  })
})
