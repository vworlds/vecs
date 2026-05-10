import { VecsClient } from "@vworlds/vecs-client";
import { World } from "@vworlds/vecs";
import { Decoder, Encoder } from "@vworlds/vecs-wire";

const POSITION_TYPE = 1;
const LOCAL_ENTITY_START = 100_000;

class Position {
  public x = 0;
  public y = 0;

  public wireEncode(encoder: Encoder): void {
    encoder.write_f32(this.x);
    encoder.write_f32(this.y);
  }

  public static wireDecode(decoder: Decoder): Position {
    const position = new Position();
    position.x = decoder.read_f32();
    position.y = decoder.read_f32();
    return position;
  }
}

const canvas = document.querySelector<HTMLCanvasElement>("#game");
if (!canvas) {
  throw new Error("Missing #game canvas");
}
const gameCanvas = canvas;

const ctx = canvas.getContext("2d");
if (!ctx) {
  throw new Error("2d canvas context unavailable");
}
const context = ctx;

const world = new World();
world.setEntityIdRange(LOCAL_ENTITY_START);
world.registerComponent(Position, POSITION_TYPE);

async function main(): Promise<void> {
  const client = await VecsClient.connectDgram({
    world,
    host: location.hostname,
    port: 3000,
    worldName: "main",
  });
  client.registerComponent(Position);
  client.installSystems();

  world
    .system("RenderNetworkedDots")
    .requires(Position)
    .each([Position], (_entity, [position]) => {
      context.beginPath();
      context.arc(position.x, position.y, 12, 0, Math.PI * 2);
      context.fillStyle = "#7dd3fc";
      context.fill();
      context.strokeStyle = "#0f172a";
      context.lineWidth = 3;
      context.stroke();
    });

  world.start();

  let last = performance.now();
  function frame(now: number): void {
    const delta = now - last;
    last = now;

    context.fillStyle = "#020617";
    context.fillRect(0, 0, gameCanvas.width, gameCanvas.height);
    context.fillStyle = "#e2e8f0";
    context.font = "16px sans-serif";
    context.fillText("vecs-client: server-authoritative dots", 20, 30);

    client.setInput({ mouseX: 0, mouseY: 0, now: Math.round(now) });
    world.progress(now, delta);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch((err: unknown) => {
  context.fillStyle = "#020617";
  context.fillRect(0, 0, gameCanvas.width, gameCanvas.height);
  context.fillStyle = "#fecaca";
  context.font = "16px sans-serif";
  context.fillText(err instanceof Error ? err.message : String(err), 20, 30);
});
