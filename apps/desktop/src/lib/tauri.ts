import type {
  MaskedServiceConfig,
  ServiceConfigurationInput,
} from "./contracts";
import { invoke } from "@tauri-apps/api/core";

export interface QizhiCommands {
  getSettings(): Promise<MaskedServiceConfig[]>;
  saveSettings(input: ServiceConfigurationInput): Promise<MaskedServiceConfig>;
  testServiceConnection(
    service: string,
  ): Promise<{ available: boolean; message: string }>;
  getEverythingStatus?(): Promise<EverythingStatus>;
  getTodaySnapshot(): Promise<TodaySnapshot>;
  refreshToday(): Promise<TodaySnapshot>;
  revealInExplorer(id: number): Promise<void>;
  listScanRules(): Promise<ScanRules>;
  saveScanRules(input: Omit<ScanRules, "lockedExclusions">): Promise<ScanRules>;
}

export type EverythingStatus = {
  available: boolean;
  adapter: string;
  remediation: string;
};

export type TodayFile = {
  id: number;
  canonicalPath: string;
  modifiedAtUtcMs: number;
  sizeBytes: number;
  source: string;
  status: "待分析";
};

export type TodaySnapshot =
  | {
      state: "ready";
      files: TodayFile[];
      clusters: { label: string; fileIds: number[] }[];
    }
  | {
      state: "unavailable";
      remediation: string;
      files: TodayFile[];
      clusters: { label: string; fileIds: number[] }[];
    };

export type ScanRules = {
  allowedRoots: string[];
  customExclusions: string[];
  esCliPath: string | null;
  lockedExclusions: string[];
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
  async getTodaySnapshot() {
    return {
      state: "unavailable",
      remediation: "桌面服务尚未连接，无法检测 Everything。",
      files: [],
      clusters: [],
    };
  },
  async refreshToday() {
    return this.getTodaySnapshot();
  },
  async revealInExplorer() {
    throw new Error("桌面服务尚未连接");
  },
  async listScanRules() {
    return {
      allowedRoots: [],
      customExclusions: [],
      esCliPath: null,
      lockedExclusions: [],
    };
  },
  async saveScanRules() {
    throw new Error("桌面服务尚未连接");
  },
};

export const tauriCommands: QizhiCommands = {
  getSettings: () => invoke("get_settings"),
  saveSettings: (input) => invoke("save_settings", { input }),
  testServiceConnection: (service) =>
    invoke("test_service_connection", { service }),
  getEverythingStatus: () => invoke("get_everything_status"),
  getTodaySnapshot: () => invoke("get_today_snapshot"),
  refreshToday: () => invoke("refresh_today"),
  revealInExplorer: (id) => invoke("reveal_in_explorer", { id }),
  listScanRules: () => invoke("list_scan_rules"),
  saveScanRules: (input) => invoke("save_scan_rules", { input }),
};
