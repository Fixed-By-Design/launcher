import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { download, exists } from '../src/installer/files.js'
import { concurrent, runtimeReady } from '../src/installer/runtime.js'
import type { Installed } from '../src/installer/pack.js'

test('download verifies hashes and never commits a corrupted or oversized payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fbd-download-'))
  const original = globalThis.fetch
  let calls = 0
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls++
      const response = new Response('good payload')
      Object.defineProperty(response, 'url', { value: String(input) })
      return response
    }) as typeof fetch
    const hash = createHash('sha512').update('good payload').digest('hex')
    const path = join(root, 'cached')
    await assert.rejects(download('https://cdn.modrinth.com/test', path, 'a'.repeat(128)), /empreinte/)
    assert.equal(await exists(path), false)
    assert.equal(await exists(path + '.part'), false)
    await assert.rejects(download('https://cdn.modrinth.com/test', path, hash, 'sha512', 2), /volumineux/)
    assert.equal(await exists(path), false)
    await download('https://cdn.modrinth.com/test', path, hash)
    assert.equal(await readFile(path, 'utf8'), 'good payload')
    const before = calls
    await download('https://cdn.modrinth.com/test', path, hash)
    assert.equal(calls, before)
  } finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }) }
})

test('Minecraft transfer queue stays bounded and waits for in-flight work on failure', async () => {
  let active = 0, maximum = 0, completed = 0
  await concurrent(Array.from({ length: 35 }, (_, index) => index), async () => {
    active++; maximum = Math.max(maximum, active)
    await delay(2)
    active--; completed++
  }, 4)
  assert.equal(maximum, 4)
  assert.equal(completed, 35)
  await assert.rejects(concurrent([1, 2, 3, 4], async item => {
    active++
    try { await delay(2); if (item === 1) throw new Error('network failure') }
    finally { active-- }
  }, 2), /network failure/)
  assert.equal(active, 0)
})

test('cancelling a transfer removes its partial file and preserves the existing file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fbd-cancel-download-'))
  const original = globalThis.fetch
  const controller = new AbortController()
  const path = join(root, 'cached')
  try {
    await writeFile(path, 'original')
    globalThis.fetch = (async () => {
      const response = new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('partial')) } }))
      Object.defineProperty(response, 'url', { value: 'https://cdn.modrinth.com/test' })
      return response
    }) as typeof fetch
    const transfer = download('https://cdn.modrinth.com/test', path, 'a'.repeat(128), 'sha512', 1024, controller.signal)
    const rejected = assert.rejects(transfer, /abort/i)
    for (let i = 0; i < 100 && !await exists(path + '.part'); i++) await delay(2)
    assert.equal(await exists(path + '.part'), true)
    controller.abort()
    await rejected
    assert.equal(await exists(path + '.part'), false)
    assert.equal(await readFile(path, 'utf8'), 'original')
  } finally { controller.abort(); globalThis.fetch = original; await rm(root, { recursive: true, force: true }) }
})

test('a pack version alone is not a ready runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fbd-runtime-ready-'))
  const pack: Installed = { version: '1.9.1', versionId: 'MYxEsI5B', minecraft: '26.1.2', fabric: '0.19.2', files: {} }
  const javaPath = join(root, 'java-test')
  try {
    assert.equal(await runtimeReady(root, pack), false)
    await writeFile(join(root, 'runtime-ready.json'), JSON.stringify({ versionId: pack.versionId, javaPath }))
    assert.equal(await runtimeReady(root, pack), false)
    await writeFile(javaPath, 'test')
    assert.equal(await runtimeReady(root, pack), true)
    assert.equal(await runtimeReady(root, { ...pack, versionId: 'NEWPACK1' }), false)
    assert.equal(await runtimeReady(root, null), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
