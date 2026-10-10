// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  imageFilesFrom,
  imageName,
  pickImages,
  readImage,
  renderImageMarkers,
  withImageMarkers,
} from "./chatImages";

function file(name: string, type: string, size = 4): File {
  const f = new File([new Uint8Array(4)], name, { type });
  if (size !== 4) Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("pickImages", () => {
  it("accepts png, jpeg, gif and webp", () => {
    const files = ["png", "jpeg", "gif", "webp"].map((t) => file(`a.${t}`, `image/${t}`));
    expect(pickImages(files, 0)).toEqual({ accepted: files, error: null });
  });

  it("refuses other types and files over 5 MB", () => {
    const svg = file("a.svg", "image/svg+xml");
    const big = file("big.png", "image/png", MAX_IMAGE_BYTES + 1);
    const ok = file("ok.png", "image/png");
    const result = pickImages([svg, big, ok], 0);
    expect(result.accepted).toEqual([ok]);
    expect(result.error).toContain("not a PNG, JPEG, GIF or WebP");
    expect(result.error).toContain("larger than 5 MB");
  });

  it("stops at five images per message", () => {
    const files = [1, 2, 3].map((n) => file(`${n}.png`, "image/png"));
    const result = pickImages(files, 3);
    expect(result.accepted).toHaveLength(2);
    expect(result.error).toBe("At most 5 images can go with one message.");
  });
});

describe("markers", () => {
  it("adds one text marker per image so the transcript stays text", () => {
    expect(withImageMarkers("Why is this red?", [{ name: "screenshot.png" }])).toBe(
      "Why is this red?\n\n[image: screenshot.png]",
    );
    expect(withImageMarkers("", [{ name: "a.png" }, { name: "b.gif" }])).toBe(
      "[image: a.png]\n[image: b.gif]",
    );
    expect(withImageMarkers("plain", [])).toBe("plain");
  });

  it("shows markers as a placeholder in the user bubble", () => {
    expect(renderImageMarkers("Look\n\n[image: a.png]")).toBe("Look\n\n🖼 a\\.png\n");
    expect(renderImageMarkers("[image: my_shot*1.png]")).toBe("🖼 my\\_shot\\*1\\.png\n");
    expect(renderImageMarkers("inline [image: a.png] stays")).toBe("inline [image: a.png] stays");
  });
});

describe("files", () => {
  it("names clipboard screenshots and keeps real file names", () => {
    expect(imageName(file("image.png", "image/png"))).toBe("screenshot.png");
    expect(imageName(file("", "image/jpeg"))).toBe("screenshot.jpg");
    expect(imageName(file("bug.webp", "image/webp"))).toBe("bug.webp");
  });

  it("takes only image files from a paste", () => {
    const png = file("a.png", "image/png");
    const txt = file("a.txt", "text/plain");
    const data = { files: [png, txt], items: [] } as unknown as DataTransfer;
    expect(imageFilesFrom(data)).toEqual([png]);
    expect(imageFilesFrom(null)).toEqual([]);
  });

  it("reads base64 without the data: prefix", async () => {
    const f = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    const { base64, dataUrl } = await readImage(f);
    expect(base64).toBe("AQID");
    expect(dataUrl).toBe("data:image/png;base64,AQID");
  });
});
