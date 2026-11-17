import { DynamicModule, Module } from '@nestjs/common';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';

import { CodexCliRunner, type CodexRunner } from '../../../packages/codex-runtime/src/index.js';
import { ADMIN_TOKEN_HASH, AdminAuthGuard } from './config/auth.guard.js';
import { FactoryController } from './factory/factory.controller.js';
import { FactoryService } from './factory/factory.service.js';
import { FactoryReleaseController } from './registry/factory-releases.controller.js';
import { InstanceEventsController } from './internal/instance-events.controller.js';
import { InstanceEventsService } from './internal/instance-events.service.js';
import { InstanceResultsController } from './internal/instance-results.controller.js';
import { InstanceResultsService } from './internal/instance-results.service.js';
import { TaskActivityPublisher, TaskActivityService } from './observability/task-activity.service.js';
import { TaskEventStreamController } from './observability/task-events.controller.js';
import { OperationalLogger } from './observability/operational-logger.js';
import { StreamTicketService } from './observability/stream-ticket.service.js';
import { RegistryController } from './registry/registry.controller.js';
import { AgentPackageDiscoveryService } from './registry/agent-package-discovery.service.js';
import { CONTROL_PLANE_DATA_SOURCE, NODE_MANAGER_CLIENT, type NodeManagerClient, RegistryService } from './registry/registry.service.js';
import { CapabilityCatalogService } from './planning/capability-catalog.service.js';
import { CodexPlannerService } from './planning/codex-planner.service.js';
import { PlanningService } from './planning/planning.service.js';
import { TaskSessionService } from './tasks/task-session.service.js';
import { TaskRecoveryService } from './tasks/task-recovery.service.js';
import { TaskLivenessService } from './tasks/task-liveness.service.js';
import { TaskOrchestrationService } from './tasks/task-orchestration.service.js';
import { TaskSchedulerService, type NodeManagerLauncher } from './tasks/task-scheduler.service.js';
import { TaskWorkspaceService } from './tasks/task-workspace.service.js';
import { TaskArtifactService } from './tasks/task-artifact.service.js';
import { TaskInputService } from './tasks/task-input.service.js';
import { TaskInteractionService } from './tasks/task-interaction.service.js';
import { TASK_RUNTIME_CONFIG, TaskService, type TaskRuntimeConfig } from './tasks/tasks.service.js';
import { TasksController } from './tasks/tasks.controller.js';
import { TaskInputsController } from './tasks/task-inputs.controller.js';

export type AppModuleOptions = { dataSource: DataSource; adminTokenHash: string; nodeManager: NodeManagerClient; acceptanceRunner?: CodexRunner; taskRuntime?: TaskRuntimeConfig };
const CODEX_RUNNER = Symbol('CODEX_RUNNER');

@Module({})
export class AppModule {
  public static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [RegistryController, FactoryReleaseController, FactoryController, InstanceEventsController, InstanceResultsController, TasksController, TaskInputsController, TaskEventStreamController],
      providers: [
        FactoryService,
        { provide: CONTROL_PLANE_DATA_SOURCE, useValue: options.dataSource },
        { provide: NODE_MANAGER_CLIENT, useValue: options.nodeManager },
        { provide: OperationalLogger, useFactory: () => new OperationalLogger(), inject: [] },
        { provide: TaskActivityPublisher, useFactory: () => new TaskActivityPublisher(), inject: [] },
        { provide: TaskActivityService, useFactory: (dataSource: DataSource, publisher: TaskActivityPublisher) => new TaskActivityService(dataSource, publisher), inject: [CONTROL_PLANE_DATA_SOURCE, TaskActivityPublisher] },
        { provide: StreamTicketService, useFactory: () => new StreamTicketService(), inject: [] },
        { provide: TASK_RUNTIME_CONFIG, useValue: options.taskRuntime ?? { ragflowBaseUrl: 'http://invalid', ragflowApiKey: '', datasetIds: [], workspaceRoot: '/tmp/middleground-workspaces' } },
        { provide: TaskWorkspaceService, useFactory: (config: TaskRuntimeConfig) => new TaskWorkspaceService({ root: config.workspaceRoot }), inject: [TASK_RUNTIME_CONFIG] },
        { provide: TaskInputService, useFactory: (dataSource: DataSource, workspaces: TaskWorkspaceService, config: TaskRuntimeConfig) => new TaskInputService(dataSource, workspaces, { workspaceRoot: config.workspaceRoot, maxFileBytes: config.taskInputMaxFileBytes, maxInputCount: config.taskInputMaxCount, maxTotalBytes: config.taskInputMaxTotalBytes }), inject: [CONTROL_PLANE_DATA_SOURCE, TaskWorkspaceService, TASK_RUNTIME_CONFIG] },
        { provide: TaskArtifactService, useFactory: (dataSource: DataSource, workspaces: TaskWorkspaceService) => new TaskArtifactService(dataSource, workspaces), inject: [CONTROL_PLANE_DATA_SOURCE, TaskWorkspaceService] },
        { provide: TaskSessionService, useFactory: (workspaces: TaskWorkspaceService) => new TaskSessionService(workspaces), inject: [TaskWorkspaceService] },
        { provide: TaskInteractionService, useFactory: (dataSource: DataSource, workspaces: TaskWorkspaceService, sessions: TaskSessionService, activities: TaskActivityService, inputs: TaskInputService) => new TaskInteractionService(dataSource, workspaces, sessions, activities, inputs), inject: [CONTROL_PLANE_DATA_SOURCE, TaskWorkspaceService, TaskSessionService, TaskActivityService, TaskInputService] },
        { provide: TaskSchedulerService, useFactory: (dataSource: DataSource, workspaces: TaskWorkspaceService, sessions: TaskSessionService, config: TaskRuntimeConfig, activities: TaskActivityService, interactions: TaskInteractionService) => new TaskSchedulerService(dataSource, workspaces, sessions, options.nodeManager as unknown as NodeManagerLauncher, { workspaceRoot: config.workspaceRoot, callbackBaseUrl: config.callbackBaseUrl ?? 'http://127.0.0.1:3010', runtimeRoot: config.instanceRuntimeRoot, environment: { RAGFLOW_BASE_URL: config.ragflowBaseUrl, RAGFLOW_API_KEY: config.ragflowApiKey, RAGFLOW_DATASET_IDS: config.datasetIds.join(',') } }, activities, interactions, options.acceptanceRunner), inject: [CONTROL_PLANE_DATA_SOURCE, TaskWorkspaceService, TaskSessionService, TASK_RUNTIME_CONFIG, TaskActivityService, TaskInteractionService] },
        { provide: CODEX_RUNNER, useFactory: () => new CodexCliRunner(), inject: [] },
        { provide: CodexPlannerService, useFactory: (runner: CodexRunner, config: TaskRuntimeConfig) => new CodexPlannerService(runner, config.codexPlannerTimeoutMs), inject: [CODEX_RUNNER, TASK_RUNTIME_CONFIG] },
        { provide: ADMIN_TOKEN_HASH, useValue: options.adminTokenHash },
        AdminAuthGuard,
        RegistryService,
        { provide: AgentPackageDiscoveryService, useFactory: (registry: RegistryService, config: TaskRuntimeConfig) => new AgentPackageDiscoveryService(registry, { root: config.agentPackageRoot ?? join(process.cwd(), 'agents') }), inject: [RegistryService, TASK_RUNTIME_CONFIG] },
        CapabilityCatalogService,
        { provide: PlanningService, useFactory: (dataSource: DataSource, catalog: CapabilityCatalogService, planner: CodexPlannerService, workspaces: TaskWorkspaceService, sessions: TaskSessionService, activities: TaskActivityService) => new PlanningService(dataSource, catalog, planner, workspaces, sessions, activities), inject: [CONTROL_PLANE_DATA_SOURCE, CapabilityCatalogService, CodexPlannerService, TaskWorkspaceService, TaskSessionService, TaskActivityService] },
        { provide: TaskOrchestrationService, useFactory: (dataSource: DataSource, planning: PlanningService, scheduler: TaskSchedulerService, sessions: TaskSessionService, activities: TaskActivityService, logger: OperationalLogger) => new TaskOrchestrationService(dataSource, planning, scheduler, sessions, activities, logger), inject: [CONTROL_PLANE_DATA_SOURCE, PlanningService, TaskSchedulerService, TaskSessionService, TaskActivityService, OperationalLogger] },
        { provide: TaskRecoveryService, useFactory: (dataSource: DataSource, scheduler: TaskSchedulerService, sessions: TaskSessionService, orchestration: TaskOrchestrationService) => new TaskRecoveryService(dataSource, scheduler, sessions, orchestration), inject: [CONTROL_PLANE_DATA_SOURCE, TaskSchedulerService, TaskSessionService, TaskOrchestrationService] },
        { provide: TaskLivenessService, useFactory: (dataSource: DataSource, scheduler: TaskSchedulerService, sessions: TaskSessionService, activities: TaskActivityService, logger: OperationalLogger) => new TaskLivenessService(dataSource, scheduler, options.nodeManager as unknown as NodeManagerLauncher, sessions, activities, logger), inject: [CONTROL_PLANE_DATA_SOURCE, TaskSchedulerService, TaskSessionService, TaskActivityService, OperationalLogger] },
        InstanceEventsService,
        InstanceResultsService,
        { provide: TaskService, useFactory: (dataSource: DataSource, workspaces: TaskWorkspaceService, sessions: TaskSessionService, orchestration: TaskOrchestrationService, activities: TaskActivityService, artifacts: TaskArtifactService, scheduler: TaskSchedulerService, inputs: TaskInputService, interactions: TaskInteractionService) => new TaskService(dataSource, workspaces, sessions, orchestration, activities, artifacts, scheduler, inputs, interactions), inject: [CONTROL_PLANE_DATA_SOURCE, TaskWorkspaceService, TaskSessionService, TaskOrchestrationService, TaskActivityService, TaskArtifactService, TaskSchedulerService, TaskInputService, TaskInteractionService] },
      ],
    };
  }
}
