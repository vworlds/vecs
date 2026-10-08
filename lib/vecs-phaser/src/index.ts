import { type ComponentClass } from "@vworlds/vecs";

export { Container, DrawBy, DrawIn, InheritRotation } from "./components/parenting.js";
export { Alpha, Depth, Offset, Position, Rotation, Scale } from "./components/transform.js";
export { FillStyle, OpenPath, StrokeStyle, Tint } from "./components/style.js";
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
export { Motion, MotionClock } from "./components/motion.js";
export {
  MotionPose,
  MotionState,
  motionPose,
  motionStateFrom,
  stepMotion,
} from "./motion/integrator.js";

import { Container, DrawBy, DrawIn } from "./components/parenting.js";
import { Alpha, Depth, Offset, Position, Rotation, Scale } from "./components/transform.js";
import { FillStyle, OpenPath, StrokeStyle, Tint } from "./components/style.js";
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
import { Motion, MotionClock } from "./components/motion.js";

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
 *  23  OpenPath
 *
 * `InheritRotation` is deliberately not listed: it is client-local by default, and appending to this
 * list shifts the wire id of every application component listed after it. Neither are `Motion` and
 * `MotionClock`, for the same reason: applications append {@link phaserMotionComponents} instead.
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
  OpenPath,
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

/**
 * The dead-reckoning wire components, `MotionClock` then `Motion`.
 *
 * They are not in {@link phaserNetworkComponents}: that list's order is the protocol, and appending
 * to it would shift the wire id of every application component listed after it. An application that
 * uses dead reckoning appends this list to its own network components, after its existing entries,
 * on the server and the client alike.
 */
export const phaserMotionComponents = [
  MotionClock,
  Motion,
] as const satisfies readonly ComponentClass[];
