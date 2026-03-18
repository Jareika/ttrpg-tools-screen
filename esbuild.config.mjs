import esbuild from "esbuild";

const mode = process.argv[2] ?? "production";
const production = mode === "production";
const watch = mode === "watch";

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  platform: "browser",
  format: "cjs",
  target: "es2020",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  external: ["obsidian", "electron"],
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
  console.log("Watching...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}