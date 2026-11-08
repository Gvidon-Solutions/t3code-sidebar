/**
 * A short, human sentence for a failure. Effect tagged errors are Error
 * instances whose message is already plain; never stringify the tag or a
 * whole cause chain into UI copy.
 */
export function plainErrorMessage(
  error: unknown,
  fallback = "Something went wrong. Try again.",
): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return fallback;
}
