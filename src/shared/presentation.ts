export function memoryLimits(totalMb: number) {
  const maxMemoryMb = Math.max(2048, Math.min(16384, Math.floor(totalMb) - 2048))
  const recommendedMemoryMb = Math.min(maxMemoryMb, Math.max(2048, Math.min(8192, Math.floor(totalMb / 2048) * 1024)))
  return { maxMemoryMb, recommendedMemoryMb }
}

export interface MemorySettings {
  memoryMode?: 'auto' | 'manual'
  memoryMb?: number
}

export function memorySelection(settings: MemorySettings, limits: ReturnType<typeof memoryLimits>) {
  if (settings.memoryMode === 'auto' || typeof settings.memoryMb !== 'number' || !Number.isInteger(settings.memoryMb) || settings.memoryMb < 2048) {
    return { memoryMode: 'auto' as const, memoryMb: limits.recommendedMemoryMb, preferredMemoryMb: undefined }
  }
  return { memoryMode: 'manual' as const, memoryMb: Math.min(settings.memoryMb, limits.maxMemoryMb), preferredMemoryMb: settings.memoryMb }
}

export function memoryOptions(maximum: number, current: number) {
  return [...new Set([2048, 4096, 6144, 8192, 12288, 16384, maximum, current])]
    .filter(value => value >= 2048 && value <= maximum).sort((a, b) => a - b)
}

export function plainReleaseNotes(markdown: string) {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 — $2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*```[^\n]*$/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n').trim()
}
