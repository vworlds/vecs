/**
 * Strongly-typed wrapper around `eventemitter3`.
 *
 * The class declared in this file is purely a typings shim — at module load
 * its prototype is swapped out for `EventEmitter` from `eventemitter3` so the
 * concrete behavior is provided by that library, while consumers see typed
 * `on` / `emit` / `off` signatures driven by an `EventMap`.
 *
 * Inspired by the typings in `@yandeu/events`
 * (https://github.com/yandeu/events). The original typings turned out to be
 * usable directly on top of `eventemitter3`.
 *
 * @internal Used only inside the package, to expose typed entity-level events.
 */

import eventEmitter3 from "eventemitter3";
const { EventEmitter } = eventEmitter3;

declare type ValidEventMap<T = any> = T extends {
  [P in keyof T]: (...args: any[]) => void;
}
  ? T
  : never;

declare type Handler<T extends any | ((...args: any[]) => R), R = any> = T;

/** Listener signature inferred from an `EventMap` entry. */
export declare type EventListener<T extends ValidEventMap, K extends EventNames<T>> = T extends
  | string
  | symbol
  ? (...args: any[]) => void
  : K extends keyof T
    ? Handler<T[K], void>
    : never;

declare type EventArgs<T extends ValidEventMap, K extends EventNames<T>> = Parameters<
  EventListener<T, K>
>;

/** Names of the events declared on an `EventMap`. */
export declare type EventNames<T extends ValidEventMap> = T extends string | symbol ? T : keyof T;

/**
 * Typed event emitter shape. Replaced at runtime by `EventEmitter` from
 * `eventemitter3` (see the assignment below the class body).
 */
class events<EventMap extends ValidEventMap = any> {
  public on<T extends EventNames<EventMap>>(
    event: T,
    fn: EventListener<EventMap, T>,
    context?: any
  ): events<EventMap> {
    return 0 as any;
  }
  public emit<T extends EventNames<EventMap>>(event: T, ...args: EventArgs<EventMap, T>): boolean {
    return 0 as any;
  }
  public once<T extends EventNames<EventMap>>(
    event: T,
    fn: EventListener<EventMap, T>,
    context?: any
  ): events<EventMap> {
    return 0 as any;
  }
  public eventNames(): EventNames<EventMap>[] {
    return 0 as any;
  }
  public listeners(event: EventNames<EventMap>): any[] {
    return 0 as any;
  }
  public listenerCount(event: EventNames<EventMap>): any {
    return 0 as any;
  }
  public removeListener<T extends EventNames<EventMap>>(
    event: T,
    fn?: EventListener<EventMap, T>,
    context?: any,
    once?: boolean
  ): this {
    return 0 as any;
  }
  public removeAllListeners(event?: EventNames<EventMap>): this {
    return 0 as any;
  }
  public off<T extends EventNames<EventMap>>(
    event: T,
    fn?: EventListener<EventMap, T> | undefined,
    context?: any,
    once?: boolean | undefined
  ): events<EventMap> {
    return 0 as any;
  }
  public addListener<T extends EventNames<EventMap>>(
    event: T,
    fn: EventListener<EventMap, T>,
    context?: any
  ): events<EventMap> {
    return 0 as any;
  }
}

(events as any) = EventEmitter;

/**
 * Typed `EventEmitter` parameterised by an `EventMap` of `eventName -> handler`.
 *
 * Constructed lazily by `Entity.events`. Inherits its concrete behavior from
 * `eventemitter3`'s `EventEmitter`.
 *
 * @internal
 */
export class Events<EventMap extends ValidEventMap = any> extends events<EventMap> {}
