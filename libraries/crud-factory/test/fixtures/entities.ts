import { defineEntity } from '../../src/index.ts';
import { posts, users } from './schema.ts';

export const userEntity = defineEntity(users, {
  primaryKey: 'id',
  hidden: ['passwordHash'],
  // Hidden (`passwordHash`) and soft-delete (`deletedAt`) columns are never writable by clients.
  create: { omit: ['id', 'createdAt'] },
  update: { omit: ['email', 'createdAt'] },
  filterable: { status: ['eq', 'in'], name: ['ilike'], createdAt: ['gte', 'lte'], orgId: ['eq'] },
  sortable: ['createdAt', 'name'],
  defaultSort: '-createdAt',
  pagination: { defaultLimit: 2, maxLimit: 3 },
  softDelete: 'deletedAt',
});

// `orgId` is the tenant column: clients can't set or move it; a `beforeCreate` hook stamps it.
export const postEntity = defineEntity(posts, {
  primaryKey: 'id',
  create: { omit: ['id', 'createdAt', 'orgId'] },
  update: { omit: ['orgId'] },
  filterable: { authorId: ['eq'] },
  sortable: ['title'],
});
