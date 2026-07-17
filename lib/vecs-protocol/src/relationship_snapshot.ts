import { Relationship, type ComponentClass, type ComponentInstance, type EID } from "@vworlds/vecs";
import { Decoder, Encoder, tag, type WireConstructor } from "@vworlds/vecs-wire";

// Fieldless relationship subclasses still need an inherited zero-byte body.
tag(Relationship as unknown as WireConstructor);

export interface DecodedRelationshipSnapshot<C extends ComponentInstance = ComponentInstance> {
  component: C;
  targetEids: EID[];
}

/** @internal Encode relationship edges before the relationship's ordinary component fields. */
export function encodeRelationshipSnapshot(
  encoder: Encoder,
  targetEids: readonly EID[],
  component: ComponentInstance
): void {
  encoder.write_u32(targetEids.length);
  targetEids.forEach((eid) => encoder.write_u32(eid));
  encoder.write(component);
}

/** @internal Decode relationship edges and the relationship's ordinary component fields. */
export function decodeRelationshipSnapshot<C extends ComponentInstance>(
  decoder: Decoder,
  Class: ComponentClass<C>
): DecodedRelationshipSnapshot<C> {
  const targetCount = decoder.read_u32();
  if (targetCount === 0) {
    throw new Error("Relationship snapshot must contain at least one target");
  }
  const targetEids = new Array<EID>(targetCount);
  const seen = new Set<EID>();
  for (let index = 0; index < targetCount; index++) {
    const eid = decoder.read_u32();
    if (eid === 0) {
      throw new Error("Relationship snapshot target eid must be non-zero");
    }
    if (seen.has(eid)) {
      throw new Error(`Relationship snapshot contains duplicate target eid ${eid}`);
    }
    seen.add(eid);
    targetEids[index] = eid;
  }
  const component = decoder.read(Class);
  if (!decoder.EOF) {
    throw new Error("Relationship snapshot contains trailing data");
  }
  return { component, targetEids };
}
