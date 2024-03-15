const rspack = require('@rspack/core');
const NodePolyfill = require('@rspack/plugin-node-polyfill');
const path = require('path');
const mode = process.env.NODE_ENV ?? 'development'; // production development
const isDev = process.env.NODE_ENV === 'development';

let plugins = [];
/**
 * @type {import('@rspack/cli').Configuration}
 */
module.exports = {
  experiments: {
    rspackFuture: {
      // disableTransformByDefault: true,
      // disableApplyEntryLazily: true,
    },
  },
  // mode: mode,
  mode: 'production',
  context: __dirname,
  entry: {
    service_worker: './src/service_worker.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist/'),
    chunkFormat: 'module',
  },
  plugins: [
    new rspack.CopyRspackPlugin({
      patterns: [
        {
          from: './extension',
          to: '',
          force: true,
        },
      ],
    }),
    new rspack.DefinePlugin({
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
    }),
    new rspack.ProgressPlugin({}),
    new NodePolyfill(),
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
        loader: 'builtin:swc-loader',
        options: {
          sourceMap: true,
          jsc: {
            parser: {
              syntax: 'typescript',
            },
          },
        },
        type: 'javascript/auto',
      },
    ],
  },
};
