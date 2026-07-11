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

// The list/detail endpoints serve binary + 1X2 markets (C2). Their response
// shapes are the shared zod UNIONS `AnyMarketDto` / `AnyMarketListDto` — a union
// schema cannot back a `createZodDto` class (nestjs-zod requires an object base),
// so the controller/service type against the shared TS types directly and the
// service validates each response with the zod schema (`.parse`) before return.
// (Request query/body still use the createZodDto classes above.)
export type { AnyMarketDto, AnyMarketListDto } from '@fpm/shared';
export class HistoryQueryDto extends createZodDto(HistoryQuery) {}
export class HistoryResponseDto extends createZodDto(HistoryResponseSchema) {}
