import { Body, Controller, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';

import { InternalAuthGuard } from '../config/internal-auth.guard.js';
import { ControlService, type StartInstanceRequest } from './control.service.js';
import type { ReadyPackageRecord } from '../catalog/package-catalog.service.js';

@Controller('/internal/v1')
@UseGuards(InternalAuthGuard)
export class ControlController {
  public constructor(@Inject(ControlService) private readonly control: ControlService) {}

  @Post('self-checks')
  @HttpCode(202)
  public selfCheck(@Body() body: { agentId: string; version: string; packagePath: string }) { return this.control.requestSelfCheck(body); }

  @Post('instances')
  public start(@Body() body: StartInstanceRequest) { return this.control.startInstance(body); }

  @Post('catalog/ready-versions')
  @HttpCode(204)
  public async syncReadyVersion(@Body() body: ReadyPackageRecord): Promise<void> { await this.control.syncReadyVersion(body); }

  @Post('catalog/revoke') @HttpCode(204)
  public async revoke(@Body() body:{agentId:string;version:string}) { await this.control.revokeVersion(body.agentId,body.version); }

  @Post('instances/:instanceId/stop')
  @HttpCode(204)
  public async stop(@Param('instanceId') instanceId: string): Promise<void> { await this.control.stopInstance(instanceId); }
}
