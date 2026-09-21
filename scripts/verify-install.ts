import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { generateArguments } from '@xmcl/core'
import { publishedRelease } from '../src/server/modrinth.js'
import { installPack } from '../src/installer/pack.js'
import { installRuntime } from '../src/installer/runtime.js'
const root = resolve('data/smoke-install')
const release = await publishedRelease('1.9.1')
let previous = ''
const report = (message: string) => { if (message !== previous) { console.log(message); previous = message } }
const installed = await installPack(root, release, report)
const runtime = await installRuntime(root, installed, report)
const java = await promisify(execFile)(runtime.javaPath, ['-version'])
const args = await generateArguments({ ...runtime, gamePath: resolve(root, 'instance'), gameProfile: { name: 'InstallationTest', id: '0'.repeat(32) }, accessToken: 'installation-test-not-a-real-token', features: { fbd_authentication: { clientid: '00000000-0000-0000-0000-000000000000', auth_xuid: '0' } }, maxMemory: 4096 })
if (args.some(arg => /\$\{/.test(arg))) throw new Error('Arguments Minecraft non résolus.')
console.log(JSON.stringify({ version: installed.version, minecraft: installed.minecraft, fabric: installed.fabric, profile: runtime.version.id, java: java.stderr.trim(), launchArgumentsValidated: true, root }, null, 2))
