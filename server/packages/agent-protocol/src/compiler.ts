import { Value } from '@sinclair/typebox/value';
import { isAbsolute, normalize } from 'node:path';

import { TaskPlanSchema, type TaskPlan } from './schemas.js';
import {
  type CompiledAgentCallNode,
  type CompiledTaskPlan,
  type ReadyCapability,
  TaskPlanValidationError,
} from './types.js';

/**
 * Treat the planner output as untrusted. This compiler is the boundary that binds
 * each agent node to a reviewed capability and checks graph/workspace invariants.
 */
export function validateTaskPlan(input: unknown, catalog: ReadyCapability[]): CompiledTaskPlan {
  const plan = normalizeTaskPlan(input);
  const ids = new Set<string>();
  const compiledNodes: CompiledTaskPlan['nodes'] = [];

  for (const node of plan.nodes) {
    if (ids.has(node.id)) {
      throw new TaskPlanValidationError(`Duplicate task-plan node id: ${node.id}`);
    }
    ids.add(node.id);

    if (node.type !== 'agent_call') {
      compiledNodes.push(node);
      continue;
    }

    if (node.workspace.mode === 'shared' && !node.workspace.sharingGroup) {
      throw new TaskPlanValidationError(`Agent node ${node.id} uses a shared workspace without an explicit sharing group.`);
    }

    for (const binding of node.inputBindings ?? []) {
      if (!(node.dependsOn ?? []).includes(binding.fromNode)) {
        throw new TaskPlanValidationError(`Input binding ${binding.target} must depend on source node ${binding.fromNode}.`);
      }
      if (!Array.isArray(node.input[binding.target])) {
        throw new TaskPlanValidationError(`Input binding ${binding.target} must target an array declared in the node input.`);
      }
      if (binding.source === 'artifact') {
        if (binding.artifactPath && (isAbsolute(binding.artifactPath) || normalize(binding.artifactPath).split(/[\\/]+/).includes('..'))) {
          throw new TaskPlanValidationError('Artifact path must be a contained relative path.');
        }
      } else if (binding.artifactPath) {
        throw new TaskPlanValidationError('Evidence binding must not include an artifact path.');
      }
    }
    for (const binding of node.taskInputBindings ?? []) {
      if (!Array.isArray(node.input[binding.target])) {
        throw new TaskPlanValidationError(`Task-input binding ${binding.target} must target an array declared in the node input.`);
      }
    }

    const selected = catalog.find((item) => item.capability === node.capability);
    if (!selected) {
      throw new TaskPlanValidationError(`Capability ${node.capability} is not ready in the reviewed catalog.`);
    }
    // Bindings are materialized only after dependency completion. Validate a
    // deterministic placeholder view so a required array (for example quality
    // targets) may be supplied exclusively by an approved upstream artifact.
    if (!Value.Check(selected.inputSchema, inputWithBindingPlaceholders(node.input, [...(node.inputBindings ?? []), ...(node.taskInputBindings ?? [])]))) {
      throw new TaskPlanValidationError(`Agent node ${node.id} input does not satisfy capability ${node.capability}.`);
    }

    compiledNodes.push({
      ...node,
      agentId: selected.agentId,
      agentVersion: selected.version,
    } satisfies CompiledAgentCallNode);
  }

  validateGraph(plan);
  return { version: plan.version, nodes: compiledNodes };
}

/** Converts the early approval node into the executable interaction shape. */
export function normalizeTaskPlan(input: unknown): TaskPlan {
  if (!Value.Check(TaskPlanSchema, input)) {
    throw new TaskPlanValidationError('Task plan does not match Protocol v1 schema.');
  }
  const plan = input as TaskPlan;
  return {
    ...plan,
    nodes: plan.nodes.map((node) => {
      if (node.type !== 'approval') return node;
      return {
        id: node.id,
        dependsOn: node.dependsOn,
        type: 'human_interaction',
        interaction: {
          kind: 'confirmation',
          title: '需要人工确认',
          prompt: node.reason,
          responseTarget: `task.session.${node.id}`,
          responseSchema: {
            type: 'object',
            properties: {
              decision: { type: 'string', enum: ['confirm', 'reject'] },
              note: { type: 'string', maxLength: 4_000 },
            },
            required: ['decision'],
            additionalProperties: false,
          },
        },
      };
    }),
  } as TaskPlan;
}

/** Checks that an otherwise-valid plan cannot grant a node material from another task. */
export function validateTaskInputBindings(plan: TaskPlan, allowedInputIds: readonly string[], requiredInputIds:readonly string[]=allowedInputIds): void {
  const allowed = new Set(allowedInputIds);
  const granted = new Set<string>();
  for (const node of plan.nodes) {
    if (node.type !== 'agent_call') continue;
    const seen = new Set<string>();
    for (const binding of node.taskInputBindings ?? []) {
      if (!allowed.has(binding.inputId)) throw new TaskPlanValidationError(`Task-input binding ${binding.inputId} is not available to this task.`);
      const key = `${binding.target}\u0000${binding.inputId}`;
      if (seen.has(key)) throw new TaskPlanValidationError(`Task-input binding ${binding.inputId} is duplicated for node ${node.id}.`);
      seen.add(key);
      granted.add(binding.inputId);
    }
  }
  for (const inputId of requiredInputIds) {
    if (!granted.has(inputId)) throw new TaskPlanValidationError(`Task input ${inputId} was provided with the requirement but is not granted to any agent node.`);
  }
}

function validateGraph(plan: TaskPlan): void {
  const nodeIds = new Set(plan.nodes.map((node) => node.id));
  const dependencies = new Map(plan.nodes.map((node) => [node.id, node.dependsOn ?? []]));

  for (const [nodeId, nodeDependencies] of dependencies) {
    for (const dependency of nodeDependencies) {
      if (!nodeIds.has(dependency)) {
        throw new TaskPlanValidationError(`Node ${nodeId} depends on unknown node ${dependency}.`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) {
      throw new TaskPlanValidationError(`Task plan contains a dependency cycle at node ${nodeId}.`);
    }
    visiting.add(nodeId);
    for (const dependency of dependencies.get(nodeId) ?? []) visit(dependency);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };

  for (const node of plan.nodes) visit(node.id);

  const ends = plan.nodes.filter((node) => node.type === 'end');
  if (ends.length !== 1) throw new TaskPlanValidationError('Task plan must contain exactly one terminal end node.');
  const end = ends[0];
  if (plan.nodes.some((node) => (node.dependsOn ?? []).includes(end.id))) {
    throw new TaskPlanValidationError(`Terminal end node ${end.id} cannot have downstream nodes.`);
  }

  const upstream = new Set<string>();
  const collectUpstream = (nodeId: string): void => {
    for (const dependency of dependencies.get(nodeId) ?? []) {
      if (upstream.has(dependency)) continue;
      upstream.add(dependency);
      collectUpstream(dependency);
    }
  };
  collectUpstream(end.id);
  const detached = plan.nodes.filter((node) => node.type !== 'end' && !upstream.has(node.id));
  if (detached.length > 0) {
    throw new TaskPlanValidationError(`Task plan contains nodes that do not feed the terminal end node: ${detached.map((node) => node.id).join(', ')}.`);
  }
}

function inputWithBindingPlaceholders(input: Record<string, unknown>, bindings: Array<{ target: string; fromNode?: string; inputId?: string }> | undefined): Record<string, unknown> {
  const result = structuredClone(input);
  for (const binding of bindings ?? []) {
    const placeholder = `__bound_${binding.fromNode ?? binding.inputId}_${binding.target}__`;
    const current = result[binding.target];
    if (Array.isArray(current)) {
      result[binding.target] = [...current, placeholder];
    }
  }
  return result;
}
