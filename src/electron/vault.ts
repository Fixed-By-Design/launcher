import { safeStorage } from 'electron'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export class Vault {
  constructor(private directory: string) {}
  async get(key: string): Promise<string | undefined> {
    try {
      const value = await readFile(join(this.directory, key))
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Le stockage sécurisé du système est indisponible.')
      return safeStorage.decryptString(value)
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async set(key: string, value: string) {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('Le stockage sécurisé du système est indisponible.')
    const path = join(this.directory, key)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path + '.tmp', safeStorage.encryptString(value), { mode: 0o600 })
    await rename(path + '.tmp', path)
  }
  async delete(key: string) { await rm(join(this.directory, key), { force: true }) }
}
