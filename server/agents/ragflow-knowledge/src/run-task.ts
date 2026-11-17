import type { AgentTerminalResult, TaskEnvelope } from '../../../packages/agent-protocol/src/index.js';
import { toEvidence, type RagflowChunk } from '../../../packages/ragflow-client/src/index.js';

import { createEvent, type AgentReporter } from './reporter.js';

export interface RagflowRetriever {
  retrieve(request: { question: string; datasetIds: string[]; pageSize?: number }): Promise<RagflowChunk[]>;
}

export async function runTask(
  envelope: TaskEnvelope,
  reporter: AgentReporter,
  client: RagflowRetriever,
  datasetIds = parseDatasetIds(),
): Promise<AgentTerminalResult> {
  const query = envelope.input.query;
  if (typeof query !== 'string' || !query.trim()) throw new Error('knowledge.retrieve requires a non-empty string input.query.');
  if (datasetIds.length === 0) throw new Error('RAGFLOW_DATASET_IDS must list at least one dataset.');

  let sequence = 1;
  await reporter.report(createEvent(envelope, sequence++, 'started', { capability: 'knowledge.retrieve' }));
  await reporter.report(createEvent(envelope, sequence++, 'progress', { stage: 'retrieving_knowledge' }));
  // RAGFlow rejects one request that mixes datasets built with different
  // embedding models. Query each authorized dataset independently, then merge
  // the evidence under this single leased agent attempt.
  const chunks: RagflowChunk[] = [];
  for (const datasetId of datasetIds) {
    chunks.push(...await client.retrieve({ question: query, datasetIds: [datasetId] }));
  }
  const evidence = toEvidence(chunks);
  await reporter.report(createEvent(envelope, sequence++, 'checkpoint', { evidenceCount: evidence.length }));

  const result: AgentTerminalResult = {
    protocolVersion: 'v1',
    taskId: envelope.taskId,
    taskNodeId: envelope.taskNodeId,
    instanceId: envelope.instanceId,
    status: 'succeeded',
    output: { query, evidenceCount: evidence.length },
    evidence,
    risks: evidence.length === 0 ? ['no_evidence'] : [],
    artifacts: [],
  };
  await reporter.report(createEvent(envelope, sequence, 'completed', { status: result.status, evidenceCount: evidence.length }));
  return result;
}

function parseDatasetIds(source: NodeJS.ProcessEnv = process.env): string[] {
  return (source.RAGFLOW_DATASET_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}
