# sokoban-solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/qaz19qpl/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/qaz19qpl/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's sokoban-solver-01-run-20261121: one program answers all 5 instances of a set in a single run, in as few pushes as possible.

## How it works

A level is a one-square-wide hallway with independent rooms off it, each holding 3 or 4 boxes and as many goals. A box pushed out of a room's door can never be pushed back, so each room is its own problem: the solver splits the level into rooms, solves every room push-optimally on its own, and the rooms' optima add up to the level's. Each room is solved with an A\* search over pushes (one push costs one, the heuristic is the cheapest assignment of the room's boxes to its goals by walking distance), pruned by dead squares and frozen 2×2 blocks. The player walks between rooms along the hallway. All budgets are counted in work, never in wall-clock time, so two runs write the same bytes.

On the kit's practice set it solves all 5 instances in exactly the push-optimal count (13, 16, 29, 47, 60 pushes) for a practice score of 1,000,000, in under half a second.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22 standard library only; `main.ts` reads `/input/<id>/level.txt` and writes `/output/<id>/solution.txt`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=mq95vk6b&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
