// 展示用的数值格式化（决议 #281）。
// 收在一处的原因：文件卡、传输记录、设置页与文件柜面板原先各写一份，
// 同一个字节数在不同界面上会显示成「12 MB」和「12.3 MB」两种样子。

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/**
 * 字节数转人类可读文本。
 * 字节没有小数可言；其余单位下 ≥10 取整、<10 保留一位——
 * 既不让「1 MB」丢掉精度，也不让「1234.6 MB」这种长数字撑爆行宽。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1)
  return `${text} ${UNITS[unit]}`
}
