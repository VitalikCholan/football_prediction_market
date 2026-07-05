import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './db/db.module';
import { HealthController } from './health.controller';
import { IngestModule } from './ingest/ingest.module';
import { MarketsModule } from './markets/markets.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DbModule,
    IngestModule,
    MarketsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
