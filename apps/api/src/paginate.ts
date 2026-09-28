// ADR 0005: every find is paginated; no service may turn it off.
export const PAGINATE = { default: 25, max: 100 } as const
