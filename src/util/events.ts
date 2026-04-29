/**
 * The following type declarations define an alternative typings interface for eventemitter3
 * Inspired by typings in @yandeu/events https://github.com/yandeu/events
 * Turns out those typings pretty much can be used directly on eventemitter3
 */

import eventEmitter3 from "eventemitter3";
const { EventEmitter } = eventEmitter3;

declare type ValidEventMap<T = any> = T extends {
  [P in keyof T]: (...args: any[]) => void;
}
  ? T
  : never;
declare type Handler<T extends any | ((...args: any[]) => R), R = any> = T;
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
export declare type EventNames<T extends ValidEventMap> = T extends string | symbol ? T : keyof T;
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
  removeAllListeners(event?: EventNames<EventMap>): this {
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

export class Events<EventMap extends ValidEventMap = any> extends events<EventMap> {}
