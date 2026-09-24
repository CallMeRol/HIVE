// 打包态路径解析（#25 修 #62 的发布验收缺口）。
//
// asar 归档对 Electron 主进程是**透明**的（它的 fs 被 patch 过，`app.asar/…` 读得到），
// 但对**真 node 子进程**完全不透明：`node /…/Resources/app.asar/out/main/acp/runner.mjs`
// 只会拿到 ENOENT —— 归档是文件，不是目录。ADR-0004 又要求 runner 必须跑在系统 node ≥22
// 子进程里（Electron 22 内嵌的是 Node 16.17），所以凡是要交给子进程、或当 spawn 的 cwd
// 用的路径，都得先落到 `app.asar.unpacked/` 里（打包配置见 package.json 的 build.asarUnpack）。
import { dirname, sep } from 'node:path'

/** asar 归档的文件名：打包态 `app.getAppPath()` 就指到它本身。 */
export const ASAR_FILE = 'app.asar'

// 带分隔符的片段而非裸文件名：`…/app.asar.unpacked/…` 含 `app.asar` 子串，
// 裸 replace 会把它改成 `app.asar.unpacked.unpacked`。
const ASAR_MARK = `${sep}${ASAR_FILE}${sep}`
const UNPACKED_MARK = `${sep}${ASAR_FILE}.unpacked${sep}`

/** 路径是否落在 asar **归档内**（`app.asar.unpacked/` 里的不算）。 */
export function isInsideAsar(target: string): boolean {
  return target.includes(ASAR_MARK)
}

/**
 * 把 asar 内的路径映射到 `app.asar.unpacked/` 里的对应位置。
 * 非 asar 路径（dev 源码树、userData、系统 node…）原样返回——本函数只做这一段映射。
 */
export function unpackedPath(target: string): string {
  return isInsideAsar(target) ? target.replace(ASAR_MARK, UNPACKED_MARK) : target
}

/**
 * 可以当 cwd 传给子进程的应用目录。
 *
 * 打包态 `app.getAppPath()` = `…/Resources/app.asar`（**文件**）→ `spawn(exe, args, {cwd})`
 * 直接 ENOTDIR（已实测），派遣/接入起的成员节点会全部起不来；dev 态它本来就是源码树目录。
 */
export function appCwdDir(options: { isPackaged: boolean; appPath: string }): string {
  return options.isPackaged ? dirname(options.appPath) : options.appPath
}
