/**
 * Lazy-loaded build pipeline barrel.
 *
 * Everything the playground needs only once the user actually builds
 * (Build / Build & Run / Show Assembly): the C toolchain driver, the
 * Rez preprocessor + compiler, the resource-fork splicers and the HFS
 * patcher. editor.ts pulls this in via `loadBuildPipeline()` (a dynamic
 * `import()`), so Vite emits it as a separate chunk that stays off the
 * initial page-load critical path. None of these modules have
 * import-time side effects, so deferring them is behaviour-neutral.
 */
export { preprocess } from "./preprocessor";
export { createVfs } from "./vfs";
export { compile } from "./rez";
export {
  spliceResourceFork,
  triggerDownload,
  makeRetro68DefaultSizeFork,
} from "./build";
export { mergeResourceForks } from "./resourceForkMerger.mjs";
export { compileToAsm } from "./cc1";
export { getToolchain, DEFAULT_TOOLCHAIN_ID } from "./toolchain";
export { patchEmptyVolumeWithBinary } from "./hfs-patcher";
