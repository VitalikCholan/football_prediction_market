import { Controller, Get, Param, Query } from '@nestjs/common';
import type { AnyMarketDto, AnyMarketListDto } from '@fpm/shared';
import {
  HistoryQueryDto,
  HistoryResponseDto,
  MarketListQueryDto,
} from './market.dto';
import { MarketsService } from './markets.service';

@Controller('markets')
export class MarketsController {
  constructor(private readonly markets: MarketsService) {}

  /**
   * GET /markets?state=&limit=&offset= -> AnyMarketListDto (mixed binary + 1X2
   * markets + total). Binary entries stay byte-compatible with the legacy
   * MarketListDto shape, so a binary-only consumer parses them unchanged.
   */
  @Get()
  list(@Query() query: MarketListQueryDto): Promise<AnyMarketListDto> {
    return this.markets.list(query);
  }

  /** GET /markets/:id -> MarketDto | Market1x2Dto by kind (PDA or fixture id). */
  @Get(':id')
  findOne(@Param('id') id: string): Promise<AnyMarketDto> {
    return this.markets.findOne(id);
  }

  /** GET /markets/:id/history?from=&to=&resolution= -> HistoryResponseDto. */
  @Get(':id/history')
  history(
    @Param('id') id: string,
    @Query() query: HistoryQueryDto,
  ): Promise<HistoryResponseDto> {
    return this.markets.history(id, query);
  }
}
