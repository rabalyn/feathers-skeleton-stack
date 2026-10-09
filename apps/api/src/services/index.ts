import type { Application } from '../app.js'
import { apiTokens } from './api-tokens/api-tokens.js'
import { auditEvents } from './audit-events/audit-events.js'
import { dataExports } from './data-exports/data-exports.js'
import { directory } from './directory/directory.js'
import { directoryLookups } from './directory/directory-lookups.js'
import { erasures } from './erasures/erasures.js'
import { documents } from './documents/documents.js'
import { files } from './files/files.js'
import { sessions } from './sessions/sessions.js'
import { settings } from './settings/settings.js'
import { avatars } from './users/avatars.js'
import { locales } from './users/locales.js'
import { mailCampaigns } from './mail/mail-campaigns.js'
import { mailDeliveries } from './mail/mail-deliveries.js'
import { mailTemplates } from './mail/mail-templates.js'
import { queues } from './queues/queues.js'
import { roles } from './roles/roles.js'
import { userRoles } from './roles/user-roles.js'
import { viewAs } from './view-as/view-as.js'
import { users } from './users/users.js'
import { sites } from './sites/sites.js'
import { systemInfo } from './system-info/system-info.js'
import { updateChecks } from './update-checks/update-checks.js'
import { preferences } from './preferences/preferences.js'
import { docs } from './docs/docs.js'
import { PRODUCT_SERVICES } from '../product/services.js'
import { locations } from './locations/locations.js'
// gen:service imports (ADR 0030)

export const services = (app: Application) => {
  app.configure(users)
  app.configure(roles)
  app.configure(userRoles)
  app.configure(viewAs)
  app.configure(settings)
  app.configure(directory)
  app.configure(directoryLookups)
  app.configure(files)
  app.configure(avatars)
  app.configure(locales)
  app.configure(documents)
  app.configure(dataExports)
  app.configure(erasures)
  app.configure(auditEvents)
  app.configure(sessions)
  app.configure(apiTokens)
  app.configure(mailTemplates)
  app.configure(mailCampaigns)
  app.configure(mailDeliveries)
  app.configure(queues)
  app.configure(sites)
  app.configure(systemInfo)
  app.configure(updateChecks)
  app.configure(preferences)
  app.configure(docs)
  app.configure(locations)
  // gen:service configure (ADR 0030)
  // The product's, after the skeleton's (ADR 0035).
  for (const service of PRODUCT_SERVICES) app.configure(service)
}
