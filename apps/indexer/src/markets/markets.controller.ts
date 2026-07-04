import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  HistoryQueryDto,
  HistoryResponseDto,
  MarketDto,
  MarketListDto,
  MarketListQueryDto,
} from './market.dto';
import { MarketsService } from './markets.service';

@Controller('markets')
export class MarketsController {
  constructor(private readonly markets: MarketsService) {}

  /** GET /markets?state=&limit=&offset= -> MarketListDto (MarketDto[] + total). */
  @Get()
  list(@Query() query: MarketListQueryDto): Promise<MarketListDto> {
    return this.markets.list(query);
  }

  /** GET /markets/:id -> MarketDto (accepts market PDA or fixture id). */
  @Get(':id')
  findOne(@Param('id') id: string): Promise<MarketDto> {
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
