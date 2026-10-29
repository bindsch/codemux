import { describe, expect, test } from "bun:test";
import { codexContentItems } from "../src/experiment-codex-content.js";

describe("Codex MCP content conversion", () => {
  test("preserves text bytes and inlines supported media with Codex's default image detail", () => {
    expect(codexContentItems([
      { type: "text", text: "first\n", annotations: { priority: 1 } },
      { type: "image", data: "YWJj", mimeType: "image/png" },
      { type: "image", data: "data:image/jpeg;base64,eA==", mime_type: "ignored" },
      { type: "audio", data: "eA==", mime_type: "audio/wav" },
      { type: "audio", data: "data:audio/mpeg;base64,eA==" },
    ])).toEqual([
      { type: "input_text", text: "first\n" },
      { type: "input_image", image_url: "data:image/png;base64,YWJj", detail: "high" },
      { type: "input_image", image_url: "data:image/jpeg;base64,eA==", detail: "high" },
      { type: "input_audio", audio_url: "data:audio/wav;base64,eA==" },
      { type: "input_audio", audio_url: "data:audio/mpeg;base64,eA==" },
    ]);
  });
  test("matches content metadata and missing MIME defaults", () => {
    expect(codexContentItems([
      { type: "text", text: "sealed", _meta: { "codex/encryptedContent": true } },
      { type: "image", data: "eA==", _meta: { "codex/imageDetail": "low" } },
      { type: "image", data: "eA==", _meta: { "codex/imageDetail": "invalid" } },
    ])).toEqual([
      { type: "encrypted_content", encrypted_content: "sealed" },
      { type: "input_image", image_url: "data:application/octet-stream;base64,eA==", detail: "low" },
      { type: "input_image", image_url: "data:application/octet-stream;base64,eA==", detail: "high" },
    ]);
  });
  test("serializes unsupported blocks and malformed recognized blocks as text", () => {
    expect(codexContentItems([{ type: "resource", resource: { uri: "test:a" } },
      { type: "text", text: 42 }, { type: "image", data: "eA==", mimeType: 42 }])).toEqual([
      { type: "input_text", text: '{"type":"resource","resource":{"uri":"test:a"}}' },
      { type: "input_text", text: '{"type":"text","text":42}' },
      { type: "input_text", text: '{"type":"image","data":"eA==","mimeType":42}' },
    ]);
  });
});
