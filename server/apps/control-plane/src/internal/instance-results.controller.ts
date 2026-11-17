import { Body, Controller, Inject, Param, Post } from '@nestjs/common';

import { TaskSchedulerService } from '../tasks/task-scheduler.service.js';
import { InstanceResultsService } from './instance-results.service.js';

@Controller('/internal/v1/instances')
export class InstanceResultsController {
  public constructor(@Inject(InstanceResultsService) private readonly results: InstanceResultsService, @Inject(TaskSchedulerService) private readonly scheduler: TaskSchedulerService) {}

  @Post(':instanceId/result')
  public async accept(@Param('instanceId') instanceId: string, @Body() result: unknown) {
    const accepted = await this.results.accept(instanceId, result);
    await this.scheduler.advance(accepted.taskId);
    return accepted;
  }
}
