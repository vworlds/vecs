import { Body } from "../components/body.js";
import { Chain, SingleShape } from "../components/geometry.js";

export const singleShapeWithBodyParent = { all: [SingleShape, { parent: Body }] } as const;
export const chainWithBodyParent = { all: [Chain, { parent: Body }] } as const;
