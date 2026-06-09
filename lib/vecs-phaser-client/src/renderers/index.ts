import type { RenderContext } from "../render_context.js";
import { installSyncSystems } from "../sync.js";

export function installRenderSystems(ctx: RenderContext): void {
  // VPH-22 adds Arc/Rectangle/Polygon/Line/Text renderers here.
  // VPH-23 adds Ellipse/Triangle/Star renderers here.
  installSyncSystems(ctx);
}
