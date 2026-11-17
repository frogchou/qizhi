export type InstanceLaunchSpec = {
  instanceId: string;
  workingDirectory: string;
  environmentFile: string;
  command: string[];
};

export type StartedInstance = { instanceId: string; unitName: string };

export interface ProcessSupervisor {
  start(spec: InstanceLaunchSpec): Promise<StartedInstance>;
  stop(instanceId: string): Promise<void>;
}

export interface SelfCheckSupervisor {
  selfCheck(spec: { agentId: string; version: string; packagePath: string; command: string[] }): Promise<void>;
}
