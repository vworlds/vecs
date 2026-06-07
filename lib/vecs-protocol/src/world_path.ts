export function worldPath(basePath = "/rtc/v1/world", worldName: string): string {
  return `${basePath.replace(/\/$/, "")}/${encodeURIComponent(worldName)}`;
}
