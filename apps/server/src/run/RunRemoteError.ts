export class RunRemoteError extends Error {
  readonly reason: "job_not_found" | undefined;
  constructor(message: string, reason?: "job_not_found") {
    super(message);
    this.name = "RunRemoteError";
    this.reason = reason;
  }
}
