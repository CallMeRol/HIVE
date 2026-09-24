import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadAppState, saveProfile, saveProfileCaps, type ProfilePatch } from './app-state'

const directories: string[] = []

function makeState() {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-profile-'))
  directories.push(directory)
  return loadAppState(directory, '0.0.0-test')
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('资料版本与持久化', () => {
  it('能力变化持久化递增版本，保留向导状态，重启后继续递增', () => {
    const state = makeState()
    expect(saveProfileCaps(state, ['rv1', 'rvs1'])).toBe(true)
    expect(state.profile.profileRev).toBe(2)
    expect(state.config.setupDone).toBe(false)
    const saved = readFileSync(state.configPath, 'utf8')
    expect(JSON.parse(saved)).toMatchObject({ profileRev: 2, setupDone: false })
    expect(saveProfileCaps(state, ['rv1', 'rvs1'])).toBe(false)
    expect(readFileSync(state.configPath, 'utf8')).toBe(saved)

    saveProfile(state, { ...state.config, company: '新公司' })
    expect(state.profile).toMatchObject({ company: '新公司', profileRev: 3, caps: ['rv1', 'rvs1'] })
    const reloaded = loadAppState(directories[0], '0.0.0-test')
    expect(reloaded.profile.profileRev).toBe(3)
    expect(saveProfileCaps(reloaded, ['rv1'])).toBe(true)
    expect(reloaded.profile.profileRev).toBe(4)
    expect(JSON.parse(readFileSync(reloaded.configPath, 'utf8')).profileRev).toBe(4)
  })

  it.each<Partial<ProfilePatch>>([
    { company: '新公司' }, { dept: '新部门' }, { team: '新团队' },
    { avatar: 3 }, { avatarHash: 'a'.repeat(64) }, { nick: '新昵称' }
  ])('运行中版本领先时，独立修改 %j 仍递增并保存', (patch) => {
    const state = makeState()
    const liveProfile = state.profile
    // 复现旧版能力更新仅推进运行中版本的状态。
    state.profile.profileRev += 2
    const previousRev = state.profile.profileRev

    saveProfile(state, { ...state.config, ...patch })

    expect(state.profile).toBe(liveProfile)
    expect(state.profile).toMatchObject({ ...patch, profileRev: previousRev + 1 })
    expect(JSON.parse(readFileSync(state.configPath, 'utf8')).profileRev).toBe(previousRev + 1)
    expect(loadAppState(directories[0], '0.0.0-test').profile).toMatchObject(state.profile)
  })

  it('只改保存目录或重复保存时保留运行中版本，不回退也不额外递增', () => {
    const state = makeState()
    state.profile.profileRev += 2
    const previousRev = state.profile.profileRev
    saveProfile(state, { ...state.config, fileDir: '/tmp/profile-files' })
    saveProfile(state, { ...state.config })
    expect(state.profile.profileRev).toBe(previousRev)
    expect(state.config.profileRev).toBe(previousRev)
    expect(JSON.parse(readFileSync(state.configPath, 'utf8')).profileRev).toBe(previousRev)
  })
})
