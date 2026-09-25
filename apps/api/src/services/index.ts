import type { Application } from '../app.js'
import { users } from './users/users.js'

export const services = (app: Application) => {
  app.configure(users)
}
