# Utilities

Public helper classes exported by `@vworlds/vecs` for code that lives around the ECS core.

## `Events`

Use `Events` when a vecs package or integration needs typed package-level events without adding an
external runtime dependency. It is not an entity lifecycle API; entity teardown is modeled through
component removal, hooks, query exits, and relationship cleanup.

```ts
import { Events } from "@vworlds/vecs";

type ClientEvents = {
  reset(event: { initial: boolean }): void;
};

const events = new Events<ClientEvents>();
events.on("reset", (event) => console.log(event.initial));
events.emit("reset", { initial: true });
```

## Reference

| Method                             | Description                                                                |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `on(event, fn, context?)`          | Register a listener.                                                       |
| `addListener(event, fn, ctx?)`     | Alias of `on`.                                                             |
| `once(event, fn, context?)`        | Register a listener that removes itself before its first call.             |
| `emit(event, ...args)`             | Invoke listeners and return `true` when at least one listener ran.         |
| `off(event, fn?, context?)`        | Remove one listener, or every listener for the event when `fn` is omitted. |
| `removeListener(event, fn?, ctx?)` | Alias of `off`.                                                            |
| `removeAllListeners(event?)`       | Remove listeners for one event, or all listeners when no event is given.   |
| `eventNames()`                     | Return event names with at least one listener.                             |
| `listeners(event)`                 | Return registered listener functions for an event.                         |
| `listenerCount(event)`             | Return the number of listeners registered for an event.                    |
