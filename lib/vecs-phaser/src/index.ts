import { type ComponentClass } from "@vworlds/vecs";

export { Container, DrawBy, DrawIn } from "./components/parenting.js";
export { Flip, Hidden } from "./components/display.js";
export {
  Alpha,
  Depth,
  Offset,
  Origin,
  Position,
  Rotation,
  Scale,
  ScreenAnchor,
} from "./components/transform.js";
export { FillStyle, StrokeStyle, Tint } from "./components/style.js";
export { Image } from "./components/image.js";
export type { AssetCatalog, AssetDescriptor, SpritesheetDescriptor } from "./catalog.js";
export { actionMask, hasAction } from "./input.js";
export type { InputPayload } from "./input.js";
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

import { Container, DrawBy, DrawIn } from "./components/parenting.js";
import { Flip, Hidden } from "./components/display.js";
import {
  Alpha,
  Depth,
  Offset,
  Origin,
  Position,
  Rotation,
  Scale,
  ScreenAnchor,
} from "./components/transform.js";
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
 *  22  DrawBy
 *  23  Hidden
 *  24  Flip
 *  25  Origin
 *  26  ScreenAnchor
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
  DrawBy,
  Hidden,
  Flip,
  Origin,
  ScreenAnchor,
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
