# Branding

The place for the logos of TU Darmstadt and of its Hochschulrechenzentrum
(HRZ), as the HRZ hands them out, unchanged (ADR 0035). **The skeleton
ships none**: it is public, and the logos may not be published with it. A
product puts the files here, in its own private repository:

| File | What |
| --- | --- |
| `TU-Logo_NEU_Print_mit-Schutzraum.png` | TU Darmstadt, for print, with the protective margin |
| `TU-Logo_Web_ohne-Schutzraum.png` | TU Darmstadt, for screens, without it |
| `HRZ-Logo_NEU_Print_mit-Schutzraum.png` | HRZ, for print, with the protective margin |
| `HRZ-Logo_NEU_Web_mit-Schutzraum.png` | HRZ, for screens, with it |
| `HRZ-Logo_NEU_Web_ohne-Schutzraum.png` | HRZ, for screens, without it, on transparent |

The originals are several thousand pixels wide and are not shipped. What
an image serves or embeds is a copy scaled to its use:

- `apps/api/assets/branding/`, for the api's PDFs, named by
  `apps/api/src/branding.ts`:

  ```bash
  magick branding/TU-Logo_Web_ohne-Schutzraum.png -resize 1200x -strip PNG24:apps/api/assets/branding/tu-darmstadt.png
  magick branding/HRZ-Logo_NEU_Web_ohne-Schutzraum.png -resize 1000x -strip PNG32:apps/api/assets/branding/hrz.png
  ```

A logo that is missing is left out of what the api prints. The logos' use
follows the university's corporate design rules.
