import { type ComponentRef, type ComponentType } from "../component.js";
import { Entity } from "../entity/index.js";
import { Iter, type FanInjectTuple, type InjectTuple } from "../inject.js";

export type EntityCursorOption = {
  cursor?: typeof Entity;
};

export type IterCursorOption = {
  cursor: typeof Iter;
};

export type CursorOption = EntityCursorOption | IterCursorOption;

export type InjectOption<J extends InjectTuple> = {
  inject: readonly [...J];
};

export type FanInjectOption<J extends FanInjectTuple> = {
  inject: readonly [...J];
};

export type ComponentOption<C extends ComponentType> = {
  component: C;
};

export type RelationshipOption<R extends ComponentRef = ComponentRef> = {
  relationship: R;
};

export type InjectCallbackOptions<J extends InjectTuple> = CursorOption & InjectOption<J>;

export type FanInjectCallbackOptions<J extends FanInjectTuple> = CursorOption & FanInjectOption<J>;

export type UpdateCallbackOptions<C extends ComponentType, J extends InjectTuple> = CursorOption &
  ComponentOption<C> &
  Partial<InjectOption<J>>;

export type OrderByOptions<J extends InjectTuple> = CursorOption & InjectOption<J>;

export type GroupByOptions<J extends FanInjectTuple> = FanInjectOption<J>;

export type CascadeOptions = RelationshipOption;
