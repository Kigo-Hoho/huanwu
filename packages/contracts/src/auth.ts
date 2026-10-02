export const RoleValues = ['CUSTOMER', 'OPERATIONS', 'REVIEWER', 'SUPER_ADMIN'] as const;

export type Role = (typeof RoleValues)[number];
