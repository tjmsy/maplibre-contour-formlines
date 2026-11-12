/** @jest-environment node */
import { clipLines, isMultiple, selectFormline } from "./form-lines";
import { HeightTile } from "./height-tile";
import { decodeOptions, encodeOptions } from "./utils";
import { LocalDemManager } from "./local-dem-manager";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader as Pbf } from "pbf";

test("form-line classification rejects steep or incomplete terrain", () => {
  const flat = new HeightTile(40, 40, () => 0);
  const steep = new HeightTile(40, 40, (x) => x * 2);
  const line = [100, 100, 120, 100, 140, 100];
  expect(selectFormline(line, flat, 200, 5, 2)).toEqual([line]);
  expect(selectFormline(line, steep, 200, 5, 2)).toEqual([]);
  const incomplete = new HeightTile(40, 40, (x, y) =>
    x < 15 || y < 15 ? NaN : 0,
  );
  expect(selectFormline(line, incomplete, 200, 5, 2)).toEqual([]);
});

test("form-line selection honors steepness, extension, and gap settings", () => {
  const mixed = new HeightTile(80, 8, (x) => (x >= 14 && x <= 18 ? 10 : 0));
  const line = Array.from({ length: 21 }, (_, i) => [i * 4 + 40, 100]).flat();
  const strict = selectFormline(line, mixed, 400, 5, 2, new Map(), {
    steepness: 0.01,
    addition: 1,
    minimumGap: 0,
  });
  const extended = selectFormline(line, mixed, 400, 5, 2, new Map(), {
    steepness: 0.2,
    addition: 5,
    minimumGap: 0,
  });
  const joined = selectFormline(line, mixed, 400, 5, 2, new Map(), {
    steepness: 0.2,
    addition: 1,
    minimumGap: 30,
  });
  expect(extended).not.toEqual(strict);
  expect(joined).not.toEqual(strict);
  expect(strict.length).toBeLessThanOrEqual(extended.length);
  expect(joined.flat().length).toBeGreaterThanOrEqual(strict.flat().length);
});

test("multiple contour elevations are identified with floating-point tolerance", () => {
  expect(isMultiple(20, 10)).toBe(true);
  expect(isMultiple(15, 10)).toBe(false);
});

test("generation context is clipped to the configured tile buffer", () => {
  expect(clipLines([[-10, 50, 50, 50, 110, 50]], 100, 5)).toEqual([
    [-5, 50, 50, 50, 105, 50],
  ]);
  expect(clipLines([[-20, 50, -10, 50]], 100, 5)).toEqual([]);
});

test("formline enable flag round-trips through the protocol URL options", () => {
  for (const formlines of [true, false]) {
    const encoded = encodeOptions({ thresholds: { 10: 5 }, formlines });
    expect(decodeOptions(encoded)).toMatchObject({ formlines });
  }
});

test("form lines use their own source layer and can be disabled", async () => {
  const tileSize = 64;
  const manager = new LocalDemManager({
    demUrlPattern: "https://dem.example/{z}/{x}/{y}.png",
    cacheSize: 100,
    encoding: "terrarium",
    maxzoom: 10,
    timeoutMs: 1000,
    getTile: async (url) => ({ data: new Blob([url]) }),
    decodeImage: async (blob) => {
      const match = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(await blob.text());
      if (!match) throw new Error("Unexpected DEM URL");
      const tileX = Number(match[2]);
      return {
        width: tileSize,
        height: tileSize,
        data: Float32Array.from(
          Array.from(
            { length: tileSize * tileSize },
            (_, index) => (tileX * tileSize + (index % tileSize)) * 0.2,
          ),
        ),
      };
    },
  });
  const enabled = await manager.fetchContourTile(
    10,
    500,
    400,
    { levels: [5], formlines: true, subsampleBelow: tileSize },
    new AbortController(),
  );
  const enabledTile = new VectorTile(new Pbf(enabled.arrayBuffer));
  expect(enabledTile.layers.contours.length).toBeGreaterThan(0);
  expect(enabledTile.layers.formlines?.length).toBeGreaterThan(0);
  expect(enabledTile.layers.formlines.feature(0).properties).not.toHaveProperty(
    "kind",
  );

  const disabled = await manager.fetchContourTile(
    10,
    500,
    400,
    { levels: [5], formlines: false, subsampleBelow: tileSize },
    new AbortController(),
  );
  const disabledTile = new VectorTile(new Pbf(disabled.arrayBuffer));
  expect(disabledTile.layers.contours.length).toBeGreaterThan(0);
  expect(disabledTile.layers.formlines).toBeUndefined();
});
