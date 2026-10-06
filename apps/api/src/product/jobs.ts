import type { ProductQueue } from '../jobs/product-queues.js'

// The product's job queues (ADR 0024, 0035), each with its jobs and their
// schedules; the worker runs them beside the skeleton's, and the queue view
// lists them after the skeleton's. A service enqueues with a BullMQ Queue of
// the same name, as data-exports does.
export const PRODUCT_QUEUES: readonly ProductQueue[] = []
