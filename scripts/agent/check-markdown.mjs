import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("");
globalThis.window = window;
globalThis.document = window.document;
globalThis.DOMPurify = (await import("dompurify")).default(window);

const filename = process.argv[2];
const text = await readFile(filename, "utf8");
const lines = text.split(/\r?\n/);
const blocks = [];
let fence = null;
let mermaidBlock = null;
let blockNumber = 0;

for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!fence) {
    if (!match) continue;
    fence = { marker: match[1][0], length: match[1].length, line: index + 1 };
    if (match[1][0] === "`" && /^\s*mermaid(?:\s|$)/i.test(match[2])) {
      blockNumber += 1;
      mermaidBlock = { number: blockNumber, line: index + 1, source: [] };
    }
  } else if (
    match &&
    match[1][0] === fence.marker &&
    match[1].length >= fence.length &&
    !match[2].trim()
  ) {
    if (mermaidBlock) blocks.push(mermaidBlock);
    fence = null;
    mermaidBlock = null;
  } else if (mermaidBlock) {
    mermaidBlock.source.push(line);
  }
}

if (fence) {
  console.error(`Unclosed code fence opened at line ${fence.line}`);
  process.exitCode = 1;
}

if (blocks.length) {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  for (const block of blocks) {
    try {
      await mermaid.parse(block.source.join("\n"));
    } catch (error) {
      const reportedLine = Number(error.hash?.loc?.first_line ?? error.line ?? 1);
      console.error(
        `Mermaid block ${block.number} (fence line ${block.line}, diagram line ${reportedLine}): ${error.message}`
      );
      process.exitCode = 1;
    }
  }
}
