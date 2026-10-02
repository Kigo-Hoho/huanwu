import { PrismaPg } from '@prisma/adapter-pg';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { PrismaClient } from '../generated/prisma/client.js';

const localDatabaseUrl =
  'postgresql://barter:barter_local_password@localhost:5432/barter';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL ?? localDatabaseUrl,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
