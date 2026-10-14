import { Controller, Get } from '@nestjs/common';

/**
 * Liveness only — no version, no uptime, no database round trip.
 *
 * It sits on a public hostname in front of TLS termination, so anything it reports is
 * information about the box. It deliberately does not even check Mongo: Docker's healthcheck
 * depends on it returning 200 while the API is up, and a transient database blip must not
 * make Docker restart a healthy process.
 */
@Controller('health')
export class HealthController {
  @Get()
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
