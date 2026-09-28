// A session's browser as a person recognises it (ADR 0010): "Firefox ·
// Linux" rather than the header it was read from. Only the common families;
// anything else shows as recorded.

const BROWSERS: [RegExp, string][] = [
  [/Edg(A|iOS)?\//, 'Edge'],
  [/(OPR|Opera)\//, 'Opera'],
  [/(Firefox|FxiOS)\//, 'Firefox'],
  [/(Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/Version\/[\d.]+.*Safari\//, 'Safari']
]

const SYSTEMS: [RegExp, string][] = [
  [/Windows/, 'Windows'],
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux']
]

const first = (table: [RegExp, string][], value: string) => table.find(([pattern]) => pattern.test(value))?.[1]

export const describeUserAgent = (value: string | null | undefined): string | null => {
  if (!value) return null
  const browser = first(BROWSERS, value)
  const system = first(SYSTEMS, value)
  if (!browser && !system) return value
  return [browser, system].filter(Boolean).join(' · ')
}
