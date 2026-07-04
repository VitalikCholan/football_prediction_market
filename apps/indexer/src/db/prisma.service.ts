import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma connection wrapper. Connects on module init and disconnects on
 * shutdown so the pool is released cleanly on redeploys.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('Prisma connected');
    } catch (err) {
      // Do not crash the whole app in dev if Postgres is unreachable; REST
      // endpoints that touch the DB will surface the error per-request instead.
      this.logger.error(
        `Prisma failed to connect: ${(err as Error).message}. ` +
          'Set DATABASE_URL to a reachable Postgres (or switch the schema ' +
          'datasource to sqlite for local dev).',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
