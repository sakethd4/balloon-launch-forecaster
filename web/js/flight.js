// The flight on the globe: the forecast path coloured by height, a moving dot for every possible flight (clickable),
// the landing points and 50% / 90% rings, and the path of whichever flight the user selected.
import { bracket, clamp } from "./util.js";

const C = window.Cesium;
const RAMP = ["#256abf", "#3987e5", "#6da7ec", "#9ec5f4", "#cde2fb"].map((h) => C.Color.fromCssColorString(h));
const ORANGE = C.Color.fromCssColorString("#ff8a4c");
const cart = (lat, lon, alt) => C.Cartesian3.fromDegrees(lon, lat, alt);

function rampColor(frac, alpha = 1) {
  const x = clamp(frac, 0, 1) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(x));
  return C.Color.lerp(RAMP[i], RAMP[i + 1], x - i, new C.Color()).withAlpha(alpha);
}
function circle(lat0, lon0, rKm, alt = 20, n = 140) {
  const pts = [], k = 111.195, cos = Math.cos(lat0 * Math.PI / 180);
  for (let j = 0; j <= n; j++) {
    const a = (j / n) * 2 * Math.PI;
    pts.push(cart(lat0 + rKm * Math.cos(a) / k, lon0 + rKm * Math.sin(a) / (k * cos), alt));
  }
  return pts;
}

export class Flight {
  constructor(earth, data) {
    this.earth = earth; this.data = data;
    const { viewer, scene } = earth, d = data, m = d.meta;
    this.times = d.t_s; this.alt = d.alt_m; this.tEnd = d.t_s.at(-1);
    this.nom = d.t_s.map((_, i) => cart(d.nominal.lat[i], d.nominal.lon[i], d.alt_m[i]));
    this.ens = d.ensemble.lat.map((la, k) => la.map((lat, i) => cart(lat, d.ensemble.lon[k][i], d.alt_m[i])));
    this.objs = []; this.ents = [];
    const prim = (p) => { scene.primitives.add(p); this.objs.push(p); return p; };
    const ent = (e) => { const x = viewer.entities.add(e); this.ents.push(x); return x; };

    // forecast path, coloured by height, over a dark underlay
    const n = this.nom.length;
    this.underlay = prim(new C.Primitive({ geometryInstances: new C.GeometryInstance({ geometry: new C.PolylineGeometry({ positions: this.nom, width: 5,
      vertexFormat: C.PolylineColorAppearance.VERTEX_FORMAT, colors: new Array(n).fill(C.Color.BLACK.withAlpha(0.25)), colorsPerVertex: true }) }),
    appearance: new C.PolylineColorAppearance({ translucent: true }), asynchronous: false }));
    this.pathPrim = prim(new C.Primitive({ geometryInstances: new C.GeometryInstance({ geometry: new C.PolylineGeometry({ positions: this.nom, width: 3,
      vertexFormat: C.PolylineColorAppearance.VERTEX_FORMAT, colors: d.alt_m.map((a) => rampColor(a / 13716, 0.9)), colorsPerVertex: true }) }),
    appearance: new C.PolylineColorAppearance({ translucent: true }), asynchronous: false }));

    // one moving dot per possible flight, and where each one lands
    this.dots = prim(new C.PointPrimitiveCollection());
    this.ends = [];
    this.ens.forEach((_, k) => {
      this.dots.add({ id: { kind: "dot", i: k }, position: this.ens[k][0], pixelSize: 5, color: C.Color.fromCssColorString("#ff796b").withAlpha(1),
        outlineColor: C.Color.fromCssColorString("#271d24").withAlpha(0.8), outlineWidth: 1, disableDepthTestDistance: 0,
        scaleByDistance: new C.NearFarScalar(2e3, 1, 4e5, 0.35) });
      const e = d.endpoints[k];
      // Entity points support terrain clamping; PointPrimitive ignores heightReference.
      const marker = ent({ position: cart(e[0], e[1], 0), point: { pixelSize: 8, color: ORANGE.withAlpha(0.92),
        outlineColor: C.Color.BLACK.withAlpha(0.45), outlineWidth: 1.5, heightReference: C.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new C.NearFarScalar(2e3, 1.6, 4e5, 0.75) } });
      marker.kind = "end"; marker.i = k; this.ends.push(marker);
    });
    // rings around the forecast landing
    const [elat, elon] = [d.nominal.lat.at(-1), d.nominal.lon.at(-1)];
    this.rings = [
      ent({ polyline: { positions: circle(elat, elon, m.r50_km), width: 2.5, clampToGround: true, material: C.Color.WHITE.withAlpha(0.95) } }),
      ent({ polyline: { positions: circle(elat, elon, m.r90_km), width: 2.5, clampToGround: true,
        material: new C.PolylineDashMaterialProperty({ color: C.Color.WHITE.withAlpha(0.95), dashLength: 16 }) } }),
      ent({ position: cart(elat, elon, 0), ellipse: { semiMajorAxis: m.r90_km * 1000, semiMinorAxis: m.r90_km * 1000, material: ORANGE.withAlpha(0.10),
        classificationType: C.ClassificationType.TERRAIN } }),
      ent({ position: cart(elat, elon, 0), point: { pixelSize: 11, color: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 2,
        heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: "Forecast landing", font: "600 12px Inter, system-ui, sans-serif", fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3,
        style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -20), verticalOrigin: C.VerticalOrigin.BOTTOM,
        heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY } }),
    ];
    this.launchEnt = ent({ position: cart(m.launch.lat, m.launch.lon, 0), point: { pixelSize: 11, color: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 2,
      heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    label: { text: "Launch", font: "600 12px Inter, system-ui, sans-serif", fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3,
      style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(14, 6), horizontalOrigin: C.HorizontalOrigin.LEFT,
      heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY } });

    // path of the selected flight, and a ring on its landing
    this.selPositions = [];
    this.selEnt = ent({ polyline: { positions: new C.CallbackProperty(() => this.selPositions, false), width: 3.5,
      material: C.Color.fromCssColorString("#ffd27a") }, show: false });
    this.selRing = ent({ position: new C.CallbackProperty(() => this.selEnd || C.Cartesian3.ZERO, false), point: { pixelSize: 17, color: C.Color.TRANSPARENT,
      outlineColor: C.Color.fromCssColorString("#ffd27a"), outlineWidth: 3, heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY }, show: false });
    // trail of the followed balloon
    this.trailPositions = [];
    this.trail = ent({ polyline: { positions: new C.CallbackProperty(() => this.trailPositions, false), width: 4,
      material: C.Color.fromCssColorString("#9fd2ff") } });
  }

  /** ECEF position of balloon `who` (-1 = the forecast balloon, k >= 0 = possible flight k) at flight time t. */
  position(who, t, out = new C.Cartesian3()) {
    const [i, f] = bracket(this.times, t), arr = who >= 0 && this.ens[who] ? this.ens[who] : this.nom;
    return C.Cartesian3.lerp(arr[i], arr[i + 1], f, out);
  }
  altitude(t) { const [i, f] = bracket(this.times, t); return this.alt[i] + (this.alt[i + 1] - this.alt[i]) * f; }
  latLon(who, t) {
    const [i, f] = bracket(this.times, t), a = who >= 0 && this.ens[who] ? { lat: this.data.ensemble.lat[who], lon: this.data.ensemble.lon[who] } : this.data.nominal;
    return [a.lat[i] + (a.lat[i + 1] - a.lat[i]) * f, a.lon[i] + (a.lon[i + 1] - a.lon[i]) * f];
  }

  /** Move the dots and the trail to flight time t. `follow` is which balloon gets the trail. */
  update(t, follow) {
    if (this._lastT === t && this._lastFollow === follow) return;
    this._lastT = t; this._lastFollow = follow;
    // A followed flight keeps its complete projected route even after the detail card closes.
    const route = this.selected ?? (follow >= 0 ? follow : null);
    this.selPositions = route != null ? this.ens[route] : [];
    this.selEnt.show = !this.vis?.hidden && route != null;
    const [i, f] = bracket(this.times, t), tmp = this._tmp || (this._tmp = new C.Cartesian3());
    for (let k = 0; k < this.ens.length; k++) this.dots.get(k).position = C.Cartesian3.lerp(this.ens[k][i], this.ens[k][i + 1], f, tmp);
    const arr = follow >= 0 && this.ens[follow] ? this.ens[follow] : this.nom;
    this.trailPositions = arr.slice(0, i + 1).concat([this.position(follow, t)]);
  }

  select(k) {
    this.selected = k; this._lastT = undefined;
    if (k == null) { this.selEnt.show = !this.vis?.hidden && this._lastFollow >= 0; this.selRing.show = false; return; }
    const hidden = this.vis?.hidden;
    this.selPositions = this.ens[k].slice();
    const e = this.data.endpoints[k];
    this.selEnd = cart(e[0], e[1], 8);
    this.selEnt.show = !hidden; this.selRing.show = !hidden;
  }

  /** Layer switches (dots, rings) and whether the balloon cam is active (it hides everything drawn on the map). */
  setVisible({ dots, rings, hidden }) {
    const v = this.vis = { dots: dots ?? this.vis?.dots ?? true, rings: rings ?? this.vis?.rings ?? true, hidden: hidden ?? this.vis?.hidden ?? false };
    const on = !v.hidden;
    this.pathPrim.show = on; this.underlay.show = on; this.dots.show = on && v.dots; this.ends.forEach((e) => { e.show = on && v.dots; });
    this.rings.forEach((r) => { r.show = on && v.rings; });
    this.launchEnt.show = on; this.trail.show = on;
    this.selEnt.show = on && (this.selected != null || this._lastFollow >= 0); this.selRing.show = on && this.selected != null;
  }

  destroy() {
    const { viewer, scene } = this.earth;
    this.objs.forEach((p) => scene.primitives.remove(p)); this.ents.forEach((e) => viewer.entities.remove(e));
  }
}
