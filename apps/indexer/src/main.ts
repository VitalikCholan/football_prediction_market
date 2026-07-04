import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global zod validation for all @Query/@Body DTOs built via nestjs-zod.
  app.useGlobalPipes(new ZodValidationPipe());

  // CORS for the web origin (comma-separated; defaults to permissive dev).
  const origins = process.env.CORS_ORIGIN?.split(',').map((s) => s.trim());
  app.enableCors({ origin: origins && origins.length ? origins : true });

  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
