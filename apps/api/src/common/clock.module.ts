import { Module } from '@nestjs/common';
import { CLOCK, SystemClock } from './clock.js';

@Module({ providers: [{ provide: CLOCK, useClass: SystemClock }], exports: [CLOCK] })
export class ClockModule {}
