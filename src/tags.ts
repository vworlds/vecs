import { Component } from "./component.js";
import { type World } from "./world.js";
import { Entity } from "./entity.js";
import { Type } from "../types.js";
import { Bitset } from "../../util/bitset.js";
import { ComponentSnapshot } from "@vworlds/protocol";

const TAGS_TYPE = 30;

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
  constructor(private world: World) {
    world.register(Tags, TAGS_TYPE, "NetworkedTags");
    world
      .system("Tags", [Tags])
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
  with(tagId: number): TagHandler {
    let h = this.handlers.get(tagId);
    if (!h) {
      h = new TagHandler();
      this.handlers.set(tagId, h);
    }
    return h;
  }

  map(tagId: number, ComponentClasses: (typeof Component)[]) {
    this.with(tagId)
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
  }
  public createTagComponent() {
    class TagComponent extends Component {}
    this.world.register(TagComponent);
    return TagComponent;
  }
}
