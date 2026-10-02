import argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/generated/prisma/client.js';
import { Role } from '../src/generated/prisma/enums.js';

const localDatabaseUrl =
  'postgresql://barter:barter_local_password@localhost:5432/barter';

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL ?? localDatabaseUrl,
  }),
});

const seededUsers = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    displayName: 'Local Super Admin',
    role: Role.SUPER_ADMIN,
    email: 'super-admin@barter.local',
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    displayName: 'Local Reviewer',
    role: Role.REVIEWER,
    email: 'reviewer@barter.local',
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    displayName: 'Local Operations',
    role: Role.OPERATIONS,
    email: 'operations@barter.local',
  },
] as const;

async function seedAdminUsers(password: string): Promise<void> {
  for (const seededUser of seededUsers) {
    const passwordHash = await argon2.hash(password);

    await prisma.user.upsert({
      where: { id: seededUser.id },
      update: { displayName: seededUser.displayName },
      create: {
        id: seededUser.id,
        displayName: seededUser.displayName,
      },
    });

    await prisma.userRole.upsert({
      where: {
        userId_role: {
          userId: seededUser.id,
          role: seededUser.role,
        },
      },
      update: {},
      create: {
        userId: seededUser.id,
        role: seededUser.role,
      },
    });

    await prisma.adminCredential.upsert({
      where: { userId: seededUser.id },
      update: {
        email: seededUser.email,
        passwordHash,
      },
      create: {
        userId: seededUser.id,
        email: seededUser.email,
        passwordHash,
      },
    });
  }
}

async function seedCustomer(): Promise<void> {
  const customer = await prisma.user.upsert({
    where: { wechatOpenid: 'local-seed-customer' },
    update: { displayName: 'Local Customer' },
    create: {
      wechatOpenid: 'local-seed-customer',
      displayName: 'Local Customer',
    },
  });

  await prisma.userRole.upsert({
    where: {
      userId_role: {
        userId: customer.id,
        role: Role.CUSTOMER,
      },
    },
    update: {},
    create: {
      userId: customer.id,
      role: Role.CUSTOMER,
    },
  });
}

async function main(): Promise<void> {
  const adminPassword = process.env.ADMIN_SEED_PASSWORD;
  if (!adminPassword?.trim()) {
    throw new Error(
      'ADMIN_SEED_PASSWORD is required and must not be blank before seeding',
    );
  }

  await seedAdminUsers(adminPassword);
  await seedCustomer();
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
