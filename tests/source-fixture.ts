import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const require = createRequire(import.meta.url)

export function sourceModule<T>(path: URL, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const code = transformSync(readFileSync(path, 'utf8'), {
    format: 'cjs', loader: 'ts', target: 'node24',
    define: { 'import.meta.url': JSON.stringify(path.href) },
  }).code
  const exports = {}
  const context = vm.createContext({
    module: { exports }, exports, console, URL, AbortController, AbortSignal, Response, Error, TypeError, process,
    require: (name: string) => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      if (name.startsWith('node:')) return require(name)
      throw new Error('Unexpected dependency: ' + name)
    },
    ...globals,
  })
  new vm.Script(code, { filename: path.pathname }).runInContext(context)
  return context.module.exports
}

export async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('The fixture did not reach its expected state.')
}
