import { defineConfig } from "@rspack/cli";
import rspack from "@rspack/core";

export default defineConfig({
    // context: __dirname,
    optimization: {
        minimizer: [],
        splitChunks: {
            chunks: "all",
        },
        moduleIds: "named",
        chunkIds: "named",
    },
    output: {
        chunkFilename: "./libs/[name].bundle.js",
        chunkLoading: "import-scripts",
        chunkFormat: "array-push",
        clean: true,
    },
    mode: "development",
    target: ["es2022"],
    entry: {
        service_worker: "./src/service_worker.ts",
    },
    resolve: {
        extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
    },
    devtool: "source-map",
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
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: [/node_modules/],
                loader: "builtin:swc-loader",
                options: {
                    jsc: {
                        target: "es2020",
                        parser: {
                            syntax: "typescript",
                        },
                    },
                },
                type: "javascript/auto",
            },
        ],
    },
});
