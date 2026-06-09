import type { RenderContext } from "../render_context.js";
import { installSyncSystems } from "../sync.js";
import { installArcRenderer } from "./arc.js";
import { installEllipseRenderer } from "./ellipse.js";
import { installLineRenderer } from "./line.js";
import { installPolygonRenderer } from "./polygon.js";
import { installRectangleRenderer } from "./rectangle.js";
import { installStarRenderer } from "./star.js";
import { installTextRenderer } from "./text.js";
import { installTriangleRenderer } from "./triangle.js";

export function installRenderSystems(ctx: RenderContext): void {
  installArcRenderer(ctx);
  installEllipseRenderer(ctx);
  installLineRenderer(ctx);
  installPolygonRenderer(ctx);
  installRectangleRenderer(ctx);
  installStarRenderer(ctx);
  installTextRenderer(ctx);
  installTriangleRenderer(ctx);
  installSyncSystems(ctx);
}
