const JAVASCRIPT_CHUNK = /\.m?js$/u;

interface WebpackApi {
  BannerPlugin: new (options: {
    banner: string;
    raw: boolean;
    stage: number;
    test: RegExp;
  }) => unknown;
  Compilation: { PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE: number };
}

/** Compile loaded browser code in the background before its first invocation. */
export function browserCompileHints({
  dev,
  isServer,
  webpack,
}: {
  dev: boolean;
  isServer: boolean;
  webpack: WebpackApi;
}) {
  if (dev || isServer) {
    return [];
  }
  return [
    new webpack.BannerPlugin({
      banner: "//# allFunctionsCalledOnLoad",
      raw: true,
      // After minification, before source maps and real content hashes.
      stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE + 1,
      test: JAVASCRIPT_CHUNK,
    }),
  ];
}
