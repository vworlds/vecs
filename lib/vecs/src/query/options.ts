import { type ComponentRef, type ComponentType } from "../component.js";
import { Entity } from "../entity/index.js";
import { Iter, type FanInjectTuple, type InjectTuple } from "../inject.js";

export type EntityCursorOption = {
  cursor?: typeof Entity;
};

export type IterCursorOption = {
  cursor: typeof Iter;
};

type CursorOption = EntityCursorOption | IterCursorOption;

type InjectOption<J extends InjectTuple> = {
  inject: readonly [...J];
};

type FanInjectOption<J extends FanInjectTuple> = {
  inject: readonly [...J];
};

type WatchOption<C extends ComponentType> = {
  watch: C;
};

type OnEnterUpdateOption = {
  onEnter?: boolean;
};

/** `optional` keeps the watch out of the predicate; `onRemove` needs it. */
type OptionalWatchOption =
  | {
      optional?: false;
      onRemove?: never;
    }
  | {
      optional: true;
      onRemove?: boolean;
    };

type RelationshipOption<R extends ComponentRef = ComponentRef> = {
  relationship: R;
};

export type InjectCallbackOptions<J extends InjectTuple> = CursorOption & InjectOption<J>;

export type FanInjectCallbackOptions<J extends FanInjectTuple> = CursorOption & FanInjectOption<J>;

export type UpdateCallbackOptions<C extends ComponentType, J extends InjectTuple> = CursorOption &
  WatchOption<C> &
  OnEnterUpdateOption &
  OptionalWatchOption &
  Partial<InjectOption<J>>;

export type OrderByOptions<J extends InjectTuple> = CursorOption & InjectOption<J>;

export type GroupByOptions<J extends FanInjectTuple> = FanInjectOption<J>;

export type CascadeOptions = RelationshipOption;
