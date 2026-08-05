import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../auth/jwt-auth.guard';

const DB_PROBE_TIMEOUT_MS = 1500;

type Health = {
  status: 'ok';
  db: 'up' | 'down';
  commit: string;
  uptimeSeconds: number;
};

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  // Explicitly public: the platform health check carries no token, and a 401 here
  // would make Render mark a perfectly healthy service as failed.
  @Public()
  @Get()
  async check(): Promise<Health> {
    return {
      status: 'ok',
      db: await this.dbState(),
      commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? 'local',
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  // Always 200 with db: 'down' rather than a 5xx. A load balancer restarting the
  // API because Neon was briefly asleep is worse than reporting the truth.
  //
  // Bounded, because it has to be: measured locally, an unreachable database makes
  // Prisma block for 6.2s before it gives up, which outlives Render's health-check
  // timeout and reds an otherwise healthy deploy.
  private async dbState(): Promise<'up' | 'down'> {
    const timeout = new Promise<'down'>((resolve) => {
      setTimeout(() => resolve('down'), DB_PROBE_TIMEOUT_MS);
    });

    const probe = (async (): Promise<'up' | 'down'> => {
      try {
        await this.prisma.$queryRaw`SELECT 1`;
        return 'up';
      } catch {
        return 'down';
      }
    })();

    return Promise.race([probe, timeout]);
  }
}
