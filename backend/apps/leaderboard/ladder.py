"""
Ladder Race — Server-Side Game Logic
=====================================
Map: 10 columns × 15 rows (row 0 = bottom, row 14 = top/FINISH)

Path layout:
  Row 14: [FINISH - all passable]
           ladder col 8, rows 11-14
  Row 11: corridor (all passable)
           ladder col 1, rows 8-11
  Row  8: corridor (all passable)
           ladder col 8, rows 5-8
  Row  5: corridor (all passable)
           ladder col 1, rows 2-5
  Row  2: corridor (all passable)
           ladder col 8, rows 0-2
  Row  0: [START ZONE - all passable]
"""
import random
import string
import time

# ── Constants ─────────────────────────────────────────────────────────────
GRID_COLS     = 10
GRID_ROWS     = 15
FINISH_ROW    = 14
TICK_INTERVAL = 0.15        # 150 ms
APPLE_COUNT   = 10
MAX_PLAYERS   = 4
SELECTION_TIME   = 10       # seconds for start-position selection
GAME_TIME_LIMIT  = 120      # seconds before forced settlement

PLAYER_COLORS = ['#00ff88', '#ff6b6b', '#4ecdc4', '#f7dc6f']

# ── Map Definition ────────────────────────────────────────────────────────
CORRIDOR_ROWS = [0, 2, 5, 8, 11, 14]

# (col, row_start_inclusive, row_end_inclusive)
LADDER_DEFS = [
    (8, 0,  2),
    (1, 2,  5),
    (8, 5,  8),
    (1, 8,  11),
    (8, 11, 14),
]

MAP_CELLS: set[tuple[int, int]] = set()
for _r in CORRIDOR_ROWS:
    for _c in range(GRID_COLS):
        MAP_CELLS.add((_c, _r))
for _col, _rs, _re in LADDER_DEFS:
    for _r in range(_rs, _re + 1):
        MAP_CELLS.add((_col, _r))

VALID_START_COLS: list[int] = [c for c in range(GRID_COLS) if (c, 0) in MAP_CELLS]

_DIR_DELTA: dict[str, tuple[int, int]] = {
    'up':    (0,  1),
    'down':  (0, -1),
    'left':  (-1, 0),
    'right': (1,  0),
}
_OPPOSITE: dict[str, str] = {
    'up': 'down', 'down': 'up',
    'left': 'right', 'right': 'left',
}


# ── Snake ─────────────────────────────────────────────────────────────────
class Snake:
    INIT_LEN = 3

    def __init__(self, player_id: str, nickname: str, color: str, start_col: int):
        self.player_id    = player_id
        self.nickname     = nickname
        self.color        = color
        self.body: list[list[int]] = [[start_col, 0]] * self.INIT_LEN
        self.direction    = 'right'
        self.pending      = 'right'
        self.apples_eaten = 0
        self.finished     = False
        self.finish_time: float | None = None

    def next_head(self) -> tuple[int, int]:
        dc, dr = _DIR_DELTA[self.direction]
        return (self.body[0][0] + dc, self.body[0][1] + dr)

    def move(self, grow: bool = False) -> None:
        nh = list(self.next_head())
        self.body.insert(0, nh)
        if not grow:
            self.body.pop()

    def to_dict(self) -> dict:
        return {
            'player_id':    self.player_id,
            'nickname':     self.nickname,
            'color':        self.color,
            'body':         self.body,
            'direction':    self.direction,
            'apples_eaten': self.apples_eaten,
            'finished':     self.finished,
        }


# ── Room ──────────────────────────────────────────────────────────────────
class LadderRoom:
    def __init__(self, room_code: str, host_id: str):
        self.room_code      = room_code
        self.host_id        = host_id
        self.lobby: dict[str, dict]    = {}
        self.snakes: dict[str, Snake]  = {}
        self.apples: list[list[int]]   = []
        self.selected_cols: dict[str, int] = {}
        self.state          = 'lobby'  # lobby | selecting | playing | finished
        self.start_time: float | None  = None
        self.tick_task                 = None

    # Lobby -------------------------------------------------------------------
    def add_lobby_player(self, pid: str, nickname: str) -> bool:
        if len(self.lobby) >= MAX_PLAYERS:
            return False
        idx = len(self.lobby)
        self.lobby[pid] = {
            'player_id': pid,
            'nickname':  nickname,
            'color':     PLAYER_COLORS[idx],
            'is_host':   pid == self.host_id,
        }
        return True

    def remove_player(self, pid: str) -> None:
        self.lobby.pop(pid, None)
        self.snakes.pop(pid, None)

    def lobby_list(self) -> list[dict]:
        return list(self.lobby.values())

    # Apple management --------------------------------------------------------
    def _occupied(self) -> set[tuple[int, int]]:
        cells: set[tuple[int, int]] = set()
        for s in self.snakes.values():
            for cell in s.body:
                cells.add(tuple(cell))
        for a in self.apples:
            cells.add(tuple(a))
        return cells

    def spawn_apples(self, count: int = APPLE_COUNT) -> None:
        occupied = self._occupied()
        pool = list(MAP_CELLS - occupied)
        random.shuffle(pool)
        self.apples = [list(p) for p in pool[:count]]

    def respawn_apple(self, idx: int) -> None:
        occupied = self._occupied()
        pool = list(MAP_CELLS - occupied)
        if pool:
            self.apples[idx] = list(random.choice(pool))

    def apple_at(self, pos: tuple[int, int]) -> int:
        for i, a in enumerate(self.apples):
            if tuple(a) == pos:
                return i
        return -1

    # Game helpers ------------------------------------------------------------
    def all_finished(self) -> bool:
        return bool(self.snakes) and all(s.finished for s in self.snakes.values())

    def state_dict(self) -> dict:
        return {
            'players': [s.to_dict() for s in self.snakes.values()],
            'apples':  self.apples,
        }

    def results(self) -> list[dict]:
        ranked = sorted(
            self.snakes.values(),
            key=lambda s: (-s.apples_eaten, s.finish_time or float('inf'))
        )
        return [
            {
                'rank':         i + 1,
                'player_id':    s.player_id,
                'nickname':     s.nickname,
                'color':        s.color,
                'apples_eaten': s.apples_eaten,
                'finished':     s.finished,
            }
            for i, s in enumerate(ranked)
        ]


# ── Room Registry ─────────────────────────────────────────────────────────
ROOMS: dict[str, LadderRoom] = {}


def make_room_code() -> str:
    while True:
        code = ''.join(random.choices(string.ascii_uppercase, k=4))
        if code not in ROOMS:
            return code
