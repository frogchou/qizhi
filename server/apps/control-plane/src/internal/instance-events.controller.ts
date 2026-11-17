import { Body, Controller, Inject, Param, Post } from '@nestjs/common';

import { InstanceEventsService } from './instance-events.service.js';

@Controller('/internal/v1/instances')
export class InstanceEventsController {
  public constructor(@Inject(InstanceEventsService) private readonly events: InstanceEventsService) {}

  @Post(':instanceId/events')
  public append(@Param('instanceId') instanceId: string, @Body() event: unknown) {
    return this.events.append(instanceId, event);
  }
}
