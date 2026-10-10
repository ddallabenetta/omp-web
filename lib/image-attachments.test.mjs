import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./image-attachments.ts");
}

const image = { type: "image", mimeType: "image/png", data: "YWJj" };

test("calculates padded base64 byte lengths and rejects invalid data", async () => {
  const { getBase64DecodedByteLength } = await loadSubject();

  assert.equal(getBase64DecodedByteLength("YQ=="), 1);
  assert.equal(getBase64DecodedByteLength("YWI="), 2);
  assert.equal(getBase64DecodedByteLength("YWJj"), 3);
  assert.equal(getBase64DecodedByteLength("not base64!"), null);
});

test("rejects invalid, oversized, and too many image attachments", async () => {
  const { MAX_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES, validateAgentImages } = await loadSubject();
  const oversizedData = "AAAA".repeat(Math.ceil((MAX_ATTACHED_IMAGE_BYTES + 1) / 3));

  assert.equal(validateAgentImages([image]), null);
  assert.match(validateAgentImages([{ ...image, mimeType: "text/plain" }]), /valid base64 image/);
  assert.match(validateAgentImages([{ ...image, data: oversizedData }]), /10MB/);
  assert.match(validateAgentImages(Array.from({ length: MAX_ATTACHED_IMAGES + 1 }, () => image)), /at most/);
});

test("rejects a message whose images are each legal but jointly over budget", async () => {
  const {
    MAX_ATTACHED_IMAGE_BYTES,
    MAX_ATTACHED_IMAGES_TOTAL_BYTES,
    validateAgentImages,
  } = await loadSubject();

  // 10 x 10MB passes the per-image check but serializes to ~133MB of base64,
  // which no transport accepts. The aggregate check is what actually holds.
  // Base64 groups of 4 carry 3 bytes, so an exact byte count needs the group
  // count rounded down, not up.
  const atPerImageLimit = "AAAA".repeat(Math.floor(MAX_ATTACHED_IMAGE_BYTES / 3));
  const withinPerImage = { ...image, data: atPerImageLimit };
  assert.equal(validateAgentImages([withinPerImage]), null);

  const overTotal = "AAAA".repeat(
    Math.ceil((MAX_ATTACHED_IMAGES_TOTAL_BYTES + 1) / 3),
  );
  const tooBig = { ...image, data: overTotal };
  assert.match(validateAgentImages([tooBig]), /10MB or smaller/);

  const acrossSeveral = Array.from(
    { length: 4 },
    () => ({ ...image, data: "AAAA".repeat(Math.ceil((MAX_ATTACHED_IMAGES_TOTAL_BYTES / 4 + 64) / 3)) }),
  );
  assert.match(validateAgentImages(acrossSeveral), /must total/);
});

test("keeps the proxy body limit above the base64 expansion of the image budget", async () => {
  const {
    MAX_ATTACHED_IMAGES_TOTAL_BYTES,
    MIN_PROXY_CLIENT_MAX_BODY_SIZE,
    getBase64WireByteLength,
  } = await loadSubject();

  const { readFileSync } = await import("node:fs");
  const config = readFileSync(
    new URL("../next.config.ts", import.meta.url),
    "utf8",
  );
  const declared = config.match(/proxyClientMaxBodySize:\s*["']?(\d+)["']?\s*(kb|mb|gb)?["']?/i);
  assert.ok(declared, "next.config.ts must declare proxyClientMaxBodySize");

  const unit = (declared[2] ?? "b").toLowerCase();
  const multiplier = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 ** 3 }[unit];
  const configured = Number(declared[1]) * multiplier;

  // A message at the aggregate budget must survive base64 expansion and still
  // reach a route handler; otherwise the documented allowance is unreachable.
  assert.ok(
    getBase64WireByteLength(MAX_ATTACHED_IMAGES_TOTAL_BYTES) < configured,
    `configured limit ${configured} must exceed the ${getBase64WireByteLength(MAX_ATTACHED_IMAGES_TOTAL_BYTES)} byte wire cost of the budget`,
  );
  assert.ok(configured <= MIN_PROXY_CLIENT_MAX_BODY_SIZE * 2);
});

test("a realistic three-photo message fits the budget that the transport allows", async () => {
  const {
    MAX_ATTACHED_IMAGES_TOTAL_BYTES,
    getBase64WireByteLength,
    validateAgentImages,
  } = await loadSubject();

  // Three ~12MP phone photos at ~2.8MB each: the exact set that was refused,
  // because 8.4MB of JPEG becomes 11.2MB of base64 on the wire.
  const phonePhoto = () => ({
    type: "image",
    mimeType: "image/jpeg",
    data: "AAAA".repeat(Math.floor((2.8 * 1024 * 1024) / 3)),
  });
  const photos = [phonePhoto(), phonePhoto(), phonePhoto()];

  // Within the server-side budget: the request is accepted and handed on.
  assert.equal(validateAgentImages(photos), null);

  // And the wire cost stays under what the proxy lets through, because the
  // base64 expansion is the reason a per-image limit alone is not enough.
  const wire = photos.reduce((total, photo) => total + getBase64WireByteLength(
    // base64 length is the quantity the transport counts
    Math.floor(photo.data.length * 3 / 4),
  ), 0);
  assert.ok(wire > 10 * 1024 * 1024, "three full-size photos exceed the old 10MB default");
  assert.ok(
    wire < 32 * 1024 * 1024,
    "and stay within the configured proxy limit once it is raised",
  );
  assert.ok(MAX_ATTACHED_IMAGES_TOTAL_BYTES >= 8.4 * 1024 * 1024);
});
