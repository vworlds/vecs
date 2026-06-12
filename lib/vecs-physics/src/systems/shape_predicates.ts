import { Body } from "../components/body.js";
import { Shape } from "../components/geometry.js";

export const shapeWithBodyParent = { all: [Shape, { parent: Body }] } as const;
