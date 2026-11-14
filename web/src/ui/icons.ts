import {
  ArrowRight, BookOpen, Box, CalendarClock, Check, ChevronDown, ChevronUp, Clock, Compass, Database, Footprints,
  Home, Image, Info, Layers, Map, Minus, Pause, Play, Plus, Radiation, RotateCcw, RotateCw, Route, ScanEye,
  SkipForward, SlidersHorizontal, Square, Telescope, TriangleAlert, Video, X, createElement, type IconNode,
} from "lucide";

/** Lucide icons (ISC licence) as SVG strings, for use in HTML templates. */
function svg(node: IconNode, size = 16, stroke = 1.75): string {
  const el = createElement(node);
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("stroke-width", String(stroke));
  el.setAttribute("aria-hidden", "true");
  el.classList.add("ic");
  return el.outerHTML;
}

export const ic = {
  map: svg(Map),
  box: svg(Box),
  flight: svg(Video),
  visor: svg(ScanEye),
  book: svg(BookOpen),
  data: svg(Database),
  sliders: svg(SlidersHorizontal),
  plus: svg(Plus),
  minus: svg(Minus),
  rotL: svg(RotateCcw),
  rotR: svg(RotateCw),
  up: svg(ChevronUp),
  down: svg(ChevronDown),
  compass: svg(Compass),
  image: svg(Image, 15),
  info: svg(Info, 14),
  close: svg(X, 16),
  play: svg(Play, 15),
  pause: svg(Pause, 15),
  skip: svg(SkipForward, 15),
  stop: svg(Square, 13),
  home: svg(Home, 14),
  layers: svg(Layers, 15),
  route: svg(Route, 15),
  check: svg(Check, 13, 2.4),
  warn: svg(TriangleAlert, 14),
  rad: svg(Radiation, 15),
  clock: svg(Clock, 14),
  walk: svg(Footprints, 14),
  arrow: svg(ArrowRight, 16),
  later: svg(CalendarClock, 16),
  science: svg(Telescope, 14),
};
