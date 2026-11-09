import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { computeSignature, similarity } from "../src/search/image-signature";

/** A colored square on a white background, like a product photo. */
const product = (color: string, size = 120, canvas = 400) =>
  sharp({ create: { width: canvas, height: canvas, channels: 3, background: "#ffffff" } })
    .composite([{ input: { create: { width: size, height: size, channels: 3, background: color } }, gravity: "centre" }])
    .png()
    .toBuffer();

describe("image signature", () => {
  it("ignores the white background and scale", async () => {
    const a = await computeSignature(await product("#cc2222", 120, 400));
    const b = await computeSignature(await product("#cc2222", 260, 600));
    expect(similarity(a, b)).toBeGreaterThan(0.9);
  });
  it("ranks the same color above a different one", async () => {
    const red = await computeSignature(await product("#cc2222"));
    const darkRed = await computeSignature(await product("#b01818"));
    const blue = await computeSignature(await product("#2244cc"));
    expect(similarity(red, darkRed)).toBeGreaterThan(similarity(red, blue));
  });
  it("rejects things that aren't images", async () => {
    await expect(computeSignature(Buffer.from("not an image"))).rejects.toThrow();
  });
});
