export class BoundedLruCache<K, V> {
  private readonly entries = new Map<K, V>()

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error('缓存容量必须是正整数')
    }
  }

  get size(): number {
    return this.entries.size
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined
    const value = this.entries.get(key) as V
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }
}

export class RetryableAsyncValue<T> {
  private pending: Promise<T> | null = null

  get(factory: () => Promise<T>): Promise<T> {
    if (this.pending) return this.pending

    let attempt: Promise<T>
    try {
      attempt = factory()
    } catch (error) {
      return Promise.reject(error)
    }

    const guarded = attempt.catch((error: unknown) => {
      if (this.pending === guarded) this.pending = null
      throw error
    })
    this.pending = guarded
    return guarded
  }
}
