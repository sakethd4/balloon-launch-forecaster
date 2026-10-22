// Shared view policy, in metres. Geometry keeps its size; opacity alone fades with range.
import { smoothstep } from "./util.js";
export const BALLOON_DISPLAY_SCALE = 60;
export const windFade = (mode, distance) => mode === "balloon" ? 1 : 1 - smoothstep(10000, 22000, distance);
export const cloudFade = (mode, distance) => mode === "balloon" ? 1 : 1 - smoothstep(28000, 50000, distance);
