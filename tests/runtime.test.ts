import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { installRuntime as InstallRuntime } from '../src/installer/runtime.js'
import { sourceModule, until } from './source-fixture.js'
import { requestSignal } from '../src/installer/files.js'

test('cancelling the Minecraft task drains it and never writes a ready marker', async () => {
  let started = false, cancelled = false, markerWritten = false, markerRemoved = false
  let rejectTask: (error: Error) => void = () => {}
  const task = {
    startAndWait: () => new Promise((_resolve, reject) => { started = true; rejectTask = reject }),
    cancel: async () => { cancelled = true; rejectTask(new Error('Task cancelled')) },
  }
  const { installRuntime } = sourceModule<{ installRuntime: typeof InstallRuntime }>(new URL('../src/installer/runtime.ts', import.meta.url), {
    'node:fs/promises': { mkdir: async () => {}, rm: async () => { markerRemoved = true } },
    '@xmcl/core': { MinecraftFolder: class {}, Version: {} },
    '@xmcl/installer': { getVersionList: async () => ({ versions: [{ id: '26.1.2' }] }), installVersionTask: () => task },
    './files.js': { requestSignal, atomicJson: async () => { markerWritten = true } },
  })
  const controller = new AbortController()
  const installing = installRuntime('/in-memory-runtime', { version: '1.9.1', versionId: 'MYxEsI5B', minecraft: '26.1.2', fabric: '0.19.2', files: {} }, () => {}, controller.signal)
  const rejected = assert.rejects(installing, /cancelled/)
  await until(() => started)
  controller.abort()
  await rejected
  assert.equal(cancelled, true)
  assert.equal(markerRemoved, true)
  assert.equal(markerWritten, false)
})
