/** Serialize asynchronous work per key while allowing different keys to proceed independently. */
export default class KeyedAsyncQueue {
  readonly #tails = new Map<string, Promise<void>>();

  enqueue<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(run, run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    return result.finally(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
  }
}
