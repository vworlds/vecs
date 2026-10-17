import { z } from "zod";

const segment = z
  .string()
  .min(1)
  .refine((value) => !value.includes("/"));
const node = z.object({ name: segment, nodeId: z.string().min(1) }).passthrough();
const error = z.object({ code: z.string(), message: z.string(), hops: z.array(z.string()) });

/** @internal Validate every inbound JSON frame before the state machine sees it. */
export const frameSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("ping") }).strict(),
    z.object({ type: z.literal("pong") }).strict(),
    z
      .object({
        type: z.literal("hello"),
        protocol: z.literal(1),
        role: z.enum(["join", "mount"]),
        name: segment,
        nodeId: z.string().min(1),
        token: z.string().optional(),
      })
      .strict(),
    z.object({ type: z.literal("welcome"), name: segment, nodeId: z.string().min(1) }).strict(),
    z.object({ type: z.literal("reject"), reason: z.string() }).strict(),
    z
      .object({
        type: z.literal("advertise"),
        node,
        targets: z.array(
          z
            .object({
              path: z.string().min(1),
              kind: z.string(),
              world: z.record(z.unknown()).optional(),
              client: z
                .object({ id: z.string(), eid: z.number(), name: z.string().optional() })
                .optional(),
              node,
              via: z.array(z.string().min(1)).min(1),
            })
            .strict()
        ),
      })
      .strict(),
    z
      .object({
        type: z.literal("request"),
        id: z.string(),
        target: z.string(),
        command: z.string(),
        params: z.record(z.unknown()),
      })
      .strict(),
    z
      .object({
        type: z.literal("response"),
        id: z.string(),
        result: z.unknown().optional(),
        error: error.optional(),
      })
      .strict(),
  ])
  .superRefine((frame, context) => {
    if (frame.type === "response" && "result" in frame === (frame.error !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Response requires exactly one result or error",
      });
    }
  });

/** @internal Validated wire frame. */
export type Frame = z.infer<typeof frameSchema>;
