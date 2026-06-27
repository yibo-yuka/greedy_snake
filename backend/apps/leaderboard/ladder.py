"""
爬梯競速 v2.1 — 自動移動競速版（含蘋果收集計分）
=======================================================
5 條軌道，20 格高，每 tick 80% 機率前進一格。
蘋果隨機散落地圖，吃越多最終排名越高（同分以先到終點者優先）。
"""
import random
import string

# ── Constants ──────────────────────────────────────────────────────────────────
NUM_COLS       = 5
NUM_ROWS       = 20
FINISH_ROW     = 0
START_ROW      = 19
TICK_INTERVAL  = 0.4
MOVE_PROB      = 0.80
MAX_PLAYERS    = 5
SELECTION_TIME = 15
APPLE_COUNT    = 10   # 地圖上同時存在的蘋果數

PLAYER_COLORS = ['#00ff88', '#ff6b6b', '#4ecdc4', '#f7dc6f', '#c084fc']

# ── 橫棧定義 (row, col_left, col_right) ────────────────────────────────────────
RUNGS: list[tuple[int, int, int]] = [
    (3,  0, 1), (5,  3, 4), (7,  1, 2), (9,  2, 3),
    (11, 0, 1), (12, 3, 4), (14, 1, 2), (15, 2, 3),
    (17, 0, 1), (18, 1, 2), (18, 3, 4),
]

RUNG_MAP: dict[tuple[int, int], int] = {}
for _row, _c1, _c2 in RUNGS:
    RUNG_MAP[(_row, _c1)] = _c2
    RUNG_MAP[(_row, _c2)] = _c1

# (col, row) positions that are rung endpoints — avoid placing apples here
# because rung traversal happens AFTER movement; the pre-teleport cell is
# never checked for apple collection.
RUNG_POSITIONS: frozenset[tuple[int, int]] = frozenset(
    (c, r) for r, c1, c2 in RUNGS for c in (c1, c2)
)


# ── Player ────────────────────────────────────────────────────────────────────
class Player:
    def __init__(self, pid: str, nickname: str, color: str, start_col: int) -> None:
        self.pid          = pid
        self.nickname     = nickname
        self.color        = color
        self.col          = start_col
        self.row          = START_ROW
        self.finished     = False
        self.finish_rank: int | None = None
        self.apples_eaten = 0

    def to_dict(self) -> dict:
        return {
            'pid':          self.pid,
            'nickname':     self.nickname,
            'color':        self.color,
            'col':          self.col,
            'row':          self.row,
            'finished':     self.finished,
            'finish_rank':  self.finish_rank,
            'apples_eaten': self.apples_eaten,
        }


# ── LadderRoom ────────────────────────────────────────────────────────────────
class LadderRoom:
    def __init__(self, room_code: str, host_id: str) -> None:
        self.room_code      = room_code
        self.host_id        = host_id
        self.lobby: dict[str, dict]     = {}
        self.players: dict[str, Player] = {}
        self.apples: list[list[int]]    = []   # [[col, row], ...]
        self.selected_cols: dict[str, int] = {}
        self.state          = 'lobby'
        self.tick_task      = None
        self.finish_counter = 0

    # ── Lobby ─────────────────────────────────────────────────────────────────
    def add_lobby_player(self, pid: str, nickname: str) -> bool:
        if len(self.lobby) >= MAX_PLAYERS:
            return False
        self.lobby[pid] = {
            'pid':      pid,
            'nickname': nickname,
            'color':    PLAYER_COLORS[len(self.lobby)],
            'is_host':  pid == self.host_id,
        }
        return True

    def remove_player(self, pid: str) -> None:
        self.lobby.pop(pid, None)
        self.players.pop(pid, None)
        self.selected_cols.pop(pid, None)

    def lobby_list(self) -> list[dict]:
        return list(self.lobby.values())

    # ── Selection ─────────────────────────────────────────────────────────────
    def select_col(self, pid: str, col: int) -> bool:
        if col not in range(NUM_COLS):
            return False
        taken = {v for k, v in self.selected_cols.items() if k != pid}
        if col in taken:
            return False
        self.selected_cols[pid] = col
        return True

    def auto_assign(self) -> None:
        used = set(self.selected_cols.values())
        available = [c for c in range(NUM_COLS) if c not in used]
        random.shuffle(available)
        for pid in self.lobby:
            if pid not in self.selected_cols and available:
                self.selected_cols[pid] = available.pop(0)

    # ── Apple management ──────────────────────────────────────────────────────
    def spawn_selection_apples(self) -> None:
        """選位開始時產生蘋果，讓玩家 15 秒內制定策略。遊戲進行中不補充。"""
        candidates = [
            (col, row)
            for col in range(NUM_COLS)
            for row in range(1, START_ROW)   # rows 1–18
            if (col, row) not in RUNG_POSITIONS
        ]
        random.shuffle(candidates)
        self.apples = [list(pos) for pos in candidates[:APPLE_COUNT]]

    # ── Build players + apples ────────────────────────────────────────────────
    def build_players(self) -> None:
        for pid, info in self.lobby.items():
            col = self.selected_cols.get(pid, 0)
            self.players[pid] = Player(pid, info['nickname'], info['color'], col)
        # Apples were already spawned at selection start; no additional spawn here.

    # ── Game tick ─────────────────────────────────────────────────────────────
    def tick(self) -> None:
        for player in self.players.values():
            if player.finished:
                continue
            if random.random() > MOVE_PROB:
                continue  # 本 tick 不動

            player.row -= 1

            # 橫棧：自動切換軌道
            key = (player.row, player.col)
            if key in RUNG_MAP:
                player.col = RUNG_MAP[key]

            # 終點判定
            if player.row <= FINISH_ROW:
                player.row = FINISH_ROW
                player.finished = True
                self.finish_counter += 1
                player.finish_rank = self.finish_counter

            # Apple collection (no respawn — apples are fixed for the whole race)
            for i, apple in enumerate(self.apples):
                if apple[0] == player.col and apple[1] == player.row:
                    player.apples_eaten += 1
                    self.apples.pop(i)   # remove permanently
                    break

        if self.all_finished():
            self.state = 'finished'

    def all_finished(self) -> bool:
        return bool(self.players) and all(p.finished for p in self.players.values())

    def game_state(self) -> dict:
        return {
            'players': [p.to_dict() for p in self.players.values()],
            'apples':  self.apples,
        }

    def results(self) -> list[dict]:
        medals = ['🥇', '🥈', '🥉', '🏅', '🏅']
        # 主排序：吃最多蘋果；同分以先到終點者優先
        ranked = sorted(
            self.players.values(),
            key=lambda p: (-p.apples_eaten, p.finish_rank or 999)
        )
        return [
            {
                'rank':         i + 1,
                'pid':          p.pid,
                'nickname':     p.nickname,
                'color':        p.color,
                'finished':     p.finished,
                'medal':        medals[i] if i < len(medals) else '🏅',
                'apples_eaten': p.apples_eaten,
            }
            for i, p in enumerate(ranked)
        ]


# ── Room Registry ──────────────────────────────────────────────────────────────
ROOMS: dict[str, LadderRoom] = {}


def make_room_code() -> str:
    while True:
        code = ''.join(random.choices(string.ascii_uppercase, k=4))
        if code not in ROOMS:
            return code
