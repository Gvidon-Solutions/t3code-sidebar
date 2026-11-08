export interface NightlyOptions {
  readonly timeoutMs?: number;
  readonly directory: string;
  readonly command: readonly string[];
  readonly inboxCommand: readonly string[];
  readonly inboxBodyViaStdin?: boolean;
}
export interface NightlyResult {
  readonly state: "PASS" | "FAIL";
  readonly error: string | null;
  readonly log: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}
export function nightly(options: NightlyOptions): Promise<NightlyResult>;
