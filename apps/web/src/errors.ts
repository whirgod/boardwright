/** Text to show a person for a failed request (an `ApiError` carries the server's message). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
