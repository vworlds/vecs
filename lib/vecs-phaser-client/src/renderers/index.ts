import type { RenderContext } from "../render_context.js";
import { installEllipseRenderer } from "./ellipse.js";
import { installStarRenderer } from "./star.js";
import { installTriangleRenderer } from "./triangle.js";

export function installRenderSystems(ctx: RenderContext): void {
  // VPH-22 adds Arc/Rectangle/Polygon/Line/Text renderers here.
  installEllipseRenderer(ctx);
  installTriangleRenderer(ctx);
  installStarRenderer(ctx);
  // VPH-24 adds shared transform/style sync and rotation interpolation here.
}
