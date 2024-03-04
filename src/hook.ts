import { Component } from "./component.js";
import { Entity } from "./entity.js";

export class Hook<C extends Component = Component> {
  private onAddHandler: ((c: C) => void) | undefined;
  private onRemoveHandler: ((c: C) => void) | undefined;
  private onSetHandler: ((c: C) => void) | undefined;

  public onAdd(handler: (c: C) => void): Hook<C> {
    this.onAddHandler = handler;
    return this;
  }

  public onRemove(handler: (c: C) => void): Hook<C> {
    this.onRemoveHandler = handler;
    return this;
  }

  public onSet(handler: (c: C) => void): Hook<C> {
    this.onSetHandler = handler;
    return this;
  }
}
