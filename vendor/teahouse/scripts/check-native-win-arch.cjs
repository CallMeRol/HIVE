const { readFileSync } = require('node:fs')

const PE_MACHINE = {
  ia32: 0x014c,
  x64: 0x8664
}

function readPeMachine(filePath) {
  const data = readFileSync(filePath)
  if (data.length < 0x40 || data.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`${filePath} 不是有效的 PE 文件`)
  }

  const peOffset = data.readUInt32LE(0x3c)
  if (peOffset + 6 > data.length || data.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error(`${filePath} 缺少有效的 PE 签名`)
  }
  return data.readUInt16LE(peOffset + 4)
}

function checkNativeWinArch(filePath, expectedArch) {
  const expectedMachine = PE_MACHINE[expectedArch]
  if (expectedMachine === undefined) {
    throw new Error(`不支持的 Windows 架构：${expectedArch}`)
  }
  const actualMachine = readPeMachine(filePath)
  if (actualMachine !== expectedMachine) {
    throw new Error(
      `${filePath} 架构不匹配：期望 ${expectedArch} (0x${expectedMachine.toString(16)})，实际 0x${actualMachine.toString(16)}`
    )
  }
  console.log(`Windows native 模块架构校验通过：${expectedArch}`)
}

if (require.main === module) {
  const [, , filePath, expectedArch] = process.argv
  if (!filePath || !expectedArch) {
    console.error('用法：node scripts/check-native-win-arch.cjs <better_sqlite3.node> <x64|ia32>')
    process.exit(2)
  }
  checkNativeWinArch(filePath, expectedArch)
}

module.exports = { checkNativeWinArch, readPeMachine }
