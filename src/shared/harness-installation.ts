export const DEEPSEEK_INSTALLATION_ID = "deepseek-dsh";

/** Detected software is not an executable Harness resource or authorization. */
export interface HarnessInstallation {
  id: "deepseek-dsh";
  provider: "deepseek";
  label: "DeepSeek Harness";
  path: string | null;
  version: string | null;
  status: "missing" | "unidentified" | "unassessed-version" | "execution-unsupported";
  authentication: "unknown";
  quota: "unknown";
  /** No account-scoped catalog was inspected; never use bundled defaults as entitlement. */
  models: string[];
  executionSupported: false;
  /** Admission-policy assessment only; never executable/profile verification. */
  executionPolicy?: {
    id: string;
    digest: string;
    status: "blocked";
    protocol: string;
    blockers: string[];
  };
}
