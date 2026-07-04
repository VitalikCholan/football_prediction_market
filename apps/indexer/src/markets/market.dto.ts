import {
  HistoryQuery,
  HistoryResponseDto as HistoryResponseSchema,
  MarketDto as MarketSchema,
  MarketListDto as MarketListSchema,
  MarketListQuery,
} from '@fpm/shared';
import { createZodDto } from 'nestjs-zod';

/**
 * NestJS DTOs backed by the shared zod schemas — the single source of truth for
 * the REST contract, shared with the web app via `@fpm/shared`. The global
 * ZodValidationPipe validates request query/body against these; responses are
 * shaped by MarketsService to match the same schemas.
 */
export class MarketDto extends createZodDto(MarketSchema) {}
export class MarketListDto extends createZodDto(MarketListSchema) {}
export class MarketListQueryDto extends createZodDto(MarketListQuery) {}
export class HistoryQueryDto extends createZodDto(HistoryQuery) {}
export class HistoryResponseDto extends createZodDto(HistoryResponseSchema) {}
