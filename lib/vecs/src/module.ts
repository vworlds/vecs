import { Component } from "./component.js";
import { type World } from "./world.js";

export abstract class Module extends Component {
  constructor(world: World, eid: number) {
    super(world, eid);
  }
  public abstract init(): void;
}
