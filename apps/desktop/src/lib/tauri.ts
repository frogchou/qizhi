import type {
  MaskedServiceConfig,
  ServiceConfigurationInput,
} from "./contracts";
import { Channel, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export interface QizhiCommands {
  getCodexStatus?(): Promise<CodexRuntimeStatus>;
  refreshCodexStatus?(): Promise<CodexRuntimeStatus>;
  listCodexModels?(): Promise<CodexModelOption[]>;
  getCodexPreferences?(): Promise<CodexPreferences>;
  saveCodexPreferences?(
    model: string,
    reasoningEffort: string,
  ): Promise<CodexPreferences>;
  listCodexProjects?(includeArchived?: boolean): Promise<CodexProject[]>;
  createCodexProject?(input: {
    name: string;
    goal?: string | null;
  }): Promise<CodexProject>;
  renameCodexProject?(input: { id: string; name: string }): Promise<void>;
  archiveCodexProject?(projectId: string): Promise<void>;
  listCodexConversations?(projectId: string): Promise<CodexConversation[]>;
  createCodexConversation?(input: {
    projectId: string;
    title: string;
  }): Promise<CodexConversation>;
  renameCodexConversation?(input: { id: string; name: string }): Promise<void>;
  archiveCodexConversation?(conversationId: string): Promise<void>;
  readCodexConversation?(
    conversationId: string,
  ): Promise<CodexConversationHistory>;
  pickCodexMaterials?(): Promise<string[]>;
  listCodexMaterials?(projectId: string): Promise<CodexMaterial[]>;
  inspectCodexMaterialSources?(
    projectId: string,
  ): Promise<CodexMaterialSourceStatus[]>;
  refreshCodexMaterial?(
    projectId: string,
    materialId: string,
  ): Promise<CodexMaterial[]>;
  revealCodexMaterialSource?(
    projectId: string,
    materialId: string,
  ): Promise<void>;
  importCodexMaterials?(input: {
    projectId: string;
    paths: string[];
    confirmLargeFiles?: boolean;
  }): Promise<CodexMaterial[]>;
  removeCodexMaterial?(
    projectId: string,
    materialId: string,
  ): Promise<CodexMaterial[]>;
  listCodexArtifacts?(projectId: string): Promise<CodexArtifact[]>;
  listCodexArtifactUploads?(artifactId: string): Promise<CodexArtifactUpload[]>;
  uploadCodexArtifact?(input: {
    artifactId: string;
    datasetId: string;
    parentPath: string | null;
    startParsing: boolean;
    confirmDuplicate: boolean;
  }): Promise<CodexArtifactUpload>;
  openCodexArtifact?(projectId: string, relativePath: string): Promise<void>;
  revealCodexArtifact?(projectId: string, relativePath: string): Promise<void>;
  exportCodexArtifact?(projectId: string, relativePath: string): Promise<void>;
  startCodexTurn?(
    input: StartCodexTurnInput,
    onEvent: (event: CodexTurnEvent) => void,
  ): Promise<CodexTurnResult>;
  interruptCodexTurn?(projectId: string): Promise<void>;
  resolveCodexApproval?(
    requestId: string,
    decision: CodexApprovalDecision,
  ): Promise<void>;
  prepareCodexHandoff?(input: {
    source: CodexHandoffSourceInput;
  }): Promise<CodexHandoffPreview>;
  commitCodexHandoff?(
    input: CommitCodexHandoffInput,
  ): Promise<CodexHandoffResult>;
  listPendingCodexHandoffs?(
    conversationId: string,
  ): Promise<CodexHandoffDetails[]>;
  dismissCodexHandoffItem?(input: {
    handoffId: string;
    materialId: string;
  }): Promise<void>;
  getSettings(): Promise<MaskedServiceConfig[]>;
  saveSettings(input: ServiceConfigurationInput): Promise<MaskedServiceConfig>;
  testServiceConnection(
    input: ServiceConfigurationInput,
  ): Promise<ConnectionStatus>;
  pickFolder(): Promise<string | null>;
  getNtfsIndexerStatus?(): Promise<ConnectionStatus>;
  getTodaySnapshot(): Promise<TodaySnapshot>;
  getRecentSnapshot?(days: number): Promise<TodaySnapshot>;
  getTodayScanStatus?(): Promise<TodayScanStatus>;
  refreshToday(): Promise<TodaySnapshot>;
  evaluateTodayFiles?(fileIds: number[]): Promise<FileValueResult[]>;
  queryTodayWorkspace?(input: WorkspaceQueryInput): Promise<WorkspacePage>;
  expandTodayWorkspace?(
    queryId: string,
    directoryId: string,
    cursor: number,
  ): Promise<WorkspacePage>;
  resolveTodayWorkspaceSelection?(
    input: WorkspaceSelectionInput,
  ): Promise<WorkspaceSelectionOutput>;
  openTodayWorkspaceDirectory?(
    queryId: string,
    directoryId: string,
  ): Promise<void>;
  evaluateWorkspaceQuery?(
    queryId: string,
    scope: "today" | "recent",
  ): Promise<WorkspaceEvaluationOutput>;
  getJevValuePolicy?(): Promise<JevValuePolicy>;
  saveJevValuePolicy?(input: JevValuePolicy): Promise<JevValuePolicy>;
  getSummarySettings?(): Promise<SummarySettings>;
  saveSummarySettings?(input: SummarySettingsInput): Promise<SummarySettings>;
  prepareWorkSummary?(
    input: WorkSummarySelectionInput,
  ): Promise<WorkSummaryPreparation>;
  generateWorkSummary?(
    input: {
      fileIds: number[];
      templateId: number;
      queryId?: string | null;
      directoryIds?: string[];
      confirmedMultiBatch?: boolean;
    },
    onEvent?: (event: WorkSummaryStreamEvent) => void,
  ): Promise<WorkSummary>;
  pickSummarySavePath?(defaultName: string): Promise<string | null>;
  saveSummaryMarkdown?(input: {
    content: string;
    path: string;
  }): Promise<{ savedPath: string }>;
  uploadSummaryMarkdown?(input: {
    content: string;
    filename: string;
    datasetId: string;
    parentPath: string | null;
    startParsing: boolean;
  }): Promise<RagflowUpload>;
  revealInExplorer(id: number): Promise<void>;
  openFile(id: number): Promise<void>;
  openFileInTextEditor(id: number): Promise<void>;
  copyFileToClipboard(id: number): Promise<void>;
  deleteFile(id: number): Promise<void>;
  excludeFileDirectory?(id: number): Promise<TodaySnapshot>;
  listScanRules(): Promise<ScanRules>;
  saveScanRules(
    input: Pick<
      ScanRules,
      | "allowedRoots"
      | "customExclusions"
      | "fileCategories"
      | "directoryGroupThreshold"
    >,
  ): Promise<ScanRules>;
  listRagflowChats?(): Promise<RagflowChat[]>;
  askRagflowChat?(input: {
    chatId: string;
    question: string;
  }): Promise<RagflowAnswer>;
  listRagflowDatasets?(): Promise<RagflowDataset[]>;
  listRagflowAgents?(): Promise<RagflowAgent[]>;
  queryRagflowKnowledge?(
    input: {
      question: string;
      datasetIds: string[];
      agentIds: string[];
      agentSessions?: Record<string, string>;
    },
    onEvent?: (event: KnowledgeQueryStreamEvent) => void,
  ): Promise<RagflowKnowledgeQuery>;
  downloadRagflowDocument?(input: {
    datasetId: string;
    documentId: string;
    savePath: string;
  }): Promise<{ savedPath: string }>;
  uploadTodayFile?(input: {
    fileId: number;
    datasetId: string;
    parentPath: string | null;
    startParsing: boolean;
  }): Promise<RagflowUpload>;
}

export type ConnectionStatus = { available: boolean; message: string };

export type CodexRuntimeStatus = {
  installation: string;
  version: string | null;
  account: string;
  sandbox: string;
  server: string;
};
export type CodexPreferences = { model: string; reasoningEffort: string };
export type CodexModelOption = {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: string[];
};
export type CodexProject = {
  id: string;
  name: string;
  goal: string | null;
  rootPath: string;
  status: string;
  createdAtUtcMs: number;
  updatedAtUtcMs: number;
  lastOpenedAtUtcMs: number;
};
export type CodexConversation = {
  id: string;
  projectId: string;
  title: string;
  codexThreadId: string | null;
  codexSessionId: string | null;
  status: string;
  createdAtUtcMs: number;
  updatedAtUtcMs: number;
  archivedAtUtcMs: number | null;
};
export type CodexMessage = {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  markdown: string;
  status: string;
  createdAtUtcMs: number;
};
export type CodexProcessItem = {
  id: string;
  turnId: string;
  codexItemId: string;
  kind: string;
  title: string;
  safeSummary: string;
  status: string;
};
export type CodexTurnHistory = {
  id: string;
  conversationId: string;
  codexTurnId: string | null;
  userText: string;
  status: string;
  startedAtUtcMs: number;
  completedAtUtcMs: number | null;
  errorSummary: string | null;
  messages: CodexMessage[];
  processItems: CodexProcessItem[];
};
export type CodexConversationHistory = {
  conversation: CodexConversation;
  turns: CodexTurnHistory[];
};
export type CodexMaterial = {
  id: string;
  projectId: string;
  kind: string;
  displayName: string;
  originReference: string | null;
  sourceMetadataJson: string | null;
  currentVersionId: string | null;
  snapshotState: string;
  importedAtUtcMs: number;
};
export type CodexMaterialSourceStatus = {
  materialId: string;
  state: string;
  sourceLabel: string;
  refreshable: boolean;
  revealable: boolean;
};
export type CodexArtifact = {
  id: string;
  projectId: string;
  relativePath: string;
  contentHash: string;
  sizeBytes: number;
  mimeType: string;
  createdByConversationId: string | null;
  createdByTurnId: string | null;
  detectedAtUtcMs: number;
  state: string;
};
export type CodexArtifactUpload = {
  id: string;
  artifactId: string;
  datasetId: string;
  parentPath: string | null;
  contentHash: string;
  documentIdsJson: string | null;
  status: string;
  startParsing: boolean;
  createdAtUtcMs: number;
  completedAtUtcMs: number | null;
  errorSummary: string | null;
};
export type StartCodexTurnInput = {
  projectId: string;
  conversationId: string;
  prompt: string;
  model?: string | null;
  reasoningEffort?: string | null;
  handoffIds?: string[];
};
export type CodexRagflowChunkInput = {
  chunkId: string;
  content: string;
  documentName: string;
  documentId: string;
  datasetId: string;
  similarity: number;
  retrievedAtUtcMs: number;
};
export type CodexRagflowDocumentInput = {
  datasetId: string;
  documentId: string;
  documentName: string;
  retrievedAtUtcMs: number;
};
export type CodexRagflowReferenceInput = CodexRagflowChunkInput & {
  citationId: string;
};
export type CodexRagflowAnswerInput = {
  question: string;
  agentId: string;
  agentName: string;
  finalAnswer: string;
  retrievedAtUtcMs: number;
  references: CodexRagflowReferenceInput[];
};
export type CodexHandoffSourceInput =
  | {
      kind: "today" | "recent";
      queryId: string;
      fileIds: number[];
      directoryIds: string[];
    }
  | {
      kind: "ragflowChunks";
      question: string;
      chunks: CodexRagflowChunkInput[];
    }
  | {
      kind: "ragflowDocuments";
      selectionToken: string;
      documents: CodexRagflowDocumentInput[];
    }
  | { kind: "ragflowAnswer"; answer: CodexRagflowAnswerInput };
export type CodexHandoffPreviewItem = {
  fileId: number;
  displayName: string;
  sizeBytes: number;
};
export type CodexHandoffPreview = {
  preparationId: string;
  sourceKind: string;
  fileCount: number;
  totalSizeBytes: number;
  previewItems: CodexHandoffPreviewItem[];
  blockedItems: CodexHandoffPreviewItem[];
  warningItems: CodexHandoffPreviewItem[];
  requiresLargeFileConfirmation: boolean;
};
export type CommitCodexHandoffInput = {
  sourceKind: string;
  preparationId: string;
  requestId: string;
  projectId: string;
  conversationId: string;
  confirmLargeFiles: boolean;
  confirmOriginalOnly: boolean;
};
export type CodexHandoffResult = {
  handoffId: string;
  projectId: string;
  conversationId: string;
  itemCount: number;
  status: string;
};
export type CodexHandoffItem = {
  id: string;
  handoffId: string;
  materialId: string;
  materialVersionId: string;
  displayName: string;
  sourceMetadataJson: string;
  displayOrder: number;
  state: string;
};
export type CodexHandoffDetails = {
  handoff: {
    id: string;
    requestId: string;
    sourceKind: string;
    projectId: string;
    conversationId: string;
    status: string;
    createdAtUtcMs: number;
    consumedAtUtcMs: number | null;
    errorSummary: string | null;
  };
  items: CodexHandoffItem[];
};
export type CodexTurnResult = {
  localTurnId: string;
  codexTurnId: string;
  threadId: string;
};
export type CodexApprovalDecision =
  "accept" | "acceptForSession" | "decline" | "cancel";
export type CodexTurnEvent =
  | {
      type: "started";
      projectId: string;
      conversationId: string;
      localTurnId: string;
      codexTurnId: string;
    }
  | { type: "messageDelta"; localTurnId: string; delta: string }
  | {
      type: "processItem";
      localTurnId: string;
      itemId: string;
      kind: string;
      title: string;
      summary: string;
      status: string;
    }
  | {
      type: "approvalRequested";
      localTurnId: string;
      requestId: string;
      itemId: string;
      actionType: string;
      targetSummary: string;
    }
  | {
      type: "completed";
      localTurnId: string;
      status: string;
      error: string | null;
      artifacts: CodexArtifact[];
    };

export type TodayFile = {
  id: number;
  canonicalPath: string;
  modifiedAtUtcMs: number;
  sizeBytes: number;
  source: string;
  status: "待分析" | "有价值" | "低价值" | "无法解析" | "评估失败";
  score?: number | null;
};

export type FileValueResult = {
  fileId: number;
  status: TodayFile["status"];
  score: number | null;
  confidence: number | null;
  message: string | null;
};

export type WorkspaceCategory = "all" | "documents" | "sourceCode";
export type WorkspaceSort =
  "nameAsc" | "nameDesc" | "timeAsc" | "timeDesc" | "typeAsc" | "typeDesc";
export type WorkspaceQueryInput = {
  scope: "today" | "recent";
  days: number | null;
  category: WorkspaceCategory;
  search: string;
  sort: WorkspaceSort;
};
export type WorkspaceValueSummary = {
  valuable: number;
  notValuable: number;
  pending: number;
  failed: number;
  unsupported: number;
};
export type WorkspaceEntry = {
  id: string;
  kind: "directory" | "file";
  name: string;
  canonicalPath: string;
  fileId: number | null;
  modifiedAtUtcMs: number;
  sizeBytes: number;
  source: string;
  fileCount: number;
  childDirectoryCount: number;
  hasChildren: boolean;
  valueSummary: WorkspaceValueSummary;
};
export type WorkspacePage = {
  queryId: string;
  entries: WorkspaceEntry[];
  totalFileCount: number;
  nextCursor: number | null;
};
export type WorkspaceSelectionInput = {
  queryId: string;
  fileIds: number[];
  directoryIds: string[];
};
export type WorkspaceSelectionOutput = {
  fileIds: number[];
  fileCount: number;
  batchCount: number;
};
export type WorkspaceEvaluationOutput = {
  evaluated: number;
  valuable: number;
  notValuable: number;
  failed: number;
  unsupported: number;
  failureMessage: string | null;
};

export type JevValuePolicy = {
  instructions: string;
  criteria: string[];
  valuableThreshold: number;
};

export type SummaryPromptTemplate = {
  id: number;
  title: string;
  prompt: string;
  sortOrder: number;
  isDefault: boolean;
};
export type SummaryPromptTemplateInput = Omit<SummaryPromptTemplate, "id"> & {
  id: number | null;
};
export type SummarySettings = {
  model: string;
  templates: SummaryPromptTemplate[];
};
export type SummarySettingsInput = {
  model: string;
  templates: SummaryPromptTemplateInput[];
};
export type WorkSummary = {
  markdown: string;
  truncated: boolean;
  fileCount: number;
  templateTitle: string;
};
export type WorkSummarySelectionInput = {
  queryId: string | null;
  fileIds: number[];
  directoryIds: string[];
};
export type WorkSummaryPreparation = {
  fileCount: number;
  batchCount: number;
  requiresConfirmation: boolean;
};

export type WorkSummaryStreamEvent =
  | { kind: "started"; templateTitle: string; fileCount: number }
  | { kind: "delta"; delta: string }
  | {
      kind: "batchProgress";
      current: number;
      total: number;
      phase: "summarizing" | "synthesizing" | string;
    }
  | { kind: "completed"; truncated: boolean };

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
  directoryGroupThreshold: number;
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
export type RagflowAgentReference = {
  citationId: string;
  chunkId: string;
  content: string;
  documentName: string;
  documentId: string;
  datasetId: string;
  similarity: number;
  docType: string;
  positions: unknown;
  documentMetadata: unknown;
  url: string;
};
export type RagflowAgentSource = {
  documentName: string;
  documentId: string;
  datasetId: string;
  citationCount: number;
};
export type RagflowAgentResult = {
  agentId: string;
  answer: string | null;
  error: string | null;
  sessionId?: string | null;
  sessionInvalid?: boolean;
  steps?: RagflowAgentStep[];
  references?: RagflowAgentReference[];
  sources?: RagflowAgentSource[];
};
export type RagflowAgentStep = {
  title: string;
  nodeType: string;
  status: string;
  elapsedMs: number | null;
  error: string | null;
};
export type RagflowKnowledgeQuery = {
  selectionToken?: string;
  chunks: RagflowChunk[];
  retrievalError?: string | null;
  agentResults: RagflowAgentResult[];
};
export type KnowledgeQueryStreamEvent =
  | { kind: "retrievalStarted" }
  | { kind: "retrievalCompleted"; chunks: RagflowChunk[] }
  | { kind: "retrievalFailed"; error: string }
  | { kind: "agentStarted"; agentId: string }
  | { kind: "agentAnswerReset"; agentId: string; messageId: string }
  | { kind: "agentDelta"; agentId: string; delta: string }
  | { kind: "agentThinking"; agentId: string; active: boolean }
  | { kind: "agentStep"; agentId: string; step: RagflowAgentStep }
  | {
      kind: "agentReferences";
      agentId: string;
      references: RagflowAgentReference[];
      sources: RagflowAgentSource[];
    }
  | { kind: "agentCompleted"; agentId: string; sessionId: string | null }
  | {
      kind: "agentFailed";
      agentId: string;
      error: string;
      sessionInvalid: boolean;
    }
  | { kind: "completed" };
export type RagflowUpload = {
  documentIds: string[];
  documentCount: number;
  parsingStarted: boolean;
  parsingError: string | null;
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
      remediation: "桌面服务尚未连接，无法读取本地 NTFS 索引。",
      files: [],
      clusters: [],
    };
  },
  async getRecentSnapshot() {
    return this.getTodaySnapshot();
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
  async excludeFileDirectory() {
    return this.getTodaySnapshot();
  },
  async listScanRules() {
    return {
      allowedRoots: [],
      customExclusions: [],
      fileCategories: ["documents", "sourceCode"],
      directoryGroupThreshold: 5,
      lockedExclusions: [],
    };
  },
  async saveScanRules() {
    throw new Error("桌面服务尚未连接");
  },
  async uploadTodayFile() {
    throw new Error("桌面服务尚未连接");
  },
};

export const tauriCommands: QizhiCommands = {
  getCodexStatus: () => invoke("get_codex_status"),
  refreshCodexStatus: () => invoke("refresh_codex_status"),
  listCodexModels: () => invoke("list_codex_models"),
  getCodexPreferences: () => invoke("get_codex_preferences"),
  saveCodexPreferences: (model, reasoningEffort) =>
    invoke("save_codex_preferences", { model, reasoningEffort }),
  listCodexProjects: (includeArchived = false) =>
    invoke("list_codex_projects", { includeArchived }),
  createCodexProject: (input) => invoke("create_codex_project", { input }),
  renameCodexProject: (input) => invoke("rename_codex_project", { input }),
  archiveCodexProject: (projectId) =>
    invoke("archive_codex_project", { projectId }),
  listCodexConversations: (projectId) =>
    invoke("list_codex_conversations", { projectId }),
  createCodexConversation: (input) =>
    invoke("create_codex_conversation", { input }),
  renameCodexConversation: (input) =>
    invoke("rename_codex_conversation", { input }),
  archiveCodexConversation: (conversationId) =>
    invoke("archive_codex_conversation", { conversationId }),
  readCodexConversation: (conversationId) =>
    invoke("read_codex_conversation", { conversationId }),
  pickCodexMaterials: async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      title: "选择项目资料",
    });
    return Array.isArray(selected)
      ? selected
      : typeof selected === "string"
        ? [selected]
        : [];
  },
  listCodexMaterials: (projectId) =>
    invoke("list_codex_materials", { projectId }),
  inspectCodexMaterialSources: (projectId) =>
    invoke("inspect_codex_material_sources", { projectId }),
  refreshCodexMaterial: (projectId, materialId) =>
    invoke("refresh_codex_material", { projectId, materialId }),
  revealCodexMaterialSource: (projectId, materialId) =>
    invoke("reveal_codex_material_source", { projectId, materialId }),
  importCodexMaterials: (input) => invoke("import_codex_materials", { input }),
  removeCodexMaterial: (projectId, materialId) =>
    invoke("remove_codex_material", { projectId, materialId }),
  listCodexArtifacts: (projectId) =>
    invoke("list_codex_artifacts", { projectId }),
  listCodexArtifactUploads: (artifactId) =>
    invoke("list_codex_artifact_uploads", { artifactId }),
  uploadCodexArtifact: (input) => invoke("upload_codex_artifact", { input }),
  openCodexArtifact: (projectId, relativePath) =>
    invoke("open_codex_artifact", { projectId, relativePath }),
  revealCodexArtifact: (projectId, relativePath) =>
    invoke("reveal_codex_artifact", { projectId, relativePath }),
  exportCodexArtifact: async (projectId, relativePath) => {
    const selected = await save({
      title: "导出 Codex 生成物",
      defaultPath: relativePath.split(/[\\/]/).pop() ?? "artifact",
    });
    if (typeof selected === "string")
      await invoke("export_codex_artifact", {
        projectId,
        relativePath,
        destination: selected,
      });
  },
  startCodexTurn: (input, onEvent) => {
    const channel = new Channel<CodexTurnEvent>();
    channel.onmessage = onEvent;
    return invoke("start_codex_turn", { input, onEvent: channel });
  },
  interruptCodexTurn: (projectId) =>
    invoke("interrupt_codex_turn", { projectId }),
  resolveCodexApproval: (requestId, decision) =>
    invoke("resolve_codex_approval", { requestId, decision }),
  prepareCodexHandoff: (input) => invoke("prepare_codex_handoff", { input }),
  commitCodexHandoff: (input) => invoke("commit_codex_handoff", { input }),
  listPendingCodexHandoffs: (conversationId) =>
    invoke("list_pending_codex_handoffs", { conversationId }),
  dismissCodexHandoffItem: (input) =>
    invoke("dismiss_codex_handoff_item", { input }),
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
  getNtfsIndexerStatus: () => invoke("get_ntfs_indexer_status"),
  getTodaySnapshot: () => invoke("get_today_snapshot"),
  getRecentSnapshot: (days) => invoke("get_recent_snapshot", { days }),
  getTodayScanStatus: () => invoke("get_today_scan_status"),
  refreshToday: () => invoke("refresh_today"),
  evaluateTodayFiles: (fileIds) => invoke("evaluate_today_files", { fileIds }),
  queryTodayWorkspace: (input) => invoke("query_today_workspace", { input }),
  expandTodayWorkspace: (queryId, directoryId, cursor) =>
    invoke("expand_today_workspace", { queryId, directoryId, cursor }),
  resolveTodayWorkspaceSelection: (input) =>
    invoke("resolve_today_workspace_selection", { input }),
  openTodayWorkspaceDirectory: (queryId, directoryId) =>
    invoke("open_today_workspace_directory", { queryId, directoryId }),
  evaluateWorkspaceQuery: (queryId, scope) =>
    invoke("evaluate_workspace_query", { queryId, scope }),
  getJevValuePolicy: () => invoke("get_jev_value_policy"),
  saveJevValuePolicy: (input) => invoke("save_jev_value_policy", { input }),
  getSummarySettings: () => invoke("get_summary_settings"),
  saveSummarySettings: (input) => invoke("save_summary_settings", { input }),
  prepareWorkSummary: (input) => invoke("prepare_work_summary", { input }),
  generateWorkSummary: (input, onEvent) => {
    const channel = new Channel<WorkSummaryStreamEvent>();
    if (onEvent) channel.onmessage = onEvent;
    return invoke("generate_work_summary", { input, onEvent: channel });
  },
  pickSummarySavePath: async (defaultName) => {
    const selected = await save({
      title: "另存今日总结",
      defaultPath: defaultName,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    return typeof selected === "string" ? selected : null;
  },
  saveSummaryMarkdown: (input) => invoke("save_summary_markdown", { input }),
  uploadSummaryMarkdown: (input) =>
    invoke("upload_summary_markdown", { input }),
  revealInExplorer: (id) => invoke("reveal_in_explorer", { id }),
  openFile: (id) => invoke("open_file", { id }),
  openFileInTextEditor: (id) => invoke("open_file_in_text_editor", { id }),
  copyFileToClipboard: (id) => invoke("copy_file_to_clipboard", { id }),
  deleteFile: (id) => invoke("delete_file", { id }),
  excludeFileDirectory: (id) => invoke("exclude_file_directory", { id }),
  listScanRules: () => invoke("list_scan_rules"),
  saveScanRules: (input) => invoke("save_scan_rules", { input }),
  listRagflowChats: () => invoke("list_ragflow_chats"),
  askRagflowChat: (input) => invoke("ask_ragflow_chat", { input }),
  listRagflowDatasets: () => invoke("list_ragflow_datasets"),
  listRagflowAgents: () => invoke("list_ragflow_agents"),
  queryRagflowKnowledge: (input, onEvent) => {
    const channel = new Channel<KnowledgeQueryStreamEvent>();
    if (onEvent) channel.onmessage = onEvent;
    return invoke("query_ragflow_knowledge", { input, onEvent: channel });
  },
  downloadRagflowDocument: (input) =>
    invoke("download_ragflow_document", { input }),
  uploadTodayFile: (input) => invoke("upload_today_file", { input }),
};
