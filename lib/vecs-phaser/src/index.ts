import { type ComponentClass } from "@vworlds/vecs";

export { Container, DrawIn } from "./components/container.js";
export { Alpha, Depth, Offset, Position, Rotation, Scale } from "./components/transform.js";
export { FillStyle, StrokeStyle, Tint } from "./components/style.js";
export { Image } from "./components/image.js";
export type { AssetCatalog, AssetDescriptor, SpritesheetDescriptor } from "./catalog.js";
export {
  Arc,
  Ellipse,
  Line,
  Polygon,
  Rectangle,
  Size,
  Star,
  Triangle,
} from "./components/shapes.js";
export { Text, TextAlign } from "./components/text.js";

import { Container, DrawIn } from "./components/container.js";
import { Alpha, Depth, Offset, Position, Rotation, Scale } from "./components/transform.js";
import { FillStyle, StrokeStyle, Tint } from "./components/style.js";
import { Image } from "./components/image.js";
import {
  Arc,
  Ellipse,
  Line,
  Polygon,
  Rectangle,
  Size,
  Star,
  Triangle,
} from "./components/shapes.js";
import { Text } from "./components/text.js";

/**
 * All components that participate in the network protocol, in registration order.
 * ORDER IS THE PROTOCOL — wire type id = index + 1. Do not reorder without a protocol version bump.
 *
 * Wire type ids:
 *   1  Position
 *   2  Rotation
 *   3  Scale
 *   4  Alpha
 *   5  Depth
 *   6  FillStyle
 *   7  StrokeStyle
 *   8  Arc
 *   9  Ellipse
 *  10  Rectangle
 *  11  Polygon
 *  12  Line
 *  13  Triangle
 *  14  Star
 *  15  Text
 *  16  Size
 *  17  Image
 *  18  Tint
 *  19  DrawIn
 *  20  Container
 *  21  Offset
 */
export const phaserNetworkComponents = [
  Position,
  Rotation,
  Scale,
  Alpha,
  Depth,
  FillStyle,
  StrokeStyle,
  Arc,
  Ellipse,
  Rectangle,
  Polygon,
  Line,
  Triangle,
  Star,
  Text,
  Size,
  Image,
  Tint,
  DrawIn,
  Container,
  Offset,
] as const satisfies readonly ComponentClass[];

/**
 * The subset of network components that represent renderable GameObjects — shapes,
 * images, text, and `Container`. Exactly one of these should be present on each
 * renderable entity. `Container` is exclusive with all shapes: an entity is either
 * a container (for parenting) or a direct renderable, never both.
 * Order matches phaserNetworkComponents (renderable section).
 */
export const phaserRenderableComponents = [
  Arc,
  Ellipse,
  Rectangle,
  Polygon,
  Line,
  Triangle,
  Star,
  Text,
  Image,
  Container,
] as const satisfies readonly ComponentClass[];
