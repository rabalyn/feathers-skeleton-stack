import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The university's and the HRZ's logos (ADR 0035), for what the api prints:
// copies of the originals in branding/, scaled down for print, so that a
// PDF embedding one stays small. Beside src/ and dist/ alike, and copied
// into the api image. The skeleton ships none, being public; a product
// adds the files, and a logo that is missing is null and left out.
const asset = (name: string) => {
  const path = fileURLToPath(new URL(`../assets/branding/${name}`, import.meta.url))
  return existsSync(path) ? path : null
}

export const LOGOS = {
  // TU Darmstadt, black on white, without the protective margin; 1200 px wide.
  tuDarmstadt: asset('tu-darmstadt.png'),
  // Hochschulrechenzentrum, blue on transparent, without the protective
  // margin; 1000 px wide.
  hrz: asset('hrz.png')
} as const
