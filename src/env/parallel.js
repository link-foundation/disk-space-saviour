/** Finite worker pool; settle all in-flight work before propagating failure. */
export async function mapLimit(values, limit, operation) {
  const results = new Array(values.length);
  let cursor = 0;
  let failure;
  const worker = async () => {
    while (!failure && cursor < values.length) {
      const index = cursor++;
      try {
        results[index] = await operation(values[index], index);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, worker)
  );
  if (failure) {
    throw failure;
  }
  return results;
}
