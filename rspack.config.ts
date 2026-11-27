import { defineConfig } from "@rspack/cli";
import rspack from "@rspack/core";

export default defineConfig({
    // context: __dirname,
    optimization: {
        minimizer: [],
        // 多入口（service worker / 管理页 / 内容脚本）各自独立打包，
        // 避免页面入口生成 importScripts 形式的共享 chunk
        splitChunks: false,
        moduleIds: "named",
        chunkIds: "named",
    },
    output: {
        filename: "[name].js",
        chunkFilename: "./libs/[name].bundle.js",
        chunkLoading: "import-scripts",
        chunkFormat: "array-push",
        clean: true,
    },
    mode: "development",
    target: ["es2022"],
    entry: {
        service_worker: "./src/service_worker.ts",
        dashboard: "./src/dashboard.ts",
        content: "./src/content.ts",
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
