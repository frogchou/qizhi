import { useEffect, useRef, type RefObject } from "react";
import worker from "./worker.webp";
import van from "./van.webp";
import forklift from "./forklift.webp";
import { lanes, sceneViewBox } from "./park-layout";

type Sprite = {
  route: keyof typeof lanes;
  sprite: string;
  offset: number;
  pace: number;
  width: number;
  height: number;
};
const actors: Sprite[] = [
  { route: "ring", sprite: van, offset: 0.13, pace: 20, width: 31, height: 17 },
  { route: "ring", sprite: van, offset: 0.69, pace: 17, width: 29, height: 17 },
  {
    route: "yard",
    sprite: forklift,
    offset: 0.7,
    pace: 10,
    width: 19,
    height: 13,
  },
  {
    route: "reception",
    sprite: forklift,
    offset: 0.12,
    pace: 8,
    width: 18,
    height: 12,
  },
  {
    route: "reception",
    sprite: worker,
    offset: 0.47,
    pace: 4.6,
    width: 7,
    height: 12,
  },
  {
    route: "reception",
    sprite: worker,
    offset: 0.81,
    pace: 5.2,
    width: 7,
    height: 12,
  },
  {
    route: "walk",
    sprite: worker,
    offset: 0.18,
    pace: 5,
    width: 7,
    height: 12,
  },
  {
    route: "walk",
    sprite: worker,
    offset: 0.64,
    pace: -4,
    width: 7,
    height: 12,
  },
  {
    route: "lowerWalk",
    sprite: worker,
    offset: 0.23,
    pace: 5,
    width: 8,
    height: 13,
  },
  {
    route: "lowerWalk",
    sprite: worker,
    offset: 0.73,
    pace: -4.4,
    width: 8,
    height: 13,
  },
];

function animatePark(
  svg: SVGSVGElement,
  settings: RefObject<{ active: number; speed: number }>,
) {
  const measure = svg.querySelector("path");
  if (!measure || typeof measure.getTotalLength !== "function") return;
  // Sample the authored road curves just once. No per-frame DOM layout reads.
  const paths = Object.fromEntries(
    Object.keys(lanes).map((key) => {
      const path = svg.querySelector<SVGPathElement>(`[data-route="${key}"]`)!;
      const length = path.getTotalLength(),
        n = Math.ceil(length / 3);
      const pts = Array.from({ length: n }, (_, i) =>
        path.getPointAtLength((i * length) / n),
      );
      return [key, { length, pts }];
    }),
  );
  const sprites = Array.from(svg.querySelectorAll<SVGGElement>("[data-actor]"));
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const target = (active: number) =>
    0.48 + 1.75 * (1 - Math.exp(-active / 1.6));
  let movement = 0,
    pace = target(settings.current.active),
    previous = 0,
    frame = 0;
  const draw = () => {
    actors.forEach((a, i) => {
      const { length, pts } = paths[a.route];
      const distance = (a.offset * length + movement * a.pace) % length;
      const index = (((distance + length) % length) * pts.length) / length;
      const from = pts[Math.floor(index)],
        to = pts[(Math.floor(index) + 1) % pts.length];
      const fraction = index % 1,
        dx = to.x - from.x,
        dy = to.y - from.y;
      const x = from.x + fraction * dx,
        y = from.y + fraction * dy;
      const facing = dx * a.pace < 0 ? -1 : 1;
      const pedestrian = a.sprite === worker;
      const lean = pedestrian
        ? 0
        : Math.min(
            30,
            Math.max(
              -30,
              (Math.atan2(dy * Math.sign(dx), Math.abs(dx)) * 180) / Math.PI,
            ),
          );
      const bob = pedestrian ? 0.45 * Math.sin(distance * 1.1) : 0;
      sprites[i].setAttribute(
        "transform",
        `translate(${x.toFixed(2)} ${(y + bob).toFixed(2)}) rotate(${lean.toFixed(1)}) scale(${facing} 1)`,
      );
    });
  };
  const step = (now: number) => {
    if (document.hidden || media.matches || settings.current.speed === 0)
      return;
    const dt = previous ? Math.min((now - previous) / 1000, 0.08) : 0;
    previous = now;
    const { active, speed } = settings.current;
    pace +=
      (target(active) * Math.sqrt(speed) - pace) * (1 - Math.exp(-dt / 1.65));
    movement += dt * pace;
    draw();
    frame = requestAnimationFrame(step);
  };
  const sync = () => {
    cancelAnimationFrame(frame);
    previous = 0;
    const running =
      !document.hidden && !media.matches && settings.current.speed > 0;
    svg.dataset.motion = running ? "running" : "still";
    if (running) frame = requestAnimationFrame(step);
  };
  draw();
  sync();
  media.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  svg.addEventListener("traffic-playback", sync);
  return () => {
    cancelAnimationFrame(frame);
    media.removeEventListener("change", sync);
    document.removeEventListener("visibilitychange", sync);
    svg.removeEventListener("traffic-playback", sync);
  };
}
export function Traffic({ active, speed }: { active: number; speed: number }) {
  const svg = useRef<SVGSVGElement>(null),
    settings = useRef({ active, speed });
  useEffect(() => {
    settings.current = { active, speed };
  }, [active, speed]);
  useEffect(() => {
    svg.current?.dispatchEvent(new Event("traffic-playback"));
  }, [speed]);
  useEffect(() => {
    if (svg.current) return animatePark(svg.current, settings);
  }, []);
  return (
    <svg
      ref={svg}
      className="fc-traffic"
      viewBox={sceneViewBox}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        {Object.entries(lanes).map(([key, d]) => (
          <path key={key} data-route={key} d={d} />
        ))}
      </defs>
      {actors.map((a, i) => (
        <g key={i} data-actor={a.sprite === worker ? "worker" : "vehicle"}>
          <g transform="scale(1.24)">
            <ellipse
              cy="-0.7"
              rx={a.width * 0.39}
              ry={a.height * 0.085}
              fill="#285356"
              opacity=".19"
            />
            <image
              href={a.sprite}
              x={-a.width / 2}
              y={-a.height}
              width={a.width}
              height={a.height}
            />
          </g>
        </g>
      ))}
    </svg>
  );
}
