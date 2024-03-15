// import NodePolyfill from "@rspack/plugin-node-polyfill";
// import path from 'path';
const mode = process.env.NODE_ENV ?? "development"; // production development
// const isDev = process.env.NODE_ENV === "development";
// import { Configuration } from "@rspack/cli";
const rspack = require("@rspack/core");

/** @type {import('@rspack/cli').Configuration} */
const config = {
  experiments: {
    // outputModule: true,
    newSplitChunks: true,
    rspackFuture: {
      newTreeshaking: true,
      disableApplyEntryLazily: true,
    },
  },
  optimization: {
    splitChunks: true,
    splitChunks: {
      chunks: "all",
    },
    minimize: true,
    moduleIds: "named",
    chunkIds: "named",
  },
  mode: mode,
  // mode: "production",
  target: ["webworker", "es2020"],
  context: __dirname,
  entry: {
    service_worker: "./src/service_worker.ts",
  },
  output: {
    path: "dist",
    chunkFilename: "./libs/[name].bundle.js",
    chunkLoading: "import-scripts",
    chunkFormat: "array-push",
    clean: true,
  },
  externals: {},
  plugins: [
    new rspack.CopyRspackPlugin({
      patterns: [
        {
          from: "./extension",
          to: "",
          force: true,
        },
      ],
    }),
    new rspack.ProgressPlugin({}),
    // new NodePolyfill(),
  ].filter(Boolean),
  watch: true,
  watchOptions: {
    ignored: /node_modules/,
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: [/node_modules/],
        loader: "builtin:swc-loader",
        options: {
          sourceMap: true,
          jsc: {
            parser: {
              syntax: "typescript",
              preserveAllComments: true,
            },
            target: "es2020",
          },
        },
        type: "javascript/auto",
        // env: {
        //   targets: ['chrome >= 87', 'edge >= 88', 'firefox >= 78'],
        // },
      },
    ],
  },
};

module.exports = config;
