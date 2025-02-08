// import NodePolyfill from "@rspack/plugin-node-polyfill";
// import path from 'path';
const mode = process.env.NODE_ENV ?? "development"; // production development
// const isDev = process.env.NODE_ENV === "development";
// import { Configuration } from "@rspack/cli";
const rspack = require("@rspack/core");

/** @type {import('@rspack/cli').Configuration} */
const config = {
  optimization: {
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
  devtool: "source-map",
  output: {
    // path: "dist",
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
  ].filter(Boolean),
  watch: mode === "development",
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
          jsc: {
            parser: {
              syntax: "typescript",
            },
          },
        },
        type: "javascript/auto",
      },
    ],
  },
};

module.exports = config;
