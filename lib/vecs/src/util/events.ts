/**
 * Minimal, strongly-typed event emitter.
 *
 * Provides the small subset of the `EventEmitter` API vecs packages need —
 * `on` / `addListener`, `once`, `off` / `removeListener`,
 * `removeAllListeners`, `emit`, `eventNames`, `listeners`, and
 * `listenerCount` — with `on` / `emit` / `off` signatures driven by an
 * `EventMap`.
 *
 * Use this for package-level events that need typed `on` and `emit` calls
 * without adding an external runtime dependency.
 */

declare type ValidEventMap<T = any> = T extends {
  [P in keyof T]: (...args: any[]) => void;
}
  ? T
  : never;

/** Listener signature inferred from an `EventMap` entry. */
export declare type EventListener<
  T extends ValidEventMap,
  K extends EventNames<T>,
> = K extends keyof T
  ? T[K] extends (...args: any[]) => void
    ? T[K]
    : never
  : (...args: any[]) => void;

declare type EventArgs<T extends ValidEventMap, K extends EventNames<T>> = Parameters<
  EventListener<T, K>
>;

/** Names of the events declared on an `EventMap`. */
export declare type EventNames<T extends ValidEventMap> = T extends string | symbol ? T : keyof T;

/** A registered listener together with its optional invocation context. */
interface Registration {
  /** The function to invoke (may be a `once` wrapper). */
  fn: (...args: any[]) => void;
  /** The originally registered function, used to match `off`/`removeListener` calls. */
  original: (...args: any[]) => void;
  context?: any;
}

/**
 * Typed `EventEmitter` parameterised by an `EventMap` of `eventName -> handler`.
 *
 * Use for package-level events that need typed event names and payloads.
 */
export class Events<EventMap extends ValidEventMap = any> {
  private _listeners = new Map<EventNames<EventMap>, Registration[]>();

  /** Alias of {@link on}. */
  public addListener<T extends EventNames<EventMap>>(
    event: T,
    fn: EventListener<EventMap, T>,
    context?: any
  ): this {
    return this.on(event, fn, context);
  }

  /** Calls every listener registered for `event` with `args`, returning whether any listener ran. */
  public emit<T extends EventNames<EventMap>>(event: T, ...args: EventArgs<EventMap, T>): boolean {
    const registrations = this._listeners.get(event);
    if (!registrations || registrations.length === 0) {
      return false;
    }
    for (const { fn, context } of registrations.slice()) {
      fn.apply(context, args);
    }
    return true;
  }

  /** Names of the events with at least one registered listener. */
  public eventNames(): EventNames<EventMap>[] {
    return [...this._listeners.keys()];
  }

  /** Number of listeners registered for `event`. */
  public listenerCount(event: EventNames<EventMap>): number {
    return this._listeners.get(event)?.length ?? 0;
  }

  /** Listener functions registered for `event`. */
  public listeners(event: EventNames<EventMap>): ((...args: any[]) => void)[] {
    return (this._listeners.get(event) ?? []).map((r) => r.fn);
  }

  /** Removes a listener registered for `event`, or every listener for `event` when `fn` is omitted. */
  public off<T extends EventNames<EventMap>>(
    event: T,
    fn?: EventListener<EventMap, T>,
    context?: any
  ): this {
    return this.removeListener(event, fn, context);
  }

  /** Registers `fn` to be called every time `event` is emitted. */
  public on<T extends EventNames<EventMap>>(
    event: T,
    fn: EventListener<EventMap, T>,
    context?: any
  ): this {
    return this._add(
      event,
      fn as (...args: any[]) => void,
      fn as (...args: any[]) => void,
      context
    );
  }

  /** Registers `fn` to be called the next time `event` is emitted, then removes it. */
  public once<T extends EventNames<EventMap>>(
    event: T,
    fn: EventListener<EventMap, T>,
    context?: any
  ): this {
    const original = fn as (...args: any[]) => void;
    const wrapper = (...args: any[]): void => {
      this.removeListener(event, wrapper as EventListener<EventMap, T>);
      original.apply(context, args);
    };
    return this._add(event, wrapper, original, context);
  }

  /** Removes all listeners, or all listeners for `event` when given. */
  public removeAllListeners(event?: EventNames<EventMap>): this {
    if (event === undefined) {
      this._listeners.clear();
    } else {
      this._listeners.delete(event);
    }
    return this;
  }

  /** Alias of {@link off}. */
  public removeListener<T extends EventNames<EventMap>>(
    event: T,
    fn?: EventListener<EventMap, T>,
    context?: any
  ): this {
    if (fn === undefined) {
      this._listeners.delete(event);
      return this;
    }
    const registrations = this._listeners.get(event);
    if (!registrations) {
      return this;
    }
    const remaining = registrations.filter((r) => !this._matches(r, fn, context));
    if (remaining.length === 0) {
      this._listeners.delete(event);
    } else {
      this._listeners.set(event, remaining);
    }
    return this;
  }

  /** Registers a listener, storing both the callable (`fn`) and the function used for `off` matching (`original`). */
  private _add<T extends EventNames<EventMap>>(
    event: T,
    fn: (...args: any[]) => void,
    original: (...args: any[]) => void,
    context: any
  ): this {
    const registrations = this._listeners.get(event);
    const registration: Registration = { fn, original, context };
    if (registrations) {
      registrations.push(registration);
    } else {
      this._listeners.set(event, [registration]);
    }
    return this;
  }

  /** Whether `registration` was registered with `fn` (directly or as a `once` original) and, if given, `context`. */
  private _matches(
    registration: Registration,
    fn: (...args: any[]) => void,
    context: any
  ): boolean {
    if (registration.original !== fn && registration.fn !== fn) {
      return false;
    }
    return context === undefined || registration.context === context;
  }
}
