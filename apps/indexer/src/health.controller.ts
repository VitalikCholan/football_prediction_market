import { Controller, Get } from '@nestjs/common';

/** Liveness probe for Railway health checks. */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok'; ts: number } {
    return { status: 'ok', ts: Math.floor(Date.now() / 1000) };
  }
}
