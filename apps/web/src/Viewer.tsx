import { useEffect, useRef, useState } from "react";
import * as T from "three";
import type { Occurrence, Vec3 } from "../../server/types";
import { bounds, evaluate, sample } from "../../server/geometry";
interface Props {
  occurrences: Occurrence[];
  selected: string[];
  onSelect: (ids: string[], append: boolean) => void;
  hidden: Set<string>;
  isolated: boolean;
  tool: string;
  fitToken: number;
  focusToken: number;
  scale: number | null;
}
export default function Viewer(p: Props) {
  const host = useRef<HTMLDivElement>(null),
    overlay = useRef<HTMLCanvasElement>(null),
    state = useRef(p);
  state.current = p;
  const api = useRef<{
    rebuild: () => void;
    highlight: () => void;
    fit: (selected?: boolean) => void;
  } | null>(null);
  const [error, setError] = useState(""),
    [measurement, setMeasurement] = useState("");
  useEffect(() => {
    api.current?.rebuild();
  }, [p.occurrences, p.hidden, p.isolated]);
  useEffect(() => {
    api.current?.highlight();
    if (p.isolated) api.current?.rebuild();
  }, [p.selected]);
  useEffect(() => {
    api.current?.fit();
  }, [p.fitToken]);
  useEffect(() => {
    api.current?.fit(true);
  }, [p.focusToken]);
  useEffect(() => {
    if (!host.current || !overlay.current) return;
    const el = host.current,
      canvas = overlay.current;
    let renderer: T.WebGLRenderer;
    try {
      renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setError("此浏览器无法启动 WebGL。对象表和确定性工具仍可使用。");
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor("#f7f9fc");
    el.prepend(renderer.domElement);
    const scene = new T.Scene(),
      camera = new T.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    let width = 1,
      height = 1,
      span = 10,
      cx = 0,
      cy = 0,
      origin: Vec3 = [0, 0, 0],
      mapping: string[] = [],
      lines: T.LineSegments | undefined,
      highlight: T.LineSegments | undefined,
      visible: Occurrence[] = [],
      resize: ResizeObserver;
    const lineMat = new T.LineBasicMaterial({ vertexColors: true }),
      highMat = new T.LineBasicMaterial({ color: "#2563eb", depthTest: false });
    const raycaster = new T.Raycaster();
    let measureStart: Vec3 | null = null,
      down: {
        x: number;
        y: number;
        wx: number;
        wy: number;
        cx: number;
        cy: number;
        button: number;
        shift: boolean;
      } | null = null;
    const context = canvas.getContext("2d")!;
    function world(x: number, y: number): Vec3 {
      return [
        cx + ((x / width - 0.5) * span * width) / height + origin[0],
        cy - (y / height - 0.5) * span + origin[1],
        0,
      ];
    }
    function screen(v: Vec3): [number, number] {
      return [
        ((v[0] - origin[0] - cx) / ((span * width) / height) + 0.5) * width,
        (0.5 - (v[1] - origin[1] - cy) / span) * height,
      ];
    }
    function render() {
      camera.left = (-span * width) / height / 2;
      camera.right = -camera.left;
      camera.top = span / 2;
      camera.bottom = -span / 2;
      camera.position.set(cx, cy, 10);
      camera.lookAt(cx, cy, 0);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      drawLabels();
    }
    function drawLabels() {
      context.clearRect(0, 0, width, height);
      let count = 0;
      for (const o of visible) {
        const g = o.geometry;
        if (g?.kind !== "text") continue;
        const px = (g.height / span) * height;
        if (px < 7 || px > 100) continue;
        const [x, y] = screen(g.position);
        if (x < -100 || x > width || y < -50 || y > height) continue;
        if (count++ > 500) break;
        context.save();
        context.translate(x, y);
        context.rotate(-g.rotation);
        context.fillStyle = state.current.selected.includes(o.occurrenceId)
          ? "#2563eb"
          : "#65748a";
        context.font = `${Math.max(8, Math.min(px, 36))}px sans-serif`;
        context.fillText(g.text.replace(/\\P/g, " "), 0, 0);
        context.restore();
      }
    }
    function geometry(objects: Occurrence[], colors: boolean) {
      const vertices: number[] = [],
        cs: number[] = [];
      const ids: string[] = [];
      for (const o of objects) {
        const g = o.geometry;
        if (!g || g.kind !== "path") continue;
        const pts = sample(g, 96);
        const color = new T.Color(
          o.color === "#000000" || o.color === "#ffffff" ? "#687b92" : o.color,
        );
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1],
            b = pts[i];
          vertices.push(
            a[0] - origin[0],
            a[1] - origin[1],
            0,
            b[0] - origin[0],
            b[1] - origin[1],
            0,
          );
          ids.push(o.occurrenceId);
          if (colors)
            cs.push(color.r, color.g, color.b, color.r, color.g, color.b);
        }
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute("position", new T.Float32BufferAttribute(vertices, 3));
      if (colors)
        geo.setAttribute("color", new T.Float32BufferAttribute(cs, 3));
      geo.computeBoundingSphere();
      return { geo, ids };
    }
    function fit(selected = false) {
      const objects = selected
        ? visible.filter((o) => state.current.selected.includes(o.occurrenceId))
        : visible;
      const boxes = objects
        .map((o) => bounds(o.geometry))
        .filter(Boolean) as number[][];
      if (!boxes.length) return;
      const minX = boxes.reduce((n, b) => Math.min(n, b[0]), Infinity),
        minY = boxes.reduce((n, b) => Math.min(n, b[1]), Infinity),
        maxX = boxes.reduce((n, b) => Math.max(n, b[2]), -Infinity),
        maxY = boxes.reduce((n, b) => Math.max(n, b[3]), -Infinity);
      cx = (minX + maxX) / 2 - origin[0];
      cy = (minY + maxY) / 2 - origin[1];
      span =
        Math.max(maxY - minY, ((maxX - minX) * height) / width, 1e-8) * 1.2;
      render();
    }
    function doHighlight() {
      if (highlight) {
        scene.remove(highlight);
        highlight.geometry.dispose();
      }
      highlight = new T.LineSegments(
        geometry(
          visible.filter((o) =>
            state.current.selected.includes(o.occurrenceId),
          ),
          false,
        ).geo,
        highMat,
      );
      highlight.renderOrder = 2;
      scene.add(highlight);
      render();
    }
    function rebuild() {
      const props = state.current;
      visible = props.occurrences.filter(
        (o) =>
          o.space === "model" &&
          o.visible &&
          !props.hidden.has(o.layer) &&
          (!props.isolated || props.selected.includes(o.occurrenceId)),
      );
      if (lines) {
        scene.remove(lines);
        lines.geometry.dispose();
      }
      const result = geometry(visible, true);
      mapping = result.ids;
      lines = new T.LineSegments(result.geo, lineMat);
      scene.add(lines);
      doHighlight();
    }
    function coords(e: PointerEvent | WheelEvent) {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function snap(x: number, y: number): Vec3 | null {
      let best = 14 * 14,
        point: Vec3 | null = null;
      for (const o of visible) {
        if (o.geometry?.kind !== "path") continue;
        for (const seg of o.geometry.segments)
          for (const v of [evaluate(seg, 0), evaluate(seg, 1)]) {
            const [sx, sy] = screen(v);
            const d = (sx - x) ** 2 + (sy - y) ** 2;
            if (d < best) {
              best = d;
              point = v;
            }
          }
      }
      return point;
    }
    function pointerDown(e: PointerEvent) {
      const { x, y } = coords(e),
        w = world(x, y);
      down = {
        x,
        y,
        wx: w[0],
        wy: w[1],
        cx,
        cy,
        button: e.button,
        shift: e.shiftKey,
      };
      el.setPointerCapture(e.pointerId);
    }
    function pointerMove(e: PointerEvent) {
      if (!down) return;
      const { x, y } = coords(e);
      if (
        state.current.tool === "pan" ||
        down.button === 1 ||
        down.button === 2
      ) {
        cx = down.cx - ((x - down.x) / height) * span;
        cy = down.cy + ((y - down.y) / height) * span;
        render();
      } else if (Math.hypot(x - down.x, y - down.y) > 4) {
        drawLabels();
        context.strokeStyle = "#2563eb";
        context.fillStyle = "#2563eb15";
        context.fillRect(down.x, down.y, x - down.x, y - down.y);
        context.strokeRect(down.x, down.y, x - down.x, y - down.y);
      }
    }
    function pointerUp(e: PointerEvent) {
      if (!down) return;
      const start = down;
      down = null;
      const { x, y } = coords(e);
      if (state.current.tool === "pan" || start.button !== 0) return;
      if (state.current.tool === "measure") {
        const pt = snap(x, y);
        if (!pt) {
          setMeasurement("请点击源几何端点（14px 捕捉范围）");
          return;
        }
        if (!measureStart) {
          measureStart = pt;
          setMeasurement("已捕捉起点，请选择终点");
        } else {
          const d = Math.hypot(...pt.map((n, i) => n - measureStart![i]));
          setMeasurement(
            state.current.scale
              ? `${(d * state.current.scale).toPrecision(8)} m · 源几何端点间距`
              : `${d.toPrecision(8)} 源单位 · 单位待确认`,
          );
          measureStart = null;
        }
        return;
      }
      if (Math.hypot(x - start.x, y - start.y) > 6) {
        const a = world(start.x, start.y),
          b = world(x, y);
        const minX = Math.min(a[0], b[0]),
          maxX = Math.max(a[0], b[0]),
          minY = Math.min(a[1], b[1]),
          maxY = Math.max(a[1], b[1]);
        const ids = visible
          .filter((o) => {
            const box = bounds(o.geometry);
            return (
              box &&
              box[0] >= minX &&
              box[2] <= maxX &&
              box[1] >= minY &&
              box[3] <= maxY
            );
          })
          .map((o) => o.occurrenceId);
        state.current.onSelect(ids, start.shift);
        render();
        return;
      }
      raycaster.params.Line = { threshold: (span / height) * 7 };
      raycaster.setFromCamera(
        new T.Vector2((x / width) * 2 - 1, (-y / height) * 2 + 1),
        camera,
      );
      const hit = lines ? raycaster.intersectObject(lines)[0] : null;
      let selected = hit
        ? mapping[Math.floor((hit.index ?? 0) / 2)]
        : undefined;
      if (!selected) {
        selected = visible.find((o) => {
          if (o.geometry?.kind !== "text") return false;
          const [sx, sy] = screen(o.geometry.position);
          return Math.hypot(sx - x, sy - y) < 14;
        })?.occurrenceId;
      }
      state.current.onSelect(selected ? [selected] : [], start.shift);
    }
    function wheel(e: WheelEvent) {
      e.preventDefault();
      const { x, y } = coords(e),
        before = world(x, y);
      span *= Math.exp(e.deltaY * 0.001);
      span = Math.max(1e-9, Math.min(span, 1e15));
      const after = world(x, y);
      cx += before[0] - after[0];
      cy += before[1] - after[1];
      render();
    }
    function size() {
      width = el.clientWidth;
      height = el.clientHeight;
      renderer.setSize(width, height);
      canvas.width = width * devicePixelRatio;
      canvas.height = height * devicePixelRatio;
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
      context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      render();
    }
    const first = state.current.occurrences.find((o) => o.geometry);
    if (first) {
      const b = bounds(first.geometry);
      if (b) origin = [b[0], b[1], 0];
    }
    api.current = { rebuild, highlight: doHighlight, fit };
    rebuild();
    resize = new ResizeObserver(size);
    resize.observe(el);
    size();
    fit();
    const contextmenu = (e: Event) => e.preventDefault();
    el.addEventListener("pointerdown", pointerDown);
    el.addEventListener("pointermove", pointerMove);
    el.addEventListener("pointerup", pointerUp);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("contextmenu", contextmenu);
    return () => {
      api.current = null;
      resize.disconnect();
      el.removeEventListener("pointerdown", pointerDown);
      el.removeEventListener("pointermove", pointerMove);
      el.removeEventListener("pointerup", pointerUp);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("contextmenu", contextmenu);
      lines?.geometry.dispose();
      highlight?.geometry.dispose();
      lineMat.dispose();
      highMat.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [p.occurrences]);
  return (
    <div
      className={`viewer tool-${p.tool}`}
      ref={host}
      data-testid="cad-viewer"
    >
      <canvas className="text-overlay" ref={overlay} />
      {error && <div className="viewer-error">{error}</div>}
      <div className="viewer-corner">
        WCS / 二维模型空间
        <br />
        <span>滚轮缩放 · 右键平移 · 拖动框选 · Shift 追加</span>
      </div>
      {measurement && <div className="measurement">{measurement}</div>}
      <div className="axis">
        <b>Y</b>
        <i />X
      </div>
    </div>
  );
}
