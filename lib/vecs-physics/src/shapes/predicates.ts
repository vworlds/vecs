import { Body } from "../body/components.js";
import { Chain, SingleShape } from "./components.js";

export const singleShapeWithBodyParent = { all: [SingleShape, { parent: Body }] } as const;
export const chainWithBodyParent = { all: [Chain, { parent: Body }] } as const;
