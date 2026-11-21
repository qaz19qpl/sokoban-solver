// A push-optimal Sokoban solver, written from scratch for make.fun's
// sokoban-solver-01-run-20261121.
//
// A level is a one-square-wide hallway with independent rooms off it, each
// holding 3 or 4 boxes and as many goals. A box pushed out of a room's door
// can never be pushed back, so each room is its own problem: solve every
// room push-optimally on its own and the rooms' optima add up to the
// level's. Each room is solved with an A* search over pushes (one push
// costs one, the heuristic is the cheapest assignment of the room's boxes
// to its goals by walking distance), pruned by dead squares and frozen
// 2x2 blocks. The player walks between rooms along the hallway. All
// budgets are counted in work, never in wall-clock time, and nothing is
// read from the clock or the environment, so two runs write the same
// bytes.
//
// Node 22 standard library only. Runs as `node main.ts`, reads
// /input/<id>/level.txt and writes /output/<id>/solution.txt.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

// [dx, dy, walk letter, push letter]: up, down, left, right.
const DIRS: ReadonlyArray<readonly [number, number, string, string]> = [
  [0, -1, "u", "U"],
  [0, 1, "d", "D"],
  [-1, 0, "l", "L"],
  [1, 0, "r", "R"],
];

// How many states one room search may expand, and how many it may keep,
// before it gives up and tries a greedy search instead. Work, not time.
const EXPANSION_CAP = 300_000;
const STATE_CAP = 500_000;
const GREEDY_EXPANSION_CAP = 300_000;

interface Board {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall, 0 = floor
  goals: number[];
  boxes: number[];
  player: number;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
}

interface RoomAnswer {
  pushes: number;
  moves: string;
  endPlayer: number;
}

function parseLevel(text: string): Board {
  const rows = text.split("\n").filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? "#";
      const i = y * w + x;
      if (ch === "#") continue;
      wall[i] = 0;
      if (ch === "." || ch === "*" || ch === "+") goals.push(i);
      if (ch === "$" || ch === "*") boxes.push(i);
      if (ch === "@" || ch === "+") player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// Is square i floor? Out-of-board squares count as wall.
function isFloor(b: Board, i: number): boolean {
  return i >= 0 && i < b.w * b.h && b.wall[i] === 0;
}

// The squares a box can be pushed from onto some goal, found by pulling
// boxes back from the goals over open floor, ignoring the other boxes:
// from a live square x, a box could have come from x - d when both x - d
// and x - 2d are floor. Every other square is a dead square.
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.w * b.h);
  const queue: number[] = [...b.goals];
  for (const g of b.goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * b.w + dx;
      const y = x - d;
      if (isFloor(b, y) && isFloor(b, y - d) && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Walking distances from `from` over the board's floor alone, -1 unreached.
function walkDistances(b: Board, from: number): Int32Array {
  const dist = new Int32Array(b.w * b.h).fill(-1);
  const queue: number[] = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * b.w + dx;
      if (isFloor(b, q) && dist[q] < 0) {
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

// The level's rooms: cut the hallway's dead floor (squares of the player's
// row from which no box can reach a goal) out of the floor, and each
// connected part left that holds boxes is a room. Null when the level is
// no such set of rooms.
function roomsOf(level: Board): Room[] | null {
  const live = liveSquares(level);
  const hallRow = Math.floor(level.player / level.w);
  const cut = new Uint8Array(level.w * level.h);
  for (let x = 0; x < level.w; x++) {
    const i = hallRow * level.w + x;
    if (!level.wall[i] && !live[i]) cut[i] = 1;
  }
  if (level.boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(level.w * level.h).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < level.w * level.h; s++) {
    if (level.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * level.w + dx;
        if (dx !== 0 && Math.floor(q / level.w) !== Math.floor(p / level.w)) continue;
        if (isFloor(level, q) && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of level.boxes) {
    if (part[b]! < 0) return null;
    rooms[part[b]!]!.boxes.push(b);
  }
  for (const g of level.goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// The shortest walk from `from` to `to` around walls and boxes, in lower
// LURD letters, or null when no walk exists. Directions are tried up,
// down, left, right, so ties break the same way on every run.
function walkTo(b: Board, occupied: Uint8Array, from: number, to: number): string | null {
  if (from === to) return "";
  const size = b.w * b.h;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array<string>(size);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * b.w + dx;
      if (dx !== 0 && Math.floor(q / b.w) !== Math.floor(p / b.w)) continue;
      if (!isFloor(b, q) || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = "";
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

// All orderings of 0..n-1, for the cheapest box-to-goal assignment.
function permutations(n: number): number[][] {
  if (n === 0) return [[]];
  const out: number[][] = [];
  const used = new Array<boolean>(n).fill(false);
  const cur: number[] = [];
  const rec = (): void => {
    if (cur.length === n) {
      out.push([...cur]);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}

// A push search over one board: the state is the boxes' squares and the
// player's reachable region, named by its lowest square, so the player
// standing anywhere in one region is one state. A* on pushes when
// greedy is false (optimal: the heuristic never overestimates, a push
// moves one box one square), best-first on the heuristic when greedy is
// true (any solution, for when the optimal search runs out of budget).
// Returns the pushes, the moves and where the player ends, or null.
function searchPushes(
  sub: Board,
  live: Uint8Array,
  hallRow: number,
  greedy: boolean,
  requireExit: boolean,
): RoomAnswer | null {
  const { w, wall, goals } = sub;
  const size = w * sub.h;
  const n = sub.boxes.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  if (sub.boxes.some((b) => !live[b])) return null;

  // Walking distance from each goal, for the assignment heuristic.
  const distToGoal = goals.map((g) => walkDistances(sub, g));
  const orders = n <= 4 ? permutations(n) : [];
  const heuristic = (boxes: number[]): number => {
    if (n <= 4) {
      let best = Infinity;
      for (const order of orders) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const d = distToGoal[order[i]!]![boxes[i]!]!;
          if (d < 0) {
            sum = Infinity;
            break;
          }
          sum += d;
        }
        if (sum < best) best = sum;
      }
      return best;
    }
    let sum = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (let gi = 0; gi < goals.length; gi++) {
        const d = distToGoal[gi]![b]!;
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      sum += m;
    }
    return sum;
  };

  const solved = (boxes: number[]): boolean => boxes.every((b) => goalSet[b]);

  // Flood-fill scratch: two stamp arrays, one for the state being
  // expanded, one for the regions its pushes would make.
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  // The player's reachable region from `from` with `occupied` in the
  // way: marks `seen` with a fresh stamp and returns its lowest square
  // and whether it touches the hallway row.
  const region = (
    occupied: Uint8Array,
    from: number,
    marks: Int32Array,
  ): { low: number; exit: boolean } => {
    const s = ++stamp;
    let low = from;
    let exit = false;
    let sp = 0;
    stack[sp++] = from;
    marks[from] = s;
    while (sp > 0) {
      const p = stack[--sp]!;
      if (p < low) low = p;
      if (Math.floor(p / w) === hallRow) exit = true;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (dx !== 0 && Math.floor(q / w) !== Math.floor(p / w)) continue;
        if (isFloor(sub, q) && !occupied[q] && marks[q] !== s) {
          marks[q] = s;
          stack[sp++] = q;
        }
      }
    }
    return { low, exit };
  };

  // Whether the box just pushed to `t` sits in a frozen 2x2 block of
  // walls and boxes with a box off its goal: no push can ever free it.
  const blocked = (occupied: Uint8Array, i: number): boolean =>
    i < 0 || i >= size || wall[i] === 1 || occupied[i] === 1;
  const frozenBlock = (occupied: Uint8Array, t: number): boolean => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (!blocked(occupied, a) || !blocked(occupied, b) || !blocked(occupied, c) || !blocked(occupied, d)) continue;
      if (
        (occupied[a] === 1 && !goalSet[a]) ||
        (occupied[b] === 1 && !goalSet[b]) ||
        (occupied[c] === 1 && !goalSet[c]) ||
        (occupied[d] === 1 && !goalSet[d])
      ) {
        return true;
      }
    }
    return false;
  };

  // The states, in the order found: boxes, player square, parent, the
  // push that made them, their cost in pushes, and whether the player's
  // region reaches the hallway.
  const stBoxes: number[][] = [sub.boxes.slice()];
  const stPlayer: number[] = [sub.player];
  const stParent: number[] = [-1];
  const stFrom: number[] = [-1];
  const stTo: number[] = [-1];
  const stG: number[] = [0];
  const stLow: number[] = [];
  const stExit: boolean[] = [];
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };
  const occupied = new Uint8Array(size);
  for (const b of sub.boxes) occupied[b] = 1;
  const startRegion = region(occupied, sub.player, seen);
  stLow.push(startRegion.low);
  stExit.push(startRegion.exit);
  const best = new Map<number, number>([[keyOf(sub.boxes, startRegion.low), 0]]);
  for (const b of sub.boxes) occupied[b] = 0;

  // The open list, a heap on (score, -pushes, state index): the lowest
  // score first, the deeper state first on a tie, the earlier state
  // first after that, so the order is the same on every run.
  const heap: [number, number, number][] = [];
  const heapLess = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  const h0 = heuristic(sub.boxes);
  if (h0 === Infinity) return null;
  heapPush([greedy ? h0 : h0, 0, 0]);

  const cap = greedy ? GREEDY_EXPANSION_CAP : EXPANSION_CAP;
  let expanded = 0;
  let found = -1;
  while (heap.length > 0 && expanded < cap) {
    const [, g, s] = heapPop();
    // A state pushed twice keeps the lower cost: skip the stale copy.
    if (best.get(keyOf(stBoxes[s]!, stLow[s]!)) !== g) continue;
    const boxes = stBoxes[s]!;
    if (solved(boxes) && (!requireExit || stExit[s])) {
      found = s;
      break;
    }
    expanded++;
    for (const b of boxes) occupied[b] = 1;
    region(occupied, stPlayer[s]!, seen);
    const hereStamp = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (!isFloor(sub, t) || occupied[t] || !live[t]) continue;
        if (seen[b - d] !== hereStamp) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        let key = -1;
        let next: number[] | null = null;
        let nextExit = false;
        let nextLow = -1;
        if (!frozenBlock(occupied, t)) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          const r = region(occupied, b, mark);
          nextLow = r.low;
          nextExit = r.exit;
          key = keyOf(next, nextLow);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (next === null) continue;
        const prevBest = best.get(key);
        if (prevBest !== undefined && prevBest <= g + 1) continue;
        if (stBoxes.length >= STATE_CAP) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        best.set(key, g + 1);
        const h = heuristic(next);
        if (h === Infinity) continue;
        const idx = stBoxes.length;
        stBoxes.push(next);
        stPlayer.push(b);
        stParent.push(s);
        stFrom.push(b);
        stTo.push(t);
        stG.push(g + 1);
        stLow.push(nextLow);
        stExit.push(nextExit);
        heapPush([greedy ? h : g + 1 + h, g + 1, idx]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, push.
  const path: number[] = [];
  for (let s = found; s > 0; s = stParent[s]!) path.push(s);
  path.reverse();
  let moves = "";
  let player = sub.player;
  let boxes = sub.boxes;
  for (const s of path) {
    const from = stFrom[s]!;
    const to = stTo[s]!;
    const d = to - from;
    for (const b of boxes) occupied[b] = 1;
    const walk = walkTo(sub, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    if (walk === null) return null;
    moves += walk;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    moves += dir[3];
    player = from;
    boxes = stBoxes[s]!;
  }
  return { pushes: path.length, moves, endPlayer: player };
}

// One room solved on a board of its own: the other rooms' boxes (or their
// goals, once done) stand as walls, so the player walks in from wherever
// it stands and the room's pushes are the room's optimum.
function solveRoom(
  level: Board,
  room: Room,
  rooms: Room[],
  done: Set<Room>,
  player: number,
  hallRow: number,
): RoomAnswer | null {
  const wall = level.wall.slice();
  for (const other of rooms) {
    if (other === room) continue;
    for (const b of done.has(other) ? other.goals : other.boxes) wall[b] = 1;
  }
  const sub: Board = {
    w: level.w,
    h: level.h,
    wall,
    goals: [...room.goals].sort((a, b) => a - b),
    boxes: [...room.boxes].sort((a, b) => a - b),
    player,
  };
  const live = liveSquares(sub);
  return searchPushes(sub, live, hallRow, false, false);
}

// Whether the player at `player`, with `boxes` in the way, can walk to
// the hallway row.
function canReachHall(level: Board, boxes: number[], player: number, hallRow: number): boolean {
  const occupied = new Uint8Array(level.w * level.h);
  for (const b of boxes) occupied[b] = 1;
  const queue: number[] = [player];
  const seen = new Uint8Array(level.w * level.h);
  seen[player] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (Math.floor(p / level.w) === hallRow) return true;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * level.w + dx;
      if (dx !== 0 && Math.floor(q / level.w) !== Math.floor(p / level.w)) continue;
      if (isFloor(level, q) && !occupied[q] && !seen[q]) {
        seen[q] = 1;
        queue.push(q);
      }
    }
  }
  return false;
}

// Solve one level room by room; the moves of every room joined. When the
// rooms do not cover the level, fall back to one search over the whole
// level. Returns the moves, or "" when no solution is found.
function solveLevel(level: Board): string {
  const hallRow = Math.floor(level.player / level.w);
  const rooms = roomsOf(level);
  if (rooms !== null) {
    let moves = "";
    let player = level.player;
    const done = new Set<Room>();
    for (let ri = 0; ri < rooms.length; ri++) {
      const room = rooms[ri]!;
      const answer = solveRoom(level, room, rooms, done, player, hallRow);
      if (answer === null) return "";
      // Every room but the last must leave the player able to walk out
      // to the hallway; if the optimal line strands it, search again
      // with the way out required.
      if (ri < rooms.length - 1) {
        // After the room is done its boxes stand on its goals, so the
        // squares in the way are the other rooms' boxes plus this
        // room's goals.
        const allBoxes = level.boxes
          .filter((b) => !room.boxes.includes(b))
          .concat(room.goals);
        if (!canReachHall(level, allBoxes, answer.endPlayer, hallRow)) {
          const wall = level.wall.slice();
          for (const other of rooms) {
            if (other === room) continue;
            for (const b of done.has(other) ? other.goals : other.boxes) wall[b] = 1;
          }
          const sub: Board = {
            w: level.w,
            h: level.h,
            wall,
            goals: [...room.goals].sort((a, b) => a - b),
            boxes: [...room.boxes].sort((a, b) => a - b),
            player,
          };
          const retry = searchPushes(sub, liveSquares(sub), hallRow, false, true);
          if (retry === null) return "";
          moves += retry.moves;
          player = retry.endPlayer;
          done.add(room);
          continue;
        }
      }
      moves += answer.moves;
      player = answer.endPlayer;
      done.add(room);
    }
    return moves;
  }
  // No rooms: one search over the whole level, optimal first, greedy
  // when that runs out of budget.
  const live = liveSquares(level);
  const answer =
    searchPushes(level, live, hallRow, false, false) ??
    searchPushes(level, live, hallRow, true, false);
  return answer === null ? "" : answer.moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(INPUT_DIR, id, "level.txt"), "utf8")));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, "solution.txt"), `${moves}\n`);
}
