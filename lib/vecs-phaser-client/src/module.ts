// Re-exports — shape modules moved to src/modules/ (VPH-55)
export { VGameObject } from "./modules/types.js";
export type {
  RenderObject,
  ArcObject,
  SizeGameObject,
  StarGameObject,
  TextObject,
  VertexGameObject,
  LineObject,
  PolygonObject,
  RectangleObject,
  TriangleObject,
} from "./modules/types.js";
export { PhaserRenderModule } from "./modules/phaser_render.js";
export type { PhaserRenderModuleConfig } from "./modules/phaser_render.js";
