import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { PrismaService } from './database/prisma.service.js';
import { HealthController } from './health/health.controller.js';

@Module({
  controllers: [HealthController],
  providers: [
    PrismaService,
    {
      provide: APP_FILTER,
      useClass: ApiExceptionFilter,
    },
  ],
  exports: [PrismaService],
})
export class AppModule {}
