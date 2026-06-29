import { Body } from "../body/components.js";
import { Joint, JointBodyA, JointBodyB } from "./components.js";

// A joint is live only once BOTH connected bodies exist and carry a `Body`.
// `{ target: [JointBody*, [Body]] }` is a TargetTerm that fans out reactively when
// either target gains `Body`, so joint creation is order-independent (the joint
// entity can be created before, after, or between its bodies).
export const jointWithBothBodies = {
  all: [Joint, { target: [JointBodyA, [Body]] }, { target: [JointBodyB, [Body]] }],
} as const;
