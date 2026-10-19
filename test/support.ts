/** The error `promise` rejects with; throws, failing the test, if it resolves instead. */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected the promise to reject, but it resolved");
}
