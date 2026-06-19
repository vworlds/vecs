import { type as wireType } from "@vworlds/vecs-wire";

/** Textured renderable. Both fields index the asset catalog. */
export class Image {
  /** Resource id of the source texture (image or spritesheet). */
  @wireType("u32")
  public texture = 0;

  /** Frame index within a spritesheet/tileset. */
  @wireType("u16")
  public frame = 0;
}
