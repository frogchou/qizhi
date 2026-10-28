import type {
  MaskedServiceConfig,
  ServiceConfigurationInput,
} from "./contracts";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface QizhiCommands {
  getSettings(): Promise<MaskedServiceConfig[]>;
  saveSettings(input: ServiceConfigurationInput): Promise<MaskedServiceConfig>;
  testServiceConnection(
    input: ServiceConfigurationInput,
  ): Promise<ConnectionStatus>;
  pickFolder(): Promise<string | null>;
  getEverythingStatus?(): Promise<EverythingStatus>;
  getTodaySnapshot(): Promise<TodaySnapshot>;
  getTodayScanStatus?(): Promise<TodayScanStatus>;
  refreshToday(): Promise<TodaySnapshot>;
  revealInExplorer(id: number): Promise<void>;
  openFile(id: number): Promise<void>;
  openFileInTextEditor(id: number): Promise<void>;
  copyFileToClipboard(id: number): Promise<void>;
  deleteFile(id: number): Promise<void>;
  listScanRules(): Promise<ScanRules>;
  saveScanRules(
    input: Pick<
      ScanRules,
      "allowedRoots" | "customExclusions" | "fileCategories" | "esCliPath"
    >,
  ): Promise<ScanRules>;
  listRagflowChats?(): Promise<RagflowChat[]>;
  askRagflowChat?(input: {
    chatId: string;
    question: string;
  }): Promise<RagflowAnswer>;
  listRagflowDatasets?(): Promise<RagflowDataset[]>;
  listRagflowAgents?(): Promise<RagflowAgent[]>;
  queryRagflowKnowledge?(input: {
    question: string;
    datasetIds: string[];
    agentIds: string[];
  }): Promise<RagflowKnowledgeQuery>;
  downloadRagflowDocument?(input: {
    datasetId: string;
    documentId: string;
    savePath: string;
  }): Promise<{ savedPath: string }>;
}

export type ConnectionStatus = { available: boolean; message: string };

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

export type TodayScanStatus = {
  state: "idle" | "scanning" | "completed" | "failed";
  directoriesScanned: number;
  candidatesFound: number;
  startedAtUtcMs: number | null;
  completedAtUtcMs: number | null;
  message: string | null;
};

export type ScanRules = {
  allowedRoots: string[];
  customExclusions: string[];
  fileCategories: FileCategory[];
  everythingSdkPath: string | null;
  esCliPath: string | null;
  lockedExclusions: string[];
};

export type FileCategory = "documents" | "sourceCode";

export type RagflowChat = {
  id: string;
  name: string;
  description: string;
};

export type RagflowAnswer = {
  answer: string;
  sessionId: string;
};
export type RagflowDataset = { id: string; name: string; description: string };
export type RagflowAgent = { id: string; name: string; description: string };
export type RagflowChunk = {
  id: string;
  content: string;
  documentName: string;
  documentId: string;
  datasetId: string;
  similarity: number;
};
export type RagflowAgentResult = {
  agentId: string;
  answer: string | null;
  error: string | null;
};
export type RagflowKnowledgeQuery = {
  chunks: RagflowChunk[];
  agentResults: RagflowAgentResult[];
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
  async pickFolder() {
    return null;
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
  async openFile() {
    throw new Error("桌面服务尚未连接");
  },
  async openFileInTextEditor() {
    throw new Error("桌面服务尚未连接");
  },
  async copyFileToClipboard() {
    throw new Error("桌面服务尚未连接");
  },
  async deleteFile() {
    throw new Error("桌面服务尚未连接");
  },
  async listScanRules() {
    return {
      allowedRoots: [],
      customExclusions: [],
      fileCategories: ["documents", "sourceCode"],
      everythingSdkPath: null,
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
  testServiceConnection: (input) =>
    invoke("test_service_connection", { input }),
  pickFolder: async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择文件夹",
    });
    return typeof selected === "string" ? selected : null;
  },
  getEverythingStatus: () => invoke("get_everything_status"),
  getTodaySnapshot: () => invoke("get_today_snapshot"),
  getTodayScanStatus: () => invoke("get_today_scan_status"),
  refreshToday: () => invoke("refresh_today"),
  revealInExplorer: (id) => invoke("reveal_in_explorer", { id }),
  openFile: (id) => invoke("open_file", { id }),
  openFileInTextEditor: (id) => invoke("open_file_in_text_editor", { id }),
  copyFileToClipboard: (id) => invoke("copy_file_to_clipboard", { id }),
  deleteFile: (id) => invoke("delete_file", { id }),
  listScanRules: () => invoke("list_scan_rules"),
  saveScanRules: (input) => invoke("save_scan_rules", { input }),
  listRagflowChats: () => invoke("list_ragflow_chats"),
  askRagflowChat: (input) => invoke("ask_ragflow_chat", { input }),
  listRagflowDatasets: () => invoke("list_ragflow_datasets"),
  listRagflowAgents: () => invoke("list_ragflow_agents"),
  queryRagflowKnowledge: (input) =>
    invoke("query_ragflow_knowledge", { input }),
  downloadRagflowDocument: (input) =>
    invoke("download_ragflow_document", { input }),
};
