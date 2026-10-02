import { Module } from '@nestjs/common';
import { ClockModule } from '../common/clock.module.js';
import { ReservationsService } from './reservations.service.js';

@Module({ imports: [ClockModule], providers: [ReservationsService], exports: [ReservationsService] })
export class ReservationsModule {}
