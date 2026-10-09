import 'reflect-metadata';
import 'dotenv/config';

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { operatorOrigins } from './operator-security/operator-session.service.js';

export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
  const allowedOrigins = process.env.CORS_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const origins = [...new Set([...(allowedOrigins ?? []), ...operatorOrigins()])];
  for (const origin of origins) if (new URL(origin).origin !== origin) throw new Error('CORS requires exact origins');
  if (origins.length) app.enableCors({ credentials: true, origin: origins });
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule.forEnvironment());
  configureApp(app);
  await app.listen(Number(process.env.PORT ?? 3000));
}

if (!process.env.VITEST) {
  void bootstrap();
}
