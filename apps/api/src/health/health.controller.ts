import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  readiness(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
