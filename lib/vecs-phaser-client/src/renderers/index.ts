import type { RenderContext } from "../render_context.js";
import { installArcRenderer } from "./arc.js";
import { installLineRenderer } from "./line.js";
import { installPolygonRenderer } from "./polygon.js";
import { installRectangleRenderer } from "./rectangle.js";
import { installTextRenderer } from "./text.js";

export function installRenderSystems(ctx: RenderContext): void {
  installArcRenderer(ctx);
  installRectangleRenderer(ctx);
  installPolygonRenderer(ctx);
  installLineRenderer(ctx);
  installTextRenderer(ctx);

  // VPH-23 adds Ellipse/Triangle/Star renderers here.
  // VPH-24 adds shared transform/style sync and rotation interpolation here.
}
