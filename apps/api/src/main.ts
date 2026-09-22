import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';

export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(Number(process.env.PORT ?? 3000));
}

if (process.env.NODE_ENV !== 'test') {
  void bootstrap();
}
