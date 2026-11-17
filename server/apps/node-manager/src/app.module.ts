import { DynamicModule, Module } from '@nestjs/common';

import { PackageCatalogService } from './catalog/package-catalog.service.js';
import { InternalAuthGuard, NODE_INTERNAL_TOKEN_HASH } from './config/internal-auth.guard.js';
import { ControlController } from './control/control.controller.js';
import { ControlService } from './control/control.service.js';
import { SystemdSupervisor } from './supervisor/systemd.supervisor.js';

export type NodeManagerModuleOptions = { internalTokenHash: string; catalog?: PackageCatalogService };

@Module({})
export class NodeManagerModule {
  public static register(options: NodeManagerModuleOptions): DynamicModule {
    const catalog = options.catalog ?? new PackageCatalogService();
    const supervisor = new SystemdSupervisor();
    return {
      module: NodeManagerModule,
      controllers: [ControlController],
      providers: [
        { provide: NODE_INTERNAL_TOKEN_HASH, useValue: options.internalTokenHash },
        InternalAuthGuard,
        { provide: ControlService, useValue: new ControlService({ catalog, supervisor, selfCheckCatalog: catalog, selfCheckSupervisor: supervisor }) },
      ],
    };
  }
}
