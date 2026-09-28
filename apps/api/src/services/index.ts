import type { Application } from '../app.js'
import { auditEvents } from './audit-events/audit-events.js'
import { dataExports } from './data-exports/data-exports.js'
import { directory } from './directory/directory.js'
import { erasures } from './erasures/erasures.js'
import { documents } from './documents/documents.js'
import { files } from './files/files.js'
import { settings } from './settings/settings.js'
import { avatars } from './users/avatars.js'
import { locales } from './users/locales.js'
import { mailCampaigns } from './mail/mail-campaigns.js'
import { mailDeliveries } from './mail/mail-deliveries.js'
import { mailTemplates } from './mail/mail-templates.js'
import { users } from './users/users.js'

export const services = (app: Application) => {
  app.configure(users)
  app.configure(settings)
  app.configure(directory)
  app.configure(files)
  app.configure(avatars)
  app.configure(locales)
  app.configure(documents)
  app.configure(dataExports)
  app.configure(erasures)
  app.configure(auditEvents)
  app.configure(mailTemplates)
  app.configure(mailCampaigns)
  app.configure(mailDeliveries)
}
