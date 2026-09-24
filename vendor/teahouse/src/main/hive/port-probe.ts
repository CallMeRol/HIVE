// 端口实占探测（#49 接入编排的避让依据）。
//
// 为什么必须是异步事件语义（regression：#49 live 实测的端口级联污染）：
//   1. `listen()`/`bind()` 的失败（EADDRINUSE）是**异步 emit** 的，任何 Node 版本的同步
//      try/catch 都收不到 → 同步探测对「已被占」永远谎报「空闲」；
//   2. 「listen 后立刻 close」在 Node 16（Electron 22 焊死的运行时）会留下完成中的 handle，
//      探测者把空闲端口占死在自己进程里 → 成员节点必 EADDRINUSE，级联污染。
// 两条都在 `port-probe.test.ts` 锁死。
import { createServer as createNetServer } from 'node:net'
import { createSocket as createUdpSocket } from 'node:dgram'

/**
 * TCP 端口是否被占。`listening` = 空闲，`error` = 被占。
 */
export async function tcpPortTaken(port: number): Promise<boolean> {
  return new Promise((resolveTake) => {
    const server = createNetServer()
    const settle = (taken: boolean) => {
      try {
        server.close()
      } catch {
        /* 未监听成功就无需关闭 */
      }
      resolveTake(taken)
    }
    server.once('error', () => resolveTake(true))
    server.listen(port, '127.0.0.1', () => settle(false))
  })
}

/** UDP 端口是否被占（同 tcpPortTaken 的口径与理由：必须等事件，不能同步猜）。 */
export async function udpPortTaken(port: number): Promise<boolean> {
  return new Promise((resolveTake) => {
    const socket = createUdpSocket('udp4')
    const settle = (taken: boolean) => {
      try {
        socket.close()
      } catch {
        /* 未绑定成功就无需关闭 */
      }
      resolveTake(taken)
    }
    socket.once('error', (err) => {
      // EADDRINUSE/EACCES = 被占；settle 后 close 触发的 err 属探测已结束，忽略。
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') settle(true)
    })
    socket.bind(port, '127.0.0.1', () => settle(false))
  })
}

/** 端口是否已被本机某个进程占用（接入前避让，别硬上）。 */
export async function portTaken(port: number): Promise<boolean> {
  if (port <= 0) return false
  try {
    // UDP 与 TCP 都试：底座同时开两种端口，任一被占都不该复用。
    return (await udpPortTaken(port)) || (await tcpPortTaken(port))
  } catch {
    return false
  }
}
