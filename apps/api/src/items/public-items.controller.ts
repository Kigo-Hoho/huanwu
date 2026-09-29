import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';

import { PublicItemsService } from './public-items.service.js';

@Controller('items')
export class PublicItemsController {
  constructor(@Inject(PublicItemsService) private readonly items: PublicItemsService) {}

  @Get()
  list(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.items.list(cursor, limit);
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.items.get(id);
  }
}
