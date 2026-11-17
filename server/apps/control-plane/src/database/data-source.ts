import 'reflect-metadata';

import { DataSource } from 'typeorm';

import { InitialControlPlaneMigration } from './migrations/0001-initial-control-plane';
import { AgentOrchestrationMigration } from './migrations/0002-agent-orchestration';
import { TaskObservabilityMigration } from './migrations/0003-task-observability';
import { TaskArtifactsAndReworkMigration } from './migrations/0004-task-artifacts-and-rework';
import { TaskInputsMigration } from './migrations/0005-task-inputs';
import { TaskInteractionsMigration } from './migrations/0006-task-interactions';
import { TaskAcceptance1763136000000 } from './migrations/0007-task-acceptance';
import { FactoryIntake1763222400000 } from './migrations/0008-factory-source';
import { AgentRetirement1763308800000 } from './migrations/0009-agent-retirement';
import { TaskRevisions1763395200000 } from './migrations/0010-task-revisions';
import { InputOrigin1763481600000 } from './migrations/0011-input-origin';

export function createControlPlaneDataSource(databaseUrl: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    migrations: [InitialControlPlaneMigration, AgentOrchestrationMigration, TaskObservabilityMigration, TaskArtifactsAndReworkMigration, TaskInputsMigration, TaskInteractionsMigration, TaskAcceptance1763136000000, FactoryIntake1763222400000, AgentRetirement1763308800000, TaskRevisions1763395200000, InputOrigin1763481600000],
    synchronize: false,
  });
}

export async function runMigrations(dataSource: DataSource): Promise<void> {
  await dataSource.runMigrations({ transaction: 'all' });
}
