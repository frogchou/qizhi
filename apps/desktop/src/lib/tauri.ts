import type {
  MaskedServiceConfig,
  ServiceConfigurationInput,
} from "./contracts";

export interface QizhiCommands {
  getSettings(): Promise<MaskedServiceConfig[]>;
  saveSettings(input: ServiceConfigurationInput): Promise<MaskedServiceConfig>;
  testServiceConnection(
    service: string,
  ): Promise<{ available: boolean; message: string }>;
  getEverythingStatus?(): Promise<EverythingStatus>;
}

export type EverythingStatus = {
  available: boolean;
  adapter: string;
  remediation: string;
};

export const unavailableCommands: QizhiCommands = {
  async getSettings() {
    return [];
  },
  async saveSettings() {
    throw new Error("桌面服务尚未连接");
  },
  async testServiceConnection() {
    return { available: false, message: "桌面服务尚未连接" };
  },
};
