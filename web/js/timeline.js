// Pointer capture keeps scrubbing continuous even outside the chart. Playback resumes on release.
import { clamp } from "./util.js";

export function bindTimeline(chart, S, h) {
  let pointer = null;
  const seek = (e) => {
    const r = chart.getBoundingClientRect();
    if (r.width > 0) h.seek(clamp(((e.clientX - r.left) / r.width * 360 - 30) / 320, 0, 1));
  };
  chart.addEventListener("pointerdown", (e) => {
    if (pointer != null || e.button !== 0 || !S.data) return;
    e.preventDefault();
    pointer = e.pointerId; S.scrubbing = true;
    chart.setPointerCapture(pointer); chart.focus(); seek(e);
  });
  chart.addEventListener("pointermove", (e) => { if (e.pointerId === pointer) seek(e); });
  const finish = (e) => {
    if (e.pointerId !== pointer) return;
    const id = pointer; pointer = null; S.scrubbing = false;
    if (chart.hasPointerCapture(id)) chart.releasePointerCapture(id);
  };
  chart.addEventListener("pointerup", (e) => { if (e.pointerId === pointer) seek(e); finish(e); });
  chart.addEventListener("pointercancel", finish);
  chart.addEventListener("lostpointercapture", finish);
  window.addEventListener("blur", () => { if (pointer != null) finish({ pointerId: pointer }); });
  chart.addEventListener("keydown", (e) => {
    const step = (e.shiftKey ? 60 : 10) / S.tEnd;
    const frac = S.t / S.tEnd;
    const next = { ArrowLeft: frac - step, ArrowRight: frac + step, Home: 0, End: 1 }[e.key];
    if (next == null || !S.data) return;
    e.preventDefault(); h.seek(clamp(next, 0, 1));
  });
}
