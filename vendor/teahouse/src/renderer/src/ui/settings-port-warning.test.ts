import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const settingsSource = readFileSync(new URL('../SettingsApp.vue', import.meta.url), 'utf8')

describe('端口修改风险确认', () => {
  it('UDP 与 TCP 默认锁定并分别触发确认', () => {
    expect(settingsSource).toContain(":readonly=\"unlockedPort !== 'udp'\"")
    expect(settingsSource).toContain(":readonly=\"unlockedPort !== 'tcp'\"")
    expect(settingsSource).toContain("@focus=\"requestPortEdit('udp', $event)\"")
    expect(settingsSource).toContain("@focus=\"requestPortEdit('tcp', $event)\"")
    expect(settingsSource).toContain("@blur=\"finishPortEdit('udp')\"")
    expect(settingsSource).toContain("@blur=\"finishPortEdit('tcp')\"")
  })

  it('确认框说明影响并以取消作为安全默认', () => {
    expect(settingsSource).toContain('v-if="pendingPortEdit"')
    expect(settingsSource).toContain('role="dialog"')
    expect(settingsSource).toContain('aria-modal="true"')
    expect(settingsSource).toContain('@mousedown.self="cancelPortEdit"')
    expect(settingsSource).toContain('@keydown.esc.prevent.stop="cancelPortEdit"')
    expect(settingsSource).toContain('配置不一致可能导致联系人无法发现、消息或文件无法送达')
    expect(settingsSource).toContain('只有在你明确了解当前网络部署')
    expect(settingsSource).toContain("querySelector<HTMLButtonElement>(")
    expect(settingsSource).toContain("'.port-warning-actions button'")
    expect(settingsSource).toContain("<NButton secondary @click=\"cancelPortEdit\">{{ tr('取消') }}</NButton>")
    expect(settingsSource).toContain("<NButton type=\"error\" @click=\"confirmPortEdit\">{{ tr('确认修改') }}</NButton>")
  })

  it('确认后仅解锁当前端口并自动聚焦全选', () => {
    expect(settingsSource).toContain('unlockedPort.value = field')
    expect(settingsSource).toContain("field === 'udp' ? udpPortElement.value : tcpPortElement.value")
    expect(settingsSource).toContain('target?.focus()')
    expect(settingsSource).toContain('target?.select()')
    expect(settingsSource).toContain('await autoSavePorts()')
  })
})
