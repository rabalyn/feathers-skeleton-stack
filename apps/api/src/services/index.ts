import type { Application } from '../app.js'
import { directory } from './directory/directory.js'
import { settings } from './settings/settings.js'
import { users } from './users/users.js'

export const services = (app: Application) => {
  app.configure(users)
  app.configure(settings)
  app.configure(directory)
}
