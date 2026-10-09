import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { OperatorDeviceService } from '../src/operator-security/operator-device.service.js';
import { OperatorSecurityModule } from '../src/operator-security/operator-security.module.js';

const [deviceId, reason, ...extra] = process.argv.slice(2);
if (!deviceId || !reason || extra.length) {
  console.error('Usage: approve-operator-device <existing-device-id> <reason>');
  process.exitCode = 1;
} else {
  let app: INestApplicationContext | undefined;
  try {
    app = await NestFactory.createApplicationContext(OperatorSecurityModule, { logger: false, abortOnError: false });
    await app.get(OperatorDeviceService).approveDevice(deviceId, reason);
    console.log('Existing pending operator device approved through server administration.');
  } catch {
    console.error('Operator device approval rejected. Check pending state and bootstrap eligibility.');
    process.exitCode = 1;
  } finally { await app?.close(); }
}
