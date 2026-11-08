export interface Ownership {
  readonly machine: string;
  readonly boot: string;
  readonly uid: number;
  readonly pid: number;
  readonly start: string;
  readonly runId: string;
  readonly hostname: string;
  readonly cores: number;
}
export function defaultJobs(cores: number): number;
export function ownership(): Promise<Ownership>;
export function ownershipLabels(owner: Ownership): Record<string, string>;
export function labelArgs(owner: Ownership): string[];
export function recoverStale(current?: Ownership): Promise<{
  containers: { id: string; name: string; logs: string }[];
  networks: { id: string; name: string }[];
  interruptedRuns: string[];
}>;
export function assertHostLease(): Promise<void>;
