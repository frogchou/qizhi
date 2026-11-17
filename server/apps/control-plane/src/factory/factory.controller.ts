import { Controller, Get, Header, Inject, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AdminAuthGuard } from '../config/auth.guard.js';
import { FactoryService } from './factory.service.js';
import type { FactoryQuery } from './factory-query.js';

@Controller('/v1/factory')
@UseGuards(AdminAuthGuard)
export class FactoryController {
  constructor(@Inject(FactoryService) private readonly factory: FactoryService) {}

  @Get('overview') overview() { return this.factory.overview(); }
  @Get('agents') agents(@Query() query: FactoryQuery) { return this.factory.list('agents',query); }
  @Get('tasks') tasks(@Query() query: FactoryQuery) { return this.factory.list('tasks',query); }
  @Get('quality') quality(@Query() query: FactoryQuery) { return this.factory.list('quality',query); }
  @Get('assets') assets(@Query() query: FactoryQuery) { return this.factory.assets(query); }
  @Get('runtimes') runtimes(@Query() query: FactoryQuery) { return this.factory.runtimes(query); }
  @Get('sources') sources(@Query() query: FactoryQuery) { return this.factory.list('sources',query); }
  @Get('monitor') monitor(@Query() query: FactoryQuery) { return this.factory.list('monitor',query); }
  @Get('deliveries') deliveries(@Query() query: FactoryQuery) { return this.factory.list('deliveries',query); }

  @Get('changes')
  @Header('Cache-Control', 'private, no-store')
  async changes(@Query() query: FactoryQuery, @Res({ passthrough: true }) reply: FastifyReply) {
    const cancellation = new AbortController();
    const closed = () => cancellation.abort();
    reply.raw.once('close', closed);
    try { return await this.factory.changesAfter(query,cancellation.signal); }
    finally { reply.raw.removeListener('close', closed); }
  }
}
