export type Unsubscribe = () => void;
export type Listener<T> = (payload: T) => void;

export interface Emitter<Events extends object> {
  on<E extends keyof Events>(event: E, listener: Listener<Events[E]>): Unsubscribe;
  emit<E extends keyof Events>(event: E, payload: Events[E]): void;
  clear(): void;
}

export interface EmitterOptions {
  /** Called when a listener throws. Defaults to re-throwing asynchronously so the error still surfaces. */
  onListenerError?: (error: unknown) => void;
}

function rethrowAsync(error: unknown) {
  queueMicrotask(() => {
    throw error;
  });
}

/**
 * Minimal typed event emitter for player implementations. A listener that
 * throws does not prevent the remaining listeners from running.
 */
export function createEmitter<Events extends object>({
  onListenerError = rethrowAsync,
}: EmitterOptions = {}): Emitter<Events> {
  const listeners = new Map<keyof Events, Set<Listener<never>>>();

  return {
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    emit(event, payload) {
      const set = listeners.get(event) as Set<Listener<typeof payload>> | undefined;
      if (!set) return;
      for (const listener of [...set]) {
        try {
          listener(payload);
        } catch (error) {
          onListenerError(error);
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}
