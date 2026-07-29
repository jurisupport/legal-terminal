import type { Client, SFTPWrapper } from 'ssh2'

export interface SshConnection {
  client: Client
  sftp: SFTPWrapper
}

export class SshConnectionPool {
  private readonly pool = new Map<string, SshConnection>()
  private readonly inflight = new Map<string, Promise<SshConnection>>()
  private readonly discarded = new WeakSet<SshConnection>()
  private readonly connect: (profileId: string) => Promise<SshConnection>
  private readonly maxConnections: number

  constructor(
    connect: (profileId: string) => Promise<SshConnection>,
    maxConnections: number
  ) {
    this.connect = connect
    this.maxConnections = maxConnections
  }

  async get(profileId: string): Promise<SshConnection> {
    const live = this.pool.get(profileId)
    if (live) return live

    const pending = this.inflight.get(profileId)
    if (pending) {
      try {
        return await pending
      } catch {
        return await this.getOrCreate(profileId)
      }
    }
    return await this.getOrCreate(profileId)
  }

  private getOrCreate(profileId: string): Promise<SshConnection> {
    const live = this.pool.get(profileId)
    if (live) return Promise.resolve(live)

    const pending = this.inflight.get(profileId)
    if (pending) return pending

    if (this.pool.size + this.inflight.size >= this.maxConnections) {
      const message = `원격 연결 상한(${this.maxConnections}) 초과`
      console.warn(`[remoteFs] ${message}`)
      return Promise.reject(new Error(message))
    }

    let attempt: Promise<SshConnection>
    attempt = this.connect(profileId)
      .then((connection) => {
        if (this.discarded.has(connection)) {
          throw new Error('SSH 연결이 준비 직후 종료되었습니다.')
        }
        const current = this.pool.get(profileId)
        if (current && current !== connection) {
          this.discard(profileId, connection)
          return current
        }
        this.pool.set(profileId, connection)
        return connection
      })
      .finally(() => {
        if (this.inflight.get(profileId) === attempt) this.inflight.delete(profileId)
      })
    this.inflight.set(profileId, attempt)
    return attempt
  }

  discard(profileId: string, connection: SshConnection): void {
    if (this.pool.get(profileId) === connection) this.pool.delete(profileId)
    if (this.discarded.has(connection)) return
    this.discarded.add(connection)
    try {
      connection.client.end()
    } catch {
      /* best effort */
    }
    const timer = setTimeout(() => {
      try {
        connection.client.destroy()
      } catch {
        /* best effort */
      }
    }, 3_000)
    timer.unref?.()
  }

  dispose(profileId?: string): void {
    const ids = profileId
      ? [profileId]
      : [...new Set([...this.pool.keys(), ...this.inflight.keys()])]
    for (const id of ids) {
      const live = this.pool.get(id)
      if (live) this.discard(id, live)
      this.inflight
        .get(id)
        ?.then((connection) => this.discard(id, connection))
        .catch(() => {})
    }
  }
}
