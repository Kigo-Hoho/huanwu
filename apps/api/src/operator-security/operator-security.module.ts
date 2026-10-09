import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ClockModule } from '../common/clock.module.js';
import { ActionGrantService } from './action-grant.service.js';
import { OperatorSecurityController } from './operator-security.controller.js';
import { OperatorDeviceService } from './operator-device.service.js';
import { DatabaseModule } from '../database/database.module.js';
@Module({ imports: [DatabaseModule, AuthModule, AuditModule, ClockModule], controllers: [OperatorSecurityController], providers: [ActionGrantService, OperatorDeviceService], exports: [ActionGrantService, OperatorDeviceService, AuthModule] })
export class OperatorSecurityModule {}
