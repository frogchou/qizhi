import { BadRequestException, Controller, Inject, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import '@fastify/multipart';

import { AdminAuthGuard } from '../config/auth.guard.js';
import { TaskInputService, uploadOrigin } from './task-input.service.js';

/** Accepts one streamed, short-lived upload before it is explicitly frozen into a task. */
@Controller('/v1/task-inputs')
@UseGuards(AdminAuthGuard)
export class TaskInputsController {
  public constructor(@Inject(TaskInputService) private readonly inputs: TaskInputService) {}

  @Post('uploads')
  public async upload(@Req() request: FastifyRequest) {
    if (!request.isMultipart()) throw new BadRequestException('Content-Type must be multipart/form-data.');
    const origin = uploadOrigin(request.headers['x-qizhi-source-type'], request.headers['x-qizhi-basket-id']);
    const part = await request.file({ limits: { files: 1, fileSize: this.inputs.limits().maxFileBytes } });
    if (!part) throw new BadRequestException('缺少 file 附件字段。');
    if (part.fieldname !== 'file') {
      part.file.resume();
      throw new BadRequestException('附件字段必须命名为 file。');
    }
    return { upload: await this.inputs.stageUpload({ originalFilename: part.filename, mediaType: part.mimetype, stream: part.file, origin }) };
  }
}
