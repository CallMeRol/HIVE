import { describe, expect, it, vi } from 'vitest'
import { createCaptureInitReplay } from './capture-init-replay'

describe('截图初始化事件回放', () => {
  it('初始化先到达时，稍后订阅仍能立即收到最近数据', () => {
    const replay = createCaptureInitReplay()
    const listener = vi.fn()

    const bytes = new Uint8Array([1, 2, 3]).buffer
    replay.publish(bytes)
    replay.subscribe(listener)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(bytes)
  })

  it('订阅先建立时，初始化按正常时序送达', () => {
    const replay = createCaptureInitReplay()
    const listener = vi.fn()

    replay.subscribe(listener)
    const bytes = new Uint8Array([4, 5, 6]).buffer
    replay.publish(bytes)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(bytes)
  })

  it('退订后不再接收后续初始化', () => {
    const replay = createCaptureInitReplay()
    const listener = vi.fn()
    const unsubscribe = replay.subscribe(listener)

    unsubscribe()
    replay.publish(new Uint8Array([7]).buffer)

    expect(listener).not.toHaveBeenCalled()
  })
})
