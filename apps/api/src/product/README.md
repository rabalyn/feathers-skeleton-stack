# The product module (ADR 0035)

A product derived from the skeleton registers its own code in these files and
leaves the skeleton's files alone, so that merging a skeleton version does
not conflict with it. The skeleton ships each file empty and does not change
it after `skeleton-v1.0.0`; a change to their shape is a MAJOR version.

| File | What a product adds there | ADR |
| --- | --- | --- |
| `services.ts` | its services (written by `pnpm gen:service`) | 0030 |
| `client.ts` | its services' types for the browser (written by `pnpm gen:service`) | 0007 |
| `permissions.ts` | its permissions, and those an API token may not carry | 0011, 0029 |
| `personal-data.ts` | its tables holding personal data; erasure goes into `erase_user_product()` | 0013 |
| `mail.ts` | its mail kinds | 0027 |
| `settings.ts` | its runtime settings | 0025 |
| `preferences.ts` | its personal preference keys | 0014 |
| `jobs.ts` | its job queues, their jobs and schedules | 0024 |

The web app has the same in `apps/web/src/product/` and
`apps/web/src/i18n/product/`. In the skeleton repository itself these files
stay empty; `pnpm gen:service` writes to the skeleton's own files there.
