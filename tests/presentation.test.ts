import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryLimits, memoryOptions, memorySelection, plainReleaseNotes } from '../src/shared/presentation.js'
import { minecraftProfile, MinecraftLoginError } from '../src/shared/minecraft.js'

test('memory choices reserve system RAM and retain a valid current selection', () => {
  const limits = memoryLimits(8192)
  assert.deepEqual(limits, { maxMemoryMb: 6144, recommendedMemoryMb: 4096 })
  assert.deepEqual(memoryOptions(limits.maxMemoryMb, 4096), [2048, 4096, 6144])
  assert.deepEqual(memoryOptions(5000, 3000), [2048, 3000, 4096, 5000])
  assert.equal(memoryLimits(4096).recommendedMemoryMb, 2048)
  assert.equal(memoryLimits(65536).maxMemoryMb, 16384)
})

test('automatic RAM adapts to physical memory with a conservative ceiling', () => {
  for (const [physical, recommended, maximum] of [
    [4096, 2048, 2048], [6144, 3072, 4096], [8192, 4096, 6144],
    [12288, 6144, 10240], [16384, 8192, 14336], [32768, 8192, 16384], [65536, 8192, 16384],
    [10239.9, 4096, 8191],
  ]) {
    const limits = memoryLimits(physical)
    assert.deepEqual(limits, { maxMemoryMb: maximum, recommendedMemoryMb: recommended })
    assert.equal(memorySelection({}, limits).memoryMb, recommended)
    assert.equal(memorySelection({ memoryMode: 'auto', memoryMb: 4096 }, limits).memoryMb, recommended)
    assert.ok(recommended <= maximum)
  }
})

test('legacy and explicit manual preferences are preserved, not inferred from their value', () => {
  const limits = memoryLimits(16384)
  assert.deepEqual(memorySelection({}, limits), { memoryMode: 'auto', memoryMb: 8192, preferredMemoryMb: undefined })
  for (const memoryMb of [4096, 6144]) {
    assert.deepEqual(memorySelection({ memoryMb }, limits), { memoryMode: 'manual', memoryMb, preferredMemoryMb: memoryMb })
    assert.deepEqual(memorySelection({ memoryMode: 'manual', memoryMb }, limits), { memoryMode: 'manual', memoryMb, preferredMemoryMb: memoryMb })
  }
  const preference = { memoryMb: 12288 }
  assert.deepEqual(memorySelection(preference, memoryLimits(8192)), { memoryMode: 'manual', memoryMb: 6144, preferredMemoryMb: 12288 })
  assert.deepEqual(preference, { memoryMb: 12288 })
  assert.equal(memorySelection(preference, memoryLimits(32768)).memoryMb, 12288)
})

test('release notes are readable plain text, never generated HTML', () => {
  assert.equal(plainReleaseNotes('## Nouveautés\n\n- **Java** et `Fabric`\n[Notes](https://example.test/notes)\n<!-- hidden -->'),
    'Nouveautés\n\n- Java et Fabric\nNotes — https://example.test/notes')
  assert.equal(plainReleaseNotes('![Image](https://example.test/a.png)'), 'Image')
  assert.equal(plainReleaseNotes('<script>example</script>'), '<script>example</script>')
})

test('the Microsoft diagnostic rejects every failed or invalid Java profile', async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    await assert.rejects(minecraftProfile(new Response('', { status })), MinecraftLoginError)
  }
  await assert.rejects(minecraftProfile(Response.json({ id: 'invalid', name: 'Test' })), /profil invalide/)
  await assert.rejects(minecraftProfile(new Response('', { status: 404 })), error => error instanceof MinecraftLoginError && error.reconnect)
  assert.deepEqual(await minecraftProfile(Response.json({ id: 'a'.repeat(32), name: 'Test' })), { id: 'a'.repeat(32), name: 'Test' })
})
