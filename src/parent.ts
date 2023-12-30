import { ComponentSnapshot } from "@vworlds/protocol";
import { Component } from "./component.js";
import { Type } from "../types.js";

export class Parent extends Component {
  public pid: number = 0;
  public override updateFromSnapshot(state: ComponentSnapshot): void {
    this.pid = state.uint32_a;
  }
}
