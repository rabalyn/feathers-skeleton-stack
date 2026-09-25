import type { Application } from '../app.js'
import { settings } from './settings/settings.js'
import { users } from './users/users.js'

export const services = (app: Application) => {
  app.configure(users)
  app.configure(settings)
}
