import { Component } from "./component.js";
import { type World } from "./world.js";
import { Entity } from "./entity.js";
import { Bitset } from "../../util/bitset.js";
import { ComponentSnapshot } from "@vworlds/protocol";
import { System } from "./system.js";

const TAGS_TYPE = 1;

type TagHandlerCallback = (e: Entity) => void;

export class Tags extends Component {
  public tags = new Bitset();
  public oldTags = new Bitset();

  public override updateFromSnapshot(state: ComponentSnapshot): void {
    this.oldTags = this.tags;
    this.tags = new Bitset();
    this.tags.setIndexBitmask(0, state.uint32_a);
  }
}

export class TagHandler {
  public _create: TagHandlerCallback | undefined;
  public _remove: TagHandlerCallback | undefined;

  public onCreate(handler: TagHandlerCallback): TagHandler {
    this._create = handler;
    return this;
  }

  public onRemove(handler: TagHandlerCallback): TagHandler {
    this._remove = handler;
    return this;
  }
}

export class TagModule {
  private handlers = new Map<number, TagHandler>();
  private system: System;
  private tagMap = new Map<string, number>();
  constructor(private world: World) {
    world.registerComponent(Tags, TAGS_TYPE, "NetworkedTags");
    this.system = world
      .system("Tags")
      .onUpdate(Tags, (tags) => {
        this.handlers.forEach((h, id) => {
          const has = tags.tags.has(id);
          const oldHas = tags.oldTags.has(id);
          if (has && !oldHas) {
            h._create && h._create(tags.entity);
          } else if (!has && oldHas) {
            h._remove && h._remove(tags.entity);
          }
        });
      })
      .onExit([Tags], (e, [tags]) => {
        this.handlers.forEach((h, id) => {
          if (tags.tags.has(id)) {
            h._remove && h._remove(tags.entity);
          }
        });
      });
  }

  with(tagIdOrName: number | string): TagHandler {
    if (typeof tagIdOrName === "string") {
      const t = this.tagMap.get(tagIdOrName);
      if (!t) throw `Unregistered tag ${tagIdOrName}`;
      tagIdOrName = t;
    }
    let h = this.handlers.get(tagIdOrName);
    if (!h) {
      h = new TagHandler();
      this.handlers.set(tagIdOrName, h);
    }
    return h;
  }

  map(tagIdOrName: number | string, ComponentClasses: (typeof Component)[]) {
    this.with(tagIdOrName)
      .onCreate((e) => {
        ComponentClasses.forEach((C) => {
          e.add(C);
        });
      })
      .onRemove((e) => {
        ComponentClasses.forEach((C) => {
          e.remove(C);
        });
      });
    this.system.writes(...ComponentClasses);
    this.world["reindexSystems"]();
  }

  public createTagComponent(componentName: string) {
    class TagComponent extends Component {}
    this.world.registerComponent(TagComponent, componentName);
    return TagComponent;
  }

  public registerTag(name: string, tagId: number) {
    this.tagMap.set(name, tagId);
  }
}
