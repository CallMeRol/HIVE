// port-probe 的 regression 测试：锁死「同步探测在 Node 16 会泄漏端口 + 谎报占用」这两条。
// bug 现场（#49 live）：GUI 用同步 listen+close 探端口，探测者把空闲端口占死在自己进程里，
// 后续成员节点 EADDRINUSE；而对真被占的端口，同步 try/catch 收不到异步 emit 的 bind 错误。
import { describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { createSocket } from 'node:dgram'
import { portTaken, tcpPortTaken, udpPortTaken } from './port-probe'

function listenServer(port: number): Promise<import('node:net').Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

describe('tcpPortTaken', () => {
  it('空闲端口报「未被占」，且探测后该端口仍可被他人绑定（不泄漏）', async () => {
    // 找一个当前空闲的端口：绑上再放掉，拿它当探针目标。
    const server = await listenServer(0)
    const port = (server.address() as { port: number }).port
    server.close()
    await new Promise((r) => setTimeout(r, 50))

    expect(await tcpPortTaken(port)).toBe(false)

    // regression 核心：探测者自己不能再持有该端口 —— 他人必须还能绑定。
    const later = await listenServer(port)
    later.close()
  })

  it('真被占的端口报「被占」（同步探测的第二个坑：异步 emit 的 bind 错误必须被收到）', async () => {
    const server = await listenServer(0)
    const port = (server.address() as { port: number }).port
    try {
      expect(await tcpPortTaken(port)).toBe(true)
    } finally {
      server.close()
    }
  })
})

describe('udpPortTaken', () => {
  it('空闲端口报「未被占」且不泄漏；被占端口报「被占」', async () => {
    const server = await listenServer(0)
    const port = (server.address() as { port: number }).port
    server.close()
    await new Promise((r) => setTimeout(r, 50))

    expect(await udpPortTaken(port)).toBe(false)

    // 探测不泄漏：他人能成功 bind 上来，且在它持有期间探测必须报「被占」。
    const holder = createSocket('udp4')
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject)
      holder.bind(port, '127.0.0.1', () => resolve())
    })
    try {
      expect(await udpPortTaken(port)).toBe(true)
    } finally {
      holder.close()
    }
  })
})

describe('portTaken', () => {
  it('非正端口直接视为未占；空闲与被占端口口径与单协议一致', async () => {
    expect(await portTaken(0)).toBe(false)
    expect(await portTaken(-1)).toBe(false)

    const server = await listenServer(0)
    const port = (server.address() as { port: number }).port
    try {
      expect(await portTaken(port)).toBe(true)
    } finally {
      server.close()
    }
  })
})
