import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const secret = () => randomBytes(32).toString('base64url')
export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export interface Attempt { id: string; proof: string; state: string | null; browser: string | null; expires: number; status: string; result: string | null }
export interface Session { id: string; discord_id: string; name: string; tokens: string; expires: number; checked: number; created: number }

export class Store {
  db: DatabaseSync
  constructor(directory: string, private key: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(directory, 'launcher.sqlite'))
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
    this.db.exec('CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, proof TEXT NOT NULL, state TEXT, browser TEXT, expires INTEGER NOT NULL, status TEXT NOT NULL, result TEXT); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, discord_id TEXT NOT NULL, name TEXT NOT NULL, tokens TEXT NOT NULL, expires INTEGER NOT NULL, checked INTEGER NOT NULL, created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS channel (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);')
  }
  encrypt(value: unknown) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(this.key, 'hex'), iv)
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')
  }
  decrypt<T>(value: string): T {
    const data = Buffer.from(value, 'base64url')
    const cipher = createDecipheriv('aes-256-gcm', Buffer.from(this.key, 'hex'), data.subarray(0, 12))
    cipher.setAuthTag(data.subarray(12, 28))
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString())
  }
  attempt(id: string) { return this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id) as unknown as Attempt | undefined }
  session(token: string) { return this.db.prepare('SELECT * FROM sessions WHERE id=?').get(hash(token)) as unknown as Session | undefined }
  prune() {
    this.db.prepare('DELETE FROM attempts WHERE expires<?').run(Date.now())
    this.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now())
  }
}
