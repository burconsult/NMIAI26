export type VercelLogEntry = {
  timestamp: number;
  message: string;
  responseStatusCode?: number;
  requestPath?: string;
  deploymentId?: string;
};

export type RunLedgerRecord = {
  runId: string;
  promptFingerprint?: string;
  debugMode?: boolean;
  status: string;
  httpStatus: number;
  planner: string;
  promptText?: string;
  promptPreview?: string;
  verification?: {
    verified: boolean;
    detail: string;
    required: boolean;
  };
  spec?: {
    operation?: string;
    entity?: string;
  };
  attemptErrors?: string[];
};

export type ObservedRun = {
  runId: string;
  promptFingerprint?: string;
  debugMode?: boolean;
  timestamp?: number;
  durationMs?: number;
  deploymentId?: string;
  responseStatusCode?: number;
  promptPreview?: string;
  promptText?: string;
  promptLength?: number;
  fileCount?: number;
  planner?: string;
  status?: string;
  httpStatus?: number;
  verified?: boolean;
  verificationDetail?: string;
  entity?: string;
  operation?: string;
  attemptErrors: string[];
  sources: string[];
};

export type CompetitionResult = {
  taskLabel: string;
  solved: number;
  total: number;
  percent?: number;
  durationSeconds?: number;
  timestamp: number;
  rawBlock: string;
  submissionId?: string;
  status?: string;
};

export type CompetitionMatch = {
  result: CompetitionResult;
  runId?: string;
  family: FamilyId;
  promptPreview: string;
  responseStatusCode?: number;
  status?: string;
  verificationDetail?: string;
};

export type SandboxMatch = {
  file: string;
  excerpt: string;
};

export type FamilyId =
  | "employee_create"
  | "salary_transaction"
  | "customer_create"
  | "product_create"
  | "project_create"
  | "expense_voucher"
  | "accounting_dimension"
  | "returned_payment"
  | "invoice_reminder"
  | "project_cycle"
  | "ledger_variance_projects"
  | "ledger_error_correction"
  | "bank_reconciliation"
  | "month_end_closing"
  | "attachment_onboarding"
  | "project_time_invoice"
  | "supplier_invoice"
  | "invoice_payment"
  | "invoice_create"
  | "unknown";

export type FamilyInsight = {
  id: FamilyId;
  label: string;
  priority: "high" | "medium" | "low";
  nextAction: string;
  canaryNeeded: boolean;
  keywords: string[];
  openApiPatterns: RegExp[];
  sandboxKeywords: string[];
};

export type FeedbackReport = {
  generatedAt: string;
  domain: string;
  since: string;
  totalObservedRuns: number;
  failingRuns: number;
  competitionResults: number;
  families: Array<{
    family: FamilyId;
    label: string;
    count: number;
    sampleRunId: string;
    samplePrompt: string;
    priorities: string;
    nextAction: string;
    openApiEndpoints: string[];
    sandboxMatches: SandboxMatch[];
    canaryNeeded: boolean;
  }>;
  latestFailures: Array<{
    runId: string;
    responseStatusCode?: number;
    status?: string;
    family: FamilyId;
    promptPreview: string;
    verificationDetail?: string;
    attemptErrors: string[];
  }>;
  latestCompetitionMatches: CompetitionMatch[];
};
