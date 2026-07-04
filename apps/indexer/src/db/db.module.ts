import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global DB module — exposes the Prisma client to every feature module so
 * MarketsModule (reads) and IndexerModule (writes) share one connection pool.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DbModule {}
