import 'reflect-metadata';
import 'dotenv/config';

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';

export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
  const allowedOrigins = process.env.CORS_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (allowedOrigins?.length) {
    app.enableCors({ credentials: true, origin: allowedOrigins });
  }
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(Number(process.env.PORT ?? 3000));
}

if (!process.env.VITEST) {
  void bootstrap();
}
