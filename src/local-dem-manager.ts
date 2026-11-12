import AsyncCache from "./cache";
import defaultDecodeImage from "./decode-image";
import { HeightTile } from "./height-tile";
import generateIsolines from "./isolines";
import { selectFormline, isMultiple, clipLines } from "./form-lines";
import { copy, encodeIndividualOptions, isAborted, withTimeout } from "./utils";
import type {
  ContourTile,
  DecodeImageFunction,
  DemManager,
  DemManagerInitizlizationParameters,
  DemTile,
  Encoding,
  FetchResponse,
  GetTileFunction,
  IndividualContourTileOptions,
} from "./types";
import encodeVectorTile, { GeomType } from "./vtpbf";
import type { Feature } from "./vtpbf";
import { Timer } from "./performance";

const defaultGetTile: GetTileFunction = async (
  url: string,
  abortController: AbortController,
) => {
  const options: RequestInit = {
    signal: abortController.signal,
  };
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Bad response: ${response.status} for ${url}`);
  }
  return {
    data: await response.blob(),
    expires: response.headers.get("expires") || undefined,
    cacheControl: response.headers.get("cache-control") || undefined,
  };
};

/**
 * Caches, decodes, and processes raster tiles in the current thread.
 */
export class LocalDemManager implements DemManager {
  tileCache: AsyncCache<string, FetchResponse>;
  parsedCache: AsyncCache<string, DemTile>;
  contourCache: AsyncCache<string, ContourTile>;
  demUrlPattern: string;
  encoding: Encoding;
  maxzoom: number;
  timeoutMs: number;
  loaded = Promise.resolve();
  decodeImage: DecodeImageFunction;
  getTile: GetTileFunction;

  constructor(options: DemManagerInitizlizationParameters) {
    this.tileCache = new AsyncCache(options.cacheSize);
    this.parsedCache = new AsyncCache(options.cacheSize);
    this.contourCache = new AsyncCache(options.cacheSize);
    this.timeoutMs = options.timeoutMs;
    this.demUrlPattern = options.demUrlPattern;
    this.encoding = options.encoding;
    this.maxzoom = options.maxzoom;
    this.decodeImage = options.decodeImage || defaultDecodeImage;
    this.getTile = options.getTile || defaultGetTile;
  }

  fetchTile(
    z: number,
    x: number,
    y: number,
    parentAbortController: AbortController,
    timer?: Timer,
  ): Promise<FetchResponse> {
    const url = this.demUrlPattern
      .replace("{z}", z.toString())
      .replace("{x}", x.toString())
      .replace("{y}", y.toString());
    timer?.useTile(url);
    return this.tileCache.get(
      url,
      (_, childAbortController) => {
        timer?.fetchTile(url);
        const mark = timer?.marker("fetch");
        return withTimeout(
          this.timeoutMs,
          this.getTile(url, childAbortController).finally(() => mark?.()),
          childAbortController,
          `Fetching DEM tile ${url}`,
        );
      },
      parentAbortController,
    );
  }
  fetchAndParseTile = (
    z: number,
    x: number,
    y: number,
    abortController: AbortController,
    timer?: Timer,
  ): Promise<DemTile> => {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const url = this.demUrlPattern
      .replace("{z}", z.toString())
      .replace("{x}", x.toString())
      .replace("{y}", y.toString());

    timer?.useTile(url);

    return this.parsedCache.get(
      url,
      async (_, childAbortController) => {
        const response = await self.fetchTile(
          z,
          x,
          y,
          childAbortController,
          timer,
        );
        if (isAborted(childAbortController)) throw new Error("canceled");
        const promise = self.decodeImage(
          response.data,
          self.encoding,
          childAbortController,
        );
        const mark = timer?.marker("decode");
        const result = await promise;
        mark?.();
        return result;
      },
      abortController,
    );
  };

  async fetchDem(
    z: number,
    x: number,
    y: number,
    options: IndividualContourTileOptions,
    abortController: AbortController,
    timer?: Timer,
  ): Promise<HeightTile> {
    const zoom = Math.max(
      0,
      Math.min(z - (options.overzoom || 0), this.maxzoom),
    );
    const subZ = z - zoom;
    const div = 1 << subZ;
    const newX = Math.floor(x / div);
    const newY = Math.floor(y / div);

    const tile = await this.fetchAndParseTile(
      zoom,
      newX,
      newY,
      abortController,
      timer,
    );

    return HeightTile.fromRawDem(tile).split(subZ, x % div, y % div);
  }

  fetchContourTile(
    z: number,
    x: number,
    y: number,
    options: IndividualContourTileOptions,
    parentAbortController: AbortController,
    timer?: Timer,
  ): Promise<ContourTile> {
    const {
      levels,
      multiplier = 1,
      buffer = 1,
      extent = 4096,
      contourLayer = "contours",
      elevationKey = "ele",
      levelKey = "level",
      subsampleBelow = 100,
      formlines = true,
      formlineSteepness = 0.16,
      formlineAddition = 17,
      formlineMinimumGap = 30,
    } = options;

    // no levels means less than min zoom with levels specified
    if (!levels || levels.length === 0) {
      return Promise.resolve({ arrayBuffer: new ArrayBuffer(0) });
    }
    if (
      formlines &&
      (!Number.isFinite(formlineSteepness) ||
        formlineSteepness < 0 ||
        !Number.isSafeInteger(formlineAddition) ||
        formlineAddition < 0 ||
        formlineAddition > 256 ||
        !Number.isSafeInteger(formlineMinimumGap) ||
        formlineMinimumGap < 0 ||
        formlineMinimumGap > 256)
    ) {
      return Promise.reject(
        new Error(
          "Form line steepness must be non-negative; extension and gap must be integers from 0 to 256",
        ),
      );
    }
    const key = [z, x, y, encodeIndividualOptions(options)].join("/");
    const cached = this.contourCache.get(
      key,
      async (_, childAbortController) => {
        const max = 1 << z;
        const neighborPromises: (Promise<HeightTile> | undefined)[] = [];
        for (let iy = y - 1; iy <= y + 1; iy++) {
          for (let ix = x - 1; ix <= x + 1; ix++) {
            neighborPromises.push(
              iy < 0 || iy >= max
                ? undefined
                : this.fetchDem(
                    z,
                    (ix + max) % max,
                    iy,
                    options,
                    childAbortController,
                    timer,
                  ),
            );
          }
        }
        const neighbors = await Promise.all(neighborPromises);
        let virtualTile = HeightTile.combineNeighbors(neighbors);
        if (!virtualTile || isAborted(childAbortController)) {
          return { arrayBuffer: new Uint8Array().buffer };
        }
        const mark = timer?.marker("isoline");

        // Retain enough neighboring terrain to classify line points and apply
        // the configured extension and gap joining across tile boundaries.
        const halo = formlines ? Math.min(80, virtualTile.width - 2) : 2;
        if (virtualTile.width >= subsampleBelow) {
          virtualTile = virtualTile.materialize(halo);
        } else {
          while (virtualTile.width < subsampleBelow) {
            virtualTile = virtualTile
              .subsamplePixelCenters(2)
              .materialize(halo);
          }
        }

        virtualTile = virtualTile
          .averagePixelCentersToGrid()
          .scaleElevation(multiplier)
          .materialize(formlines ? halo - 1 : 1);

        const context = Math.min(
          64,
          14 + formlineAddition + formlineMinimumGap,
        );
        const generationBuffer = formlines
          ? Math.max(buffer, Math.min(halo - 2, context))
          : buffer;
        if (
          formlines &&
          (!Number.isSafeInteger(buffer) ||
            buffer < 0 ||
            generationBuffer >= halo)
        ) {
          return Promise.reject(
            new Error(
              `Contour buffer must be a non-negative integer smaller than available terrain halo (${halo})`,
            ),
          );
        }

        const isolines = generateIsolines(
          levels[0] / (formlines ? 2 : 1),
          virtualTile,
          extent,
          generationBuffer,
        );

        mark?.();
        const steepnessCache = new Map<string, number>();
        const contourFeatures: Feature[] = [];
        const formlineFeatures: Feature[] = [];
        for (const [eleString, geom] of Object.entries(isolines)) {
          const ele = Number(eleString);
          const normal = !formlines || isMultiple(ele, levels[0]);
          const selected = normal
            ? geom
            : geom.flatMap((line) =>
                selectFormline(
                  line,
                  virtualTile!,
                  extent,
                  levels[0],
                  (gridY: number) =>
                    (40075016.6856 *
                      Math.cos(
                        Math.atan(
                          Math.sinh(
                            Math.PI *
                              (1 -
                                (2 * (y + gridY / (virtualTile!.height - 1))) /
                                  (1 << z)),
                          ),
                        ),
                      )) /
                    ((1 << z) * (virtualTile!.height - 1)),
                  steepnessCache,
                  {
                    steepness: formlineSteepness,
                    addition: formlineAddition,
                    minimumGap: formlineMinimumGap,
                  },
                ),
              );
          const geometry = formlines
            ? clipLines(
                selected,
                extent,
                (buffer * extent) / (virtualTile!.width - 1),
              ).map((line) => line.map(Math.round))
            : selected;
          if (!geometry.length) continue;
          const feature: Feature = {
            type: GeomType.LINESTRING,
            geometry,
            properties: {
              [elevationKey]: ele,
              [levelKey]: Math.max(
                ...levels.map((level, index) =>
                  isMultiple(ele, level) ? index : 0,
                ),
              ),
            },
          };
          if (normal) contourFeatures.push(feature);
          else formlineFeatures.push(feature);
        }
        const result = encodeVectorTile({
          extent,
          layers: {
            [contourLayer]: {
              features: contourFeatures,
            },
            ...(formlines && formlineFeatures.length
              ? {
                  formlines: { features: formlineFeatures },
                }
              : {}),
          },
        });
        mark?.();

        return { arrayBuffer: result.slice().buffer };
      },
      parentAbortController,
    );
    // maplibre transfers the buffer to its own worker, which would detach the
    // copy held in the cache, so give each caller its own
    return cached.then(({ arrayBuffer }) => ({
      arrayBuffer: copy(arrayBuffer),
    }));
  }
}
