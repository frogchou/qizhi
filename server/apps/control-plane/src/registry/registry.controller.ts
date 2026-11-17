import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from '../config/auth.guard.js';
import { RegistryService } from './registry.service.js';

@Controller('/v1/agents')
@UseGuards(AdminAuthGuard)
export class RegistryController {
  public constructor(@Inject(RegistryService) private readonly registry: RegistryService) {}

  @Post('discover')
  public discover(@Body() body: { packagePath?: string }) {
    if (!body.packagePath) throw new Error('packagePath is required.');
    return this.registry.discover(body.packagePath);
  }

  @Get()
  public list() { return this.registry.list(); }

  @Post(':agentId/versions/:version/approve')
  @HttpCode(201)
  public approve(@Param('agentId') agentId: string, @Param('version') version: string) {
    return this.registry.approve(agentId, version);
  }
}
